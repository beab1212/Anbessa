# pricing-service HTTP API

Source: `src/http/routes.ts`, `src/app.ts`. `/api/pricing/*` is routed by Kong (`pricing-routes`); `/internal/*` and `/health*` are not.

## Common rules

| Rule | Value |
|---|---|
| Body limit | 16 KB |
| Rate limit (service) | 300 / minute per client IP on every route except `/internal/quotes/:id` (`rateLimit: false`) |
| Rate limit (Kong) | 120 / minute on `/api/pricing` |
| App / staff token | `Authorization: Bearer <access token>`, audience `ride-app` or `ride-admin` |
| Service token | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` |
| Point | `{ lat: number −90..90, lng: number −180..180 }` |
| Money | integer santim, currency `ETB` |

## Routes

| Method and path | Caller | Auth | Success |
|---|---|---|---|
| `GET /health`, `GET /health/live` | probes | none | `200 { status: "ok" }` |
| `GET /health/ready` | probes, platform system page | none | `200 { status: "ok" }` if Redis answers `PONG`, else `503 { status: "unavailable" }` |
| `POST /api/pricing/estimates` | phone app (rider), web partner page, web call-center phone booking | `ride-app` or `ride-admin` token; no permission check | `200` |
| `GET /api/pricing/fares` | phone app (fare info, before sign-in) | none | `200` |
| `GET /internal/quotes/:id` | trip-service | service token | `200` |

### `POST /api/pricing/estimates`

Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `pickup` | Point | yes | must be inside a city box from `libs/shared-location` (`addis-ababa`, `hawassa`) |
| `dropoff` | Point | yes | not checked against cities (mapping-service checks the service area) |
| `vehicleTypes` | string[] 1–5, each `^[a-z0-9_]{1,30}$` | no | default: every type offered in the pickup's city |
| `pickupAddress` | string ≤ 200 | no | copied onto the quotes |
| `dropoffAddress` | string ≤ 200 | no | copied onto the quotes |

Response `200`:

```ts
{
  quotes: Quote[];   // one per vehicle type, in the order requested/offered
  route: { polyline6: string; distanceMeters: number; durationSeconds: number; approximate: boolean };
}
```

`Quote` fields: `id` (`q_<uuid>`), `requestedBy`, `cityId`, `vehicleType`, `pickup`, `dropoff`, `pickupAddress?`, `dropoffAddress?`, `fareMinor`, `waitingPerMinMinor`, `currency`, `distanceMeters`, `durationSeconds`, `approximate`, `routePolyline6?`, `etaToPickupSeconds` (number or null), `driversNearby`, `breakdown { baseMinor, distanceMinor, timeMinor, minimumApplied, roundingMinor }`, `expiresAt` (ISO). See [architecture.md](architecture.md#the-quote).

Errors:

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` | body shape |
| 400 | `vehicle_type_unavailable` | a requested type is not offered in the pickup's city |
| 400 | `outside_service_area` | pickup is in no city box |
| 400 | `unknown_vehicle_type` | a type (requested or offered) has no `fares.<type>.*` settings |
| 401 | `unauthorized` / token error code | no token, bad token, wrong audience, denied user, stale permission version |
| 503 | `dependency_unavailable` | mapping-service call failed (any error, including no road between the points) |
| 503 | `auth_unavailable` | Redis deny-list / permission-version lookup failed (`TokenCheckUnavailable`); sent with `retry-after: 5`, logged warn `token check unavailable (Redis)`. The token is refused, retry later |
| 500 | `internal_error` | e.g. Redis unavailable while storing a quote |

### `GET /api/pricing/fares?cityId=`

Query: `cityId` required, `^[a-z0-9-]{1,40}$`. Header `cache-control: public, max-age=60`.

```ts
{
  cityId: string;
  fares: { vehicleType: string; baseMinor; perKmMinor; perMinMinor; minFareMinor; waitingPerMinMinor: number; currency: "ETB" }[];
}
```

Types without fare settings are left out. An unknown city id is not an error.

### `GET /internal/quotes/:id`

Params: `id` string 1–100. Response: the stored `Quote`. Errors: `401 unauthorized` ("invalid service credentials"), `404 not_found` ("quote not found") when expired or unknown.

## Errors

`src/middlewares/error-handler.ts`, body `{ error, message }`: `AppError` → its status and code; `AuthorizationError` → 403 `forbidden` (no route raises it today); `TokenError` → 401 with its code; `TokenCheckUnavailable` (Redis lookup failed) → 503 `auth_unavailable` with `retry-after: 5`; `ZodError` → 400 `validation_error` with `issues[]`; other Fastify 4xx pass through; everything else → 500 `internal_error`; unknown route → 404 `not_found`.
