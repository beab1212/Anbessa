# mapping-service HTTP API

Source: `src/http/routes.ts`, `src/app.ts`, `src/maps.ts`. Kong routes only `GET /api/maps*` (`maps-routes`). `/internal/*` and `/health*` are not routed.

## Common rules

| Rule | Value |
|---|---|
| Body limit | 32 KB |
| Point (JSON) | `{ lat: number −90..90, lng: number −180..180 }` |
| Point (query) | `lat`, `lng` coerced numbers, same ranges |
| Service area | every point inside Ethiopia's box, else `400 outside_service_area` |
| Internal auth | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`; no rate limit |
| Public auth | `Authorization: Bearer <access token>`, audience `ride-app` or `ride-admin`; no permission check |
| Public rate limit | service: 60 / minute per user id; Kong: 120 / minute on `/api/maps` |
| Language | `en` (default) or `am` |

## Routes

| Method and path | Caller | Auth |
|---|---|---|
| `GET /health`, `GET /health/live` | probes | none |
| `GET /health/ready` | probes, platform-service system page | none |
| `POST /internal/route` | pricing-service, trip-service | service token |
| `POST /internal/table` | location-service, trip-service | service token |
| `GET /api/maps/search` | phone app, web (`PlacePicker`) | user token |
| `GET /api/maps/reverse` | phone app, web (phone booking) | user token |
| `GET /api/maps/snap` | phone app | user token |
| `GET /api/maps/route` | phone app | user token |

### `GET /health/ready`

Always `200`: `{ status: "ok", engines: { osrm: "ok" | "degraded", nominatim: "ok" | "degraded" } }`. `degraded` = that engine's circuit breaker is open. The service stays ready while engines are down because route and table fall back to estimates.

### `POST /internal/route`

Body:

| Field | Type | Default |
|---|---|---|
| `points` | Point[] 2–10 | required |
| `geometry` | boolean | `false` |
| `steps` | boolean | `false` |

Response `200`:

```ts
{
  distanceMeters: number;      // integer
  durationSeconds: number;     // integer
  geometry?: string;           // polyline6, when geometry: true
  steps?: RouteStep[];         // when steps: true ([] in a fallback)
  approximate: boolean;        // true = straight-line estimate
}
interface RouteStep {
  maneuver: { type: string; modifier?: string; location: { lat; lng }; bearingAfter: number; exit?: number };
  name: string;                // "" when unnamed
  distanceMeters: number;
  durationSeconds: number;
}
```

Errors: `400 validation_error`, `400 outside_service_area`, `404 not_found` (OSRM `NoRoute`/`NoSegment`), `401 unauthorized`, `503 engine_unavailable` (OSRM answered with another error code).

### `POST /internal/table`

Body: `{ sources: Point[] 1–50, destinations: Point[] 1–50 }`, at most 625 cells.

Response `200`: `{ durations: (number | null)[][], distances: (number | null)[][], approximate: boolean }`, indexed `[source][destination]`, seconds and meters, `null` = no route. Fallback cells are never null.

Errors: `400` (validation, more than 625 cells, outside the area), `401`, `503 engine_unavailable` (OSRM answered with a non-`Ok` code, including `NoRoute`).

### `GET /api/maps/search`

Query:

| Param | Type | Notes |
|---|---|---|
| `q` | string | 2–120 characters after trimming (`400` otherwise) |
| `cityId` | string, optional | must be a key of `CITIES` (`addis-ababa`, `hawassa`), else `400 unknown city`; bounds the search to that box |
| `language` | `en \| am` | default `en` |
| `limit` | int 1–10 | default 8 |

Response: `{ results: { name, label, lat, lng, category, type }[] }`, inside the service area only.

Errors: `400`, `401`, `429` (rate limit), `503 engine_unavailable`.

### `GET /api/maps/reverse`

Query: `lat`, `lng`, `language`. Response: one place `{ name, label, lat, lng, category, type }`. Errors: `400`, `401`, `404 not_found` ("address not found"), `429`, `503`.

### `GET /api/maps/snap`

Query: `lat`, `lng`. Response: `{ lat, lng, name, distanceMeters, approximate }`. When OSRM can't answer (or finds no segment) the input point comes back with `approximate: true`. Errors: `400`, `401`, `429`, `503` (OSRM error code other than `NoSegment`).

### `GET /api/maps/route`

Query:

| Param | Type | Notes |
|---|---|---|
| `from` | `"lat,lng"` | required |
| `to` | `"lat,lng"` | required |
| `steps` | `"0" \| "1"` | default `"0"` |

Response: `{ polyline6: string, distanceMeters, durationSeconds, approximate, steps: RouteStep[] }` (`steps` is `[]` unless asked, and in a fallback). Errors as for `/internal/route`, plus `429`.

## Errors

`src/middlewares/error-handler.ts`, body `{ error, message }`:

| Cause | Status | `error` |
|---|---|---|
| `AppError` | its status | `bad_request`, `outside_service_area`, `not_found`, `unauthorized` |
| `TokenError` | 401 | its code |
| `TokenCheckUnavailable` | 503 | `auth_unavailable`, `retry-after: 5`. Mapped but can't occur here: mapping-service's verifier has no deny-list / permission-version callbacks |
| `ZodError` | 400 | `validation_error` with `issues[]` |
| `EngineError` | 503 | `engine_unavailable` ("routing is temporarily unavailable" or "address search is temporarily unavailable"); logged at warn with engine and reason |
| rate limit | 429 | from `@fastify/rate-limit` |
| other | 500 | `internal_error` |
| unknown route | 404 | `not_found` |
