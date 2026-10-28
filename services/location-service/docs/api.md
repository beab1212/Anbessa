# location-service: HTTP API

Source: `src/http/routes.ts`, `src/app.ts`, `src/locations.ts`. Port 3003. All responses are JSON.

## Common behaviour

| Item | Value |
|---|---|
| Body limit | 16 KiB (`bodyLimit` in `app.ts`) |
| Security headers | `@fastify/helmet` defaults |
| Global rate limit | `@fastify/rate-limit`, **300 requests/min per client IP** (`trustProxy: true`, so the `X-Forwarded-For` address behind Kong). Disabled on the three read routes under `/internal/*` (`config: { rateLimit: false }`), not on the dev routes |
| Kong | only `GET /api/locations*` is routed (120/min, see [integrations.md](integrations.md)). `/internal/*` is never routed |

### Authentication

| Route group | Credential | Check |
|---|---|---|
| `/internal/*` | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` | constant-time compare (`timingSafeEqual`) with the configured token. Mismatch → 401 `invalid service credentials` |
| `/api/locations/cities/:cityId/drivers` | staff access JWT, audience **`ride-admin`** | `createTokenVerifier` from `libs/shared-authz`: ES256, `iss = AUTH_ISSUER`, keys from `AUTH_JWKS_URL`, `sub`/`exp`/`iat` required, 30 s clock tolerance |
| `/api/locations/trips/:tripId/driver`, `/api/locations/nearby` | app access JWT, audience **`ride-app`** | same verifier |

location-service's verifier does **not** check the suspension deny list (`deny:{userId}`) or the permission version (`pv:{userId}`); those options are not passed in `server.ts`. A token for the wrong audience fails as `invalid_token`.

### Error format (`src/middlewares/error-handler.ts`)

| Status | Body | When |
|---|---|---|
| 400 | `{ error: "validation_error", message: "invalid request", issues: [{ path, message }] }` | Zod validation of query/params/body |
| 401 | `{ error: "unauthorized", message }` | missing bearer token, wrong service token |
| 401 | `{ error: "invalid_token", message: "invalid or expired access token" }` | JWT signature, issuer, audience or expiry fails |
| 403 | `{ error: "forbidden", message: "missing permission … for this resource" }` | `authorize()` fails (ops map) |
| 404 | `{ error: "not_found", message: "<what> not found" }` | unknown driver, trip not visible, no position, unknown route |
| 4xx | `{ error: <fastify code or "bad_request">, message }` | other Fastify client errors, including 429 from the rate limiter |
| 503 | `{ error: "auth_unavailable", message }` | `TokenCheckUnavailable` is mapped (503, `retry-after: 5`) but can't occur here: location-service's verifier has no deny-list / permission-version callbacks |
| 500 | `{ error: "internal_error", message: "Something went wrong" }` | anything else (logged with the request id) |

A `cityId` or `vehicleType` that passes the length check but not the key guards in `libs/shared-location/src/keys.ts` (`^[a-z0-9-]{1,40}$`, `^[a-z0-9_]{1,30}$`) throws a plain `Error` inside the key builder and answers **500**, not 400.

---

## Health

| Route | Auth | Response |
|---|---|---|
| `GET /health` | none | `200 { status: "ok" }` |
| `GET /health/live` | none | `200 { status: "ok" }` |
| `GET /health/ready` | none | `200 { status: "ok" }` if `PING` to Redis works, else `503 { status: "unavailable" }` |

---

## Internal routes (service token)

### `GET /internal/drivers/nearby`

Matching candidates, nearest first. Caller: trip-service matcher (`services/trip-service/src/lib/clients.ts`).

| Query | Type | Rules | Default |
|---|---|---|---|
| `cityId` | string | 1–40 chars (and the key guard) | required |
| `vehicleType` | string | 1–30 chars (and the key guard) | required |
| `lat` | number | −90…90 | required |
| `lng` | number | −180…180 | required |
| `radiusMeters` | int | 100…20000 | 2000 |
| `limit` | int | 1…50 | 20 |
| `cashOnly` | `"true"` / `"false"` | | `"false"` |

Response `200`:

```json
{ "drivers": [
  { "driverId": "uuid", "lat": 8.98, "lng": 38.75, "distanceMeters": 412, "heading": 90,
    "cashAllowed": true, "balanceState": "OK", "vehicleId": "…", "at": 1792900000000 }
] }
```

`heading` and `balanceState` are omitted when unknown. `at` is the last ping's device time (unix ms). Filters: see [architecture.md §5](architecture.md#5-nearby-search-nearbyavailable). Rate limit: none.

### `GET /internal/eta-to-pickup`

"A driver can reach you in ~N min" for quotes. Caller: pricing-service (`services/pricing-service/src/lib/location.ts`).

| Query | Rules |
|---|---|
| `cityId`, `vehicleType`, `lat`, `lng` | as above, required |
| `cashOnly` | `"true"` / `"false"`, default `"false"` (pricing-service doesn't send it) |

Response `200`: `{ "etaSeconds": 240 | null, "driversNearby": 3, "approximate": false }`. Considers up to 5 available drivers within 6 km. `approximate: true` when mapping-service said so or was unreachable (straight-line fallback). Rate limit: none.

### `GET /internal/drivers/:driverId`

One driver's live state. Caller: trip-service: `matchDriver` (availability, city, vehicle type, balance and cash checks before a match), `livePosition` (arrive geofence, no-show, far-from-drop-off flag; positions older than 60 s are ignored there) and the share-link page (`services/trip-service/src/trips/share.ts`). `driverId` must be a UUID.

Response `200` (`DriverState` from `libs/shared-location/src/drivers.ts`):

```json
{ "driverId": "uuid", "status": "available | on_trip | offline", "cityId": "addis-ababa",
  "vehicleType": "economy", "vehicleId": "…", "fleetOrgId": "uuid?", "beneficiaryId": "uuid?",
  "tripId": "uuid?", "cashAllowed": true, "balanceState": "OK?", "lat": 8.98, "lng": 38.75,
  "heading": 90, "at": 1792900000000, "stale": false }
