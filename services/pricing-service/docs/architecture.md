# pricing-service architecture

## Layout

```
src/
├── server.ts           start: settings client, authz sync, listen; shutdown on SIGTERM/SIGINT
├── app.ts              Fastify: error handler, helmet, rate limit (300/min), /health*, routes
├── container.ts        Redis, mapping + location clients, settings client, quotes, token verifier
├── config/index.ts     env → typed config (zod)
├── http/routes.ts      estimates, fare card, internal quote lookup
├── quotes.ts           Quote type, Redis quote store, estimateWithRoute, fareCards
├── fares.ts            fareCard() from settings, price()
├── lib/mapping.ts      mapping-service client (POST /internal/route, 2.5 s)
├── lib/location.ts     location-service client (GET /internal/eta-to-pickup, 1.5 s)
├── lib/errors.ts       AppError helpers
├── middlewares/error-handler.ts
└── utils/logger.ts
```

Tests build the real app with `ContainerOptions` (`store`, `settings`, `mapping`, `location`, `verifyAccessToken`, `now`).

## Fare formula

`src/fares.ts`. All amounts are integers in santim (1 birr = 100 santim), currency `ETB`.

```
distanceMinor = round(distanceMeters / 1000 × perKmMinor)
timeMinor     = round(durationSeconds / 60 × perMinMinor)
raw           = baseMinor + distanceMinor + timeMinor
rounded       = round(raw / 100) × 100            // whole birr
fareMinor     = max(minFareMinor, rounded)
```

Breakdown returned with every quote:

| Field | Meaning |
|---|---|
| `baseMinor` | the card's base fare |
| `distanceMinor` | distance part |
| `timeMinor` | time part |
| `minimumApplied` | `true` when the minimum fare was used |
| `roundingMinor` | `rounded − raw` (negative when rounded down) |

