# trip-service

Owns the **ride lifecycle** and **matching** ([architecture §6](../../docs/architecture/overview.md#6-trip-lifecycle), workflows [05](../../docs/design/workflows/05-ride-booking-matching.md) · [06](../../docs/design/workflows/06-trip-execution.md) · [07](../../docs/design/workflows/07-cancellations.md) · [08](../../docs/design/workflows/08-payment-receipt-rating.md)). Only this service changes a trip's status.

```
requested → matched → en_route → in_progress → completed
     ↘──────────↘─────────↘ cancelled
```

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (PostGIS), Redis, Redpanda
pnpm install
make -C ../.. secrets                             # .env + the shared INTERNAL_SERVICE_TOKEN
pnpm prisma migrate dev                           # creates trip_service
pnpm dev                                          # http://localhost:3002
```

It works with **auth-service** (tokens), **location-service** (nearby drivers, driver state), **mapping-service** (routes, ETAs) and **realtime-gateway** (pushes). See [docs/development/README.md](../../docs/development/README.md#book-a-ride-locally) for a full local ride.

## API

All routes take an access token: app (`aud=ride-app`) or staff (`aud=ride-admin`). Every action is checked with `libs/shared-authz` (permission + scope). Trips you may not read answer `404`, never `403`, so their existence isn't revealed. POSTs that create things or move money accept an **`Idempotency-Key`** header: a retry gets the first answer, the same key with a different body gets `422`, and a duplicate still running gets `409`.

| Route | Who (permission @ scope) | What |
|---|---|---|
| `POST /api/trips/estimates` | any signed-in user | **Development stand-in** for pricing-service's estimates (`PRICING=builtin` only): `{ pickup, dropoff, vehicleTypes }` → quotes valid for 10 min |
| `POST /api/trips` | rider: `trip:create @ SELF` · call center: `trip:create_on_behalf @ CITY` (channel `PHONE`) · coordinator: `trip:create_on_behalf @ ORG` (channel `CORPORATE_PORTAL`) · corporate billing also needs `trip:bill_corporate @ ORG` | `{ quoteId, paymentMethod, riderUserId?, billingOrgId? }` → `201` trip `requested`, matching starts |
| `POST /api/trips/:id/accept` · `/decline` | the offered driver (`trip:accept @ SELF`) | `{ offerId }` |
| `POST /api/trips/:id/assign` | dispatcher (`trip:assign @ CITY`) | `{ driverId }`: manual assignment |
| `POST /api/trips/:id/en-route` · `/arrive` · `/start` · `/complete` | the assigned driver (`trip:update_status @ SELF`) | Progress. `arrive` needs the last ping within 150 m of the pickup. `start` needs `arrive` (and the rider's PIN when `TRIP_PIN_REQUIRED=true`; 5 wrong PINs lock it: `423 pin_locked`). `complete` right after the start with the car still at the pickup is refused (`409 trip_not_driven`); other short rides are flagged `SHORT_TRIP` |
| `POST /api/trips/:id/pin/reset` | rider, booker · support/dispatch (`trip:cancel @ CITY`) | New PIN, PIN check unlocked |
| `POST /api/trips/:id/cancel` | rider, assigned driver (`@ SELF`) · coordinator (`@ ORG`) · call center, dispatch, support, safety (`@ CITY`) | `{ reason }`. Fee per workflow 07 (below) |
| `POST /api/trips/:id/rating` · `GET /api/trips/:id/rating` | the trip's rider or driver | `{ stars 1–5, comment?, tags? }` (tags from `RATING_TAGS` in shared-types, ≤ 5), once each, within 7 days of completion; `GET` reads back your own |
| `GET /api/trips/me/rating` | yourself | `{ average, count }` of the ratings you received (cached 5 min). `GET /api/trips/:id/parties` shows a driver's average once they have 3 |
| `GET /api/trips/places` · `PUT /api/trips/places/home\|work` · `POST /api/trips/places` · `DELETE /api/trips/places/:id` | yourself | Saved places: one Home, one Work, others; 20 at most |
| `POST /api/trips/:id/share` · `DELETE /api/trips/:id/share` | the trip's rider or booker | A share link `{ token, url, expiresAt }` (the same one when asked again) / stop sharing. Refused (`409 trip_ended`) more than 30 min after the end |
| `GET /api/trips/shared/:token` | **no token**; 30/min per IP | The shared view: status, pickup and drop-off, the driver's first name and photo, the car, the live position (fresh, while on this trip), the road line. Unknown, revoked and expired links all answer `404` |
| `GET /api/trips/:id` | rider, booker, driver · staff of the city · billing org · the vehicle's fleet | The trip. The PIN goes to the rider's side only, review flags to staff only |
| `GET /api/trips?as=rider\|driver&before=` · `GET /api/trips/active` | yourself | Your trips (keyset pagination), your current trip |
| `GET /api/trips/board?cityId=` | `trip:read @ CITY` | Dispatcher live board: active trips |
| `GET /internal/trips/:id` | service token | Trip facts for other services |

Errors are `{ error, message }`: `409 invalid_state` (another change won the race), `driver_busy`, `driver_unavailable`, `active_trip_exists`, `too_far_from_pickup`, `quote_expired`, …

## How it works

- **One transaction per transition:** a conditional `UPDATE … WHERE status IN (allowed) AND version = v`, a `trip_event` row and an outbox row. If 0 rows are updated, someone else changed the trip first and the caller gets `409` (Database.md §9, race 2).
- **Database-enforced rules:**
  - one active trip per **driver** (`driver_active_trip` primary key);
  - one active trip per **rider** (partial unique index);
  - one open offer per trip;
  - corporate payment exactly when billing is corporate;
  - valid statuses, money and PINs (check constraints).
- **Matching** (`src/matching/matcher.ts`) offers one driver at a time:
  1. **Search:** candidates from location-service within 2 → 4 → 6 km, skipping anyone who declined, cash-blocked drivers on cash trips, and the rider.
  2. **Rank** by OSRM driving time through mapping-service, or by distance if it's down.
  3. **Reserve** the driver with `SET offer:driver:{id} NX EX 15`, and push `trip:offer`.
  4. **Wait and move on:** the offer is open for 15 s, and the loop gives up after 120 s with `NO_DRIVER_FOUND`, free of charge.
  5. **Recovery:** the loop's state lives in Redis with a lease per step, so another replica continues if one crashes.
- **Snapshot at match:** the vehicle, its owner type and the **beneficiary** (the fleet company for company cars, else the driver: Payment.md D1) are copied onto the trip when it's matched, from location-service's driver state.
- **Money:**
  - **Fare:** the quote is binding. The final fare is the quote plus paid waiting after the 3 free minutes.
  - **Rider cancels:** free within 2 min of matching, then 30 ETB (80% to the beneficiary), plus waiting after arrival. It's waived when the driver asked the rider to cancel.
  - **No-show:** 5 min after arrival, at the pickup.
  - **Driver, staff and system cancels:** free.
  - These values are per city in `src/trips/policy.ts`.
- **Pushes** go out through Socket.io's Redis emitter to room `user:{id}` (realtime-gateway joins every socket to it): `trip:offer`, `trip:offer_expired`, `trip:offer_cancelled`, `trip:status`.
- **Events** (outbox → Kafka): `trip.requested`, `trip.matched`, `trip.driver_en_route`, `trip.driver_arrived`, `trip.started`, `trip.completed` (everything payment-service needs: fare, waiting fee, payment method, beneficiary, billing), `trip.cancelled` (fee and compensation). Contracts: `libs/shared-types/src/events.ts`.
- **`trip_event`** is partitioned by month. `ensure_trip_event_partitions()` runs at start-up and daily, and a default partition catches anything else.

### Not yet

- **Quotes:** pricing-service doesn't exist, so `PRICING=builtin` (refused in production) prices with a fixed table and mapping-service routes. pricing-service must serve `GET /internal/quotes/:id` with the `Quote` shape in `src/quotes.ts`.
- **Route:** the actual distance is the planned route until GPS-trace matching (OSRM `/match` on `driver.location`) is added. No server-side ETA refresh or route-deviation alerts (the phone app refreshes the ETA from mapping-service).
- **Mid-trip:** no destination change or masked calls. Payment pre-authorisation waits for payment-service.
- **No-show:** the "contact attempt" requirement isn't checked yet (no telephony).
- **Push for backgrounded apps:** offers and status only reach open sockets. notification-service will push them from the trip events.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Hot reload |
| `pnpm test` | Unit tests: waiting and cancellation fees, config rules |
| `pnpm test:integration` | Real Postgres (`trip_service_test`) and its own Redis container (port 6394), with the real `shared-location` code: request rules, idempotency, booking on behalf, matching (ranking, declines, expiry, cash filter, timeout, OSRM down), races, execution with geofence and paid waiting, cancellation fees, ratings, read access |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | |

See `.env.example` for every variable.

## Documentation

Reference documentation for working on or integrating with this service, written from the code: [docs/README.md](docs/README.md) (architecture, API, events, data model, integrations, configuration, operations).