```

`404 driver not found` if the hash is missing or incomplete (no `status`, `cityId` or `vehicleType`). An `offline` driver is still returned until the hash expires (15 min).

### `POST /internal/dev/drivers/:driverId/online` (development only)

Registered only when `NODE_ENV=development`. Stand-in for fleet-service's `driver.online`. `driverId` must be a UUID. Body = the `driver.online` schema without `driverId`:

| Field | Type | Rules |
|---|---|---|
| `vehicleId` | string | 1–64 chars, required |
| `vehicleType` | string | key guard, required |
| `cityId` | string | key guard, required |
| `cashAllowed` | boolean | required |
| `fleetOrgId`, `beneficiaryId` | UUID | optional |
| `balanceState` | string | ≤ 20 chars, optional |

Response `204`. Runs `goOnline`. Counts toward the global 300/min limit.

### `POST /internal/dev/drivers/:driverId/offline` (development only)

Runs `goOffline`. Response `204`.

---

## Public routes (through Kong)

### `GET /api/locations/nearby`

Anonymous cars around the rider (home screen). Any valid `ride-app` token; no permission check.

| Query | Rules |
|---|---|
| `lat`, `lng` | required, ranges as above |
| `vehicleType` | optional, 1–30 chars |

Response `200`:

```json
{ "cars": [ { "lat": 8.9805, "lng": 38.7579, "heading": 92 } ],
  "etaSeconds": 180, "driversNearby": 4, "approximate": false }
```

At most 15 cars within 2 km, positions on a ~33 m grid, no ids. The caller's own car is never included (a driver who is still online and opens the app as a rider would otherwise see their own car where they stand). Outside the served cities: empty `cars`, `etaSeconds: null`. Rate limit: **30/min per user id** (the limiter runs in `preHandler`, after the token is verified in `onRequest`; key falls back to IP), on top of the global 300/min per IP.

### `GET /api/locations/trips/:tripId/driver`

Last driver position for a trip. `tripId` must be a UUID. `ride-app` token.

| Caller | Allowed when |
|---|---|
| The trip's rider, driver or booker | member of `trip:{tripId}:members` (written on `trip.matched`; the booker is added from `bookedById` for phone and company bookings; kept 5 min after the trip ends) |
| A fleet owner | the trip's driver currently has `tripId` = this trip and a `fleetOrgId`, and the caller has `location:read_live` for that org |
| The billed company | `trip:{tripId}:billing_org` is set (from `trip.matched.billingOrgId`) and the caller has `trip:read` for that org (bookers, company admins); kept 5 min after the trip ends |
| Anyone else | never: `404 trip not found` |

Response `200`: `{ "tripId", "driverId", "lat", "lng", "heading"?, "at" }` (`at` = device time, unix ms). `404 driver position not found` for a member before the first ping after the match.

### `GET /api/locations/cities/:cityId/drivers`

Ops map. `ride-admin` token with `location:read_live` covering `cityId` (city-scoped assignment for that city, or a `GLOBAL` assignment). `cityId` 1–40 chars.

Response `200`:

```json
{ "drivers": [ { "driverId", "status", "vehicleType", "vehicleId", "tripId"?, "lat", "lng",
                 "heading"?, "at", "stale": false } ] }
```

Every driver in `seen:{city}` that is not `offline` and has a position, stale ones included. `403` without the permission for that city; `401` for an app (`ride-app`) token.