`waitingPerMinMinor` is copied onto the quote but not used by pricing-service. Waiting charges are applied elsewhere (trip-service; not in this service's code).

Example from `tests/unit/pricing.test.ts`: card 5000 / 1500 per km / 200 per min / min 8000; 10 km, 20 min → 5000 + 15000 + 4000 = 24 000 (240 birr).

### Where the card comes from

`fareCard(settings, vehicleType, cityId)` reads five live settings with city resolution (city override → global → registry default):

| Setting | Default economy | comfort | minivan |
|---|---|---|---|
| `fares.<type>.baseMinor` | 5000 | 7000 | 9000 |
| `fares.<type>.perKmMinor` | 1500 | 2000 | 2500 |
| `fares.<type>.perMinMinor` | 200 | 300 | 350 |
| `fares.<type>.minFareMinor` | 8000 | 11000 | 14000 |
| `fares.<type>.waitingPerMinMinor` | 300 | 400 | 500 |

(Defaults from `libs/shared-settings/src/registry.ts`.) If the registry has no `fares.<type>.baseMinor` key, the card is `null`.

The settings client is created **without** service-level defaults, so if platform-service can't be reached at start, the registry defaults above apply until the first successful refresh.

## Estimates

`POST /api/pricing/estimates` → `routes.ts` → `quotes.estimateWithRoute()`.

1. **Caller:** bearer token verified as audience `ride-app`; if that fails with `invalid_token`, retried as `ride-admin`. No permission check: anyone with a valid token of either audience.
2. **Body:** pickup, drop-off, optional `vehicleTypes` (1–5 codes), optional addresses (≤ 200 characters).
3. **City:** `cityAt(pickup)` from `libs/shared-location` (static boxes for `addis-ababa`, `hawassa`). The drop-off city is not checked.
4. **Offered types** (`offered(cityId)`): from the settings snapshot's `vehicleTypes`: enabled, and `cities` empty or containing the city. If the snapshot has no vehicle types at all (platform-service never reached), the built-in `economy, comfort, minivan`.
5. **Wanted** = `vehicleTypes` from the body, or every offered type. A wanted type that is not offered → `400 vehicle_type_unavailable` (only checked when the pickup is in a city).
6. In `estimateWithRoute`: no city → `400 outside_service_area`. For each wanted type, the fare card; no card → `400 unknown_vehicle_type`.
7. **In parallel:**
   - mapping-service `POST /internal/route` with `[pickup, dropoff]` and `geometry: true`. **Any** failure (timeout, 4xx including "no route", 5xx) → `503 dependency_unavailable` ("routing is temporarily unavailable"). When OSRM is down, mapping-service itself answers `200` with a straight-line estimate marked `approximate: true`, so this 503 means mapping-service itself failed.
   - location-service ETA per vehicle type (below).
8. `ttl = quote.ttlSeconds` (global; default 600 s, bounds 60–3600). `expiresAt = now + ttl`.
9. For each type, `price(card, route)`, build the `Quote`, `SET quote:<id> <json> EX ttl`. Quotes are stored one by one; a Redis error mid-way leaves earlier quotes stored and fails the request (500).
10. Response `{ quotes, route: { polyline6, distanceMeters, durationSeconds, approximate } }`.

All quotes of one estimate share the same route, distance and duration. The route line is returned once in `route` and also stored on each quote as `routePolyline6` (omitted when mapping returned no geometry) so trip-service can keep it on the trip.

### The quote

```ts
interface Quote {
  id: string;                 // "q_" + UUID v4
  requestedBy: string;        // user id from the token
  cityId: string;
  vehicleType: string;
  pickup: { lat; lng };
  dropoff: { lat; lng };
  pickupAddress?: string;
  dropoffAddress?: string;
  fareMinor: number;
  waitingPerMinMinor: number;
  currency: "ETB";
  distanceMeters: number;
  durationSeconds: number;
  approximate: boolean;       // the route was a straight-line estimate
  routePolyline6?: string;    // encoded polyline, precision 6
  etaToPickupSeconds: number | null;
  driversNearby: number;
  breakdown: FareBreakdown;
  expiresAt: string;          // ISO 8601
}
```

The same shape is declared in `services/trip-service/src/quotes.ts` (without `etaToPickupSeconds`, `driversNearby`, `breakdown`).

### Storage and expiry

- Redis string `quote:<id>`, JSON, `EX` = `quote.ttlSeconds` at the time of the estimate.
- Expiry is Redis's. After it, `GET /internal/quotes/:id` → 404, and trip-service treats 404 as "no quote".
- A fare change after the estimate does not touch stored quotes (`tests/unit/pricing.test.ts`: "a fare change applies to the next quote, not to this one").
- pricing-service does not check `requestedBy` or `expiresAt` on read; it returns whatever Redis still has. The `requestedBy` check is trip-service's (comment on the field).

### ETA per vehicle type

`etas()` in `src/quotes.ts` calls location-service `GET /internal/eta-to-pickup?lat&lng&cityId&vehicleType` once per type, in parallel, with a 1.5 s timeout each. A failure is logged (`location-service unavailable, no ETA on the quote`) and gives `etaToPickupSeconds: null, driversNearby: 0`; it never fails the estimate. location-service looks at up to 5 available drivers within 6 km and asks mapping-service `/internal/table` for driving times (`services/location-service/src/locations.ts`). The `approximate` flag of the ETA answer is not copied onto the quote.

## Fare card endpoint

`GET /api/pricing/fares?cityId=` → `quotes.fareCards(cityId, offered(cityId))`: for each offered type with a card, `{ vehicleType, baseMinor, perKmMinor, perMinMinor, minFareMinor, waitingPerMinMinor, currency: "ETB" }`. Public, `cache-control: public, max-age=60`. The city id is only format-checked; an unknown city gets the global fares of every type offered in all cities.

## Vehicle types without fares

Fare keys exist only for `economy`, `comfort` and `minivan`. A vehicle type added in the admin catalogue (for example `electric`, as in platform-service's tests) is "offered" but has no card:

- `POST /estimates` without `vehicleTypes` in a city where it is offered → the whole request fails with `400 unknown_vehicle_type`;
- `GET /fares` silently leaves it out.

Supporting a new type needs new `fares.<type>.*` entries in `libs/shared-settings/src/registry.ts`.

## Surge, zones, promotions, rules administration

Not found in code. There is no surge multiplier, no zone, no promo, and no rule administration API in pricing-service. Fares are administered as ordinary live settings in platform-service (`PUT /api/platform/settings/fares.<type>.<part>` with a city override or globally; sensitive, so a second super admin approves). See [platform-service architecture](../../platform-service/docs/architecture.md#changing-a-setting).

## Caching

- Settings: in-memory snapshot via `createSettingsClient` (reload on `settings:changed`, poll every 30 s).
- Routes: not cached here (mapping-service caches).
- HTTP caching headers: fares 60 s; estimates none.

## Idempotency

None. Each estimate (and each `POST /internal/quotes`) creates new quote ids. Repeating `GET /internal/quotes/:id` is a plain read.

## Security model

| Route | Check |
|---|---|
| `POST /api/pricing/estimates` | Access token, audience `ride-app` or `ride-admin`; issuer `AUTH_ISSUER`; JWKS `AUTH_JWKS_URL`; refused if `deny:<userId>` exists or the token's permission version is older than `pv:<userId>` |
| `GET /api/pricing/fares` | Public |
| `GET /internal/quotes/:id`, `POST /internal/quotes` | `Bearer INTERNAL_SERVICE_TOKEN`, `timingSafeEqual`; routes have `rateLimit: false` |

No permission (`authorize`) is checked on any route. The permission matrix is synced (`createAuthzSync`) but not used by a route. Kong does not route `/internal/*`.

## Workflow 15: rules, zones and promotions (added)

This supersedes "Surge, zones, promotions, rules administration: not found in code" above.

### New layout

```
src/
├── catalog.ts          in-memory catalog of approved fare rules and live zones; zoneEffect()
├── db.ts               Prisma client (Postgres)
├── events/consumer.ts  Kafka in: trip.completed (redeem), trip.cancelled (release)
├── http/admin-routes.ts zones, fare changes, promos, rider promo check
├── lib/idempotency.ts  Idempotency-Key store (as in support-service)
├── lib/staff.ts        city scopes for lists, 404-not-403 for single resources
├── outbox/             writeOutbox() + relay (FOR UPDATE SKIP LOCKED → Kafka)
├── promos/             discount.ts (pure), service.ts (CRUD, activation, offer/hold/book/redeem/release, sweep)
├── rules/service.ts    fare change requests (maker–checker), impact preview, sweep (expire, activate)
└── zones/              geometry.ts (ring validation, point in polygon), service.ts (CRUD)
```

### Fare card resolution

For a city and vehicle type at time *t*: the approved `fare_rule` with the latest `valid_from ≤ t`; if there is none, the live `fares.<type>.*` settings exactly as before. So existing behaviour is unchanged until the first approval for that city and type; after it, Settings → Fares no longer affects that city and type (the "Fares" page shows `source: SETTINGS | RULE`). Fare changes are not routed through platform-service's settings change requests: the design (workflow 15) wants versioned rules with a future `valid_from`, an impact preview and `pricing:approve` per city, which platform's sensitive-settings flow (`settings:approve`, global, immediate) can't express.

The catalog holds **every** rule (past, current, scheduled), so a scheduled rule takes effect at `valid_from` without a reload. It reloads when older than 60 s, right after a change on this replica, and when another replica publishes Redis `pricing:catalog_changed`. If Postgres fails on reload, the last catalog keeps serving (warning log, retry in 10 s); if it was never loaded, estimates answer `503 dependency_unavailable`.

### Fare change lifecycle

`PENDING → APPROVED (phase SCHEDULED until valid_from) | REJECTED | CANCELLED | EXPIRED`. Rules:

- one `PENDING` change per city and vehicle type (partial unique index);
- `validFrom` ≥ now + 24 h when proposed **and** when approved; an `emergency` change takes effect on approval (`validFrom` = approval time unless later);
- maker ≠ checker for approve and reject; only the maker withdraws;
- not decided within 7 days → `EXPIRED` (sweep);
- approval inserts the `fare_rule` (unique `(city_id, vehicle_type, valid_from)`), writes `pricing.rule_scheduled`, and when already due also `pricing.rule_activated`; the 30 s sweep writes `pricing.rule_activated` for rules whose time came.

Impact preview (`impactOf`): the current and the proposed card priced on four typical trips (3 km/10 min, 8 km/20 min, 15 km/35 min, 25 km/50 min). Replaying last week's real trips (design step 2) is not done: pricing-service has no trip history.

### Zones

`zoneEffect(zones, pickup, dropoff)`, applied to every estimate:

| Kind | Effect |
|---|---|
| `SERVICE_AREA` | when the city has any, a pickup outside all of them → `400 outside_service_area` |
| `NO_PICKUP` | pickup inside → `400 pickup_not_allowed` |
| `AIRPORT` | pickup **or** drop-off inside → `feeMinor` added once (highest if several), after the minimum fare |
| `SURGE` | pickup inside → metered fare × multiplier (highest if several; 1–3) before rounding |

Fare: `max(min, round((base + km + min) × surge, birr)) + airportFee`. Geometry is checked in plain arithmetic (`zones/geometry.ts`): closed ring of 3–500 distinct points, inside the city box from `libs/shared-location`, no crossing edges, non-zero area; the boundary counts as inside. Zones change at once (no maker–checker) and are versioned (`version`, optimistic concurrency on edit), audited and announced (`pricing.zone_changed`).

### Promotions

- `DRAFT → ACTIVE → PAUSED ⇄ ACTIVE`, `→ EXHAUSTED` (budget or total redemptions reached), `→ EXPIRED` (sweep at `endsAt`), `→ ARCHIVED`.
- Activation of a budget above `PROMO_APPROVAL_THRESHOLD_MINOR` needs `incentive:approve` (finance manager) and a person other than the creator.
- **At estimate** (`offer`): the code must be ACTIVE, inside its window, for the pickup city; the rider's BOOKED + REDEEMED uses < `perUserLimit`; `redemptionCount` + BOOKED < `maxRedemptions`; budget left = `budget − spent − BOOKED discounts` > 0. Each eligible quote gets `discountFor()` (percent rounded down to whole birr, capped by `maxDiscountMinor`, never above the fare), capped by the budget left, and a `promo_reservation` (HELD, expires with the quote). One promo per quote, so per trip.
- **At booking** (`GET /internal/quotes/:id`): HELD → BOOKED under a row lock on the promo (re-checks the per-user limit), expiry +24 h.
- **At `trip.completed`**: the reservation is found by `quoteId` when the event has it, else the rider's latest BOOKED reservation in that city and vehicle type booked before `completedAt`. Discount = `promoDiscountMinor` from the event if present, else the reserved discount, at most the final fare. Inserts `promo_redemption` (unique per trip: replays are no-ops), adds to `spent`/`redemptionCount`, writes `promo.redeemed`, and `promo.exhausted` + status EXHAUSTED when the budget or the total is reached. A booked discount is honoured even if it overshoots the budget slightly.
- **At `trip.cancelled`**: BOOKED → RELEASED (the rider can use the code again).

Not built: FIRST_RIDE / REFERRAL promo types and new-rider eligibility (pricing has no trip history), payment-method eligibility, device/phone fingerprint abuse limits, auto-applied promos, the 80 % budget alert, driver incentives (quests).

### Background work

| Job | Interval | What |
|---|---|---|
| Sweep | 30 s | expire undecided fare changes; activate due rules; expire ended promos and HELD/BOOKED reservations past their time |
| Outbox relay | 500 ms | when `KAFKA_BROKERS` is set |
| Kafka consumer | continuous | `trip.completed`, `trip.cancelled` (group `pricing-service`) |
| Idempotency purge | 1 h | keys older than 24 h |
| Catalog subscription | — | Redis `pricing:catalog_changed` |

### Security (new routes)

Every staff route verifies the token (deny list, permission version) and checks the live matrix per city with `can()`. Lists filter to the caller's cities (`citiesWith`); a `cityId` outside them is `403`; a single resource outside them is `404`.
