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

None. Each estimate creates new quote ids. Repeating `GET /internal/quotes/:id` is a plain read.

## Security model

| Route | Check |
|---|---|
| `POST /api/pricing/estimates` | Access token, audience `ride-app` or `ride-admin`; issuer `AUTH_ISSUER`; JWKS `AUTH_JWKS_URL`; refused if `deny:<userId>` exists or the token's permission version is older than `pv:<userId>` |
| `GET /api/pricing/fares` | Public |
| `GET /internal/quotes/:id` | `Bearer INTERNAL_SERVICE_TOKEN`, `timingSafeEqual`; route has `rateLimit: false` |

No permission (`authorize`) is checked on any route. The permission matrix is synced (`createAuthzSync`) but not used by a route. Kong does not route `/internal/*`.
