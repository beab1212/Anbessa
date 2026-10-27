# mapping-service architecture

## Layout

```
src/
├── server.ts            start, listen, shutdown
├── app.ts               Fastify: error handler, helmet, /health*, routes (no global rate limit)
├── container.ts         Redis (optional), breakers, OSRM + Nominatim clients, maps, token verifier
├── config/index.ts      env → typed config (zod)
├── maps.ts              service-area checks, limits, caching, fallbacks
├── engines/http.ts      getJson with timeout, EngineError, circuit breaker
├── engines/osrm.ts      OSRM v1 client: route (geometry, steps), table, nearest
├── engines/nominatim.ts Nominatim client: search, reverse (jsonv2)
├── lib/cache.ts         Redis cache-aside, hashed keys, noCache
├── lib/polyline.ts      polyline6 encoder (for the fallback line)
├── regions.ts           re-exports CITIES, SERVICE_AREA, COUNTRY_CODES from libs/shared-location
├── http/routes.ts       internal (service token) and public (user token, 60/min/user) routes
├── middlewares/error-handler.ts
└── utils/logger.ts
```

## Request flow

1. Fastify (`trustProxy`, body limit 32 KB, helmet).
2. Internal routes: an `onRequest` hook checks `Bearer INTERNAL_SERVICE_TOKEN` (`timingSafeEqual`). Public routes: an `onRequest` hook verifies the user token (`ride-app`, else `ride-admin`), then a per-user rate limit runs in `preHandler`.
3. zod parses input.
4. `maps.ts` checks limits and the service area, rounds coordinates, looks in the cache, calls the engine through its breaker, falls back if needed.
5. The error handler maps `EngineError` to `503 engine_unavailable`.

## Service area

`libs/shared-location/src/cities.ts`:

| Name | Value |
|---|---|
| `SERVICE_AREA` (Ethiopia) | lng 32.9–48.1, lat 3.3–15.0 |
| `COUNTRY_CODES` | `et` (Nominatim `countrycodes`) |
| `CITIES["addis-ababa"]` | lng 38.63–38.92, lat 8.83–9.10 |
| `CITIES.hawassa` | lng 38.42–38.54, lat 6.98–7.12 |

Every point of route, table, snap and reverse must be inside `SERVICE_AREA`, else `400 outside_service_area` before any engine call. Search results are filtered to the service area after the engine answers. `CITIES` is used only for search boxes (`cityId`). It is a static list and is not the admin's city table in platform-service; a city added in the admin dashboard is unknown here (`400 unknown city` on search).

## Coordinate rounding

`round()` in `src/maps.ts` rounds lat and lng to 4 decimals (about 11 m). Rounded points are sent to the engine and used in cache keys, so nearby requests share both. The straight-line fallback uses the original points.

OSRM gets coordinates as `lng,lat` with 6 decimals (`coord()` in `src/engines/osrm.ts`).

## OSRM client

`src/engines/osrm.ts` (OSRM HTTP API v1, profile `driving`):

| Method | OSRM request | Mapped to |
|---|---|---|
| `route(points, withGeometry, withSteps)` | `/route/v1/driving/{lng,lat;…}?overview=full\|false&geometries=polyline6&steps=true\|false&alternatives=false` | first route: `distanceMeters`, `durationSeconds` (rounded), `geometry` (only when asked and present), `steps` (when asked) |
| `table(sources, destinations)` | `/table/v1/driving/{all points}?sources=0;1…&destinations=n;n+1…&annotations=duration,distance` | `durations[s][d]`, `distances[s][d]` rounded, `null` kept |
| `nearest(p)` | `/nearest/v1/driving/{lng,lat}?number=1` | `{ lat, lng, name, distanceMeters }` |

Steps: each OSRM step of every leg becomes `{ maneuver: { type, modifier?, location: {lat,lng}, bearingAfter, exit? }, name, distanceMeters, durationSeconds }`.

OSRM response codes: `NoRoute` / `NoSegment` → `EngineError(status 404)`; any other non-`Ok` code → `EngineError(status 400)`; no route in `routes[]` → 404.

## Nominatim client

`src/engines/nominatim.ts` (format `jsonv2`, header `user-agent: Anbessa mapping-service`):

| Method | Request | Notes |
|---|---|---|
| `search({ text, viewbox?, limit, language })` | `/search?q&format=jsonv2&countrycodes=et&limit&accept-language` + `viewbox=minLng,maxLat,maxLng,minLat&bounded=1` when a city is given | non-array answer → `[]` |
| `reverse(p, language)` | `/reverse?lat&lon&format=jsonv2&zoom=18&accept-language` | `error` in the answer or no `display_name` → `null` |

A place: `{ lat, lng, name, label, category, type }`. `name` is Nominatim's `name`, else the first part of `display_name`; `label` is `display_name`.

## HTTP plumbing, timeout and circuit breaker

`getJson()` (`src/engines/http.ts`):

- `fetch` with `AbortSignal.timeout(ENGINE_TIMEOUT_MS)`; timeout → `EngineError("timeout")`, network error → `EngineError("unreachable")` (no status);
- HTTP ≥ 500 → `EngineError("http <status>", status)`;
- HTTP 4xx with a JSON body is **returned** to the caller (OSRM answers 400 with a `code` such as `NoRoute`);
- unparsable body → `EngineError("invalid response", 502)`.

`breaker(engine)`: one per engine (`osrm`, `nominatim`), per process.

| Rule | Value |
|---|---|
| Opens after | 3 consecutive failures |
| Stays open | 10 s (`cooldownMs`); calls fail at once with `EngineError("circuit open")` |
| After the cooldown | calls go through again; a success resets the count, another failure re-opens it for 10 s |
| Not counted as failures | `EngineError` with status < 500 (no route, bad query) |
| Exposed as | `engineStatus()` → `{ osrm: "ok"\|"degraded", nominatim: "ok"\|"degraded" }` in `/health/ready` |

## Fallbacks

| Operation | When | Fallback | Cached |
|---|---|---|---|
| route | OSRM timeout, unreachable, 5xx, invalid response, breaker open | straight-line (haversine) distance × **1.35** per leg at **22 km/h**; `geometry` = polyline6 of the input points (straight segments) when asked; `steps: []` when asked; `approximate: true` | no |
| route | OSRM `NoRoute`/`NoSegment` | none: `404 not_found` ("route not found") | no |
| route | OSRM other 4xx code (status 400) | none: `503 engine_unavailable` | no |
| table | same engine failures as route | straight-line estimate per cell, `approximate: true` | no |
| table | OSRM `NoRoute`/other 4xx | none: `503 engine_unavailable` (the 404 is not turned into "not found" for tables) | no |
| snap | engine failures (as for route) or `NoSegment` (404) | the input point, `name: ""`, `distanceMeters: 0`, `approximate: true` | no |
| snap | OSRM other 4xx code (status 400) | none: `503 engine_unavailable` | no |
| search, reverse | any engine error, breaker open | none: `503 engine_unavailable` ("address search is temporarily unavailable") | — |

Fallback constants: `FALLBACK` in `src/maps.ts`. location-service uses the same 1.35 and 22 km/h for its own fallback (`services/location-service/src/locations.ts`).

## Polyline encoding

Google encoded polyline, precision 6 (`1e6`), the same format OSRM returns with `geometries=polyline6`. Only an encoder exists (`src/lib/polyline.ts`, `encodePolyline6`), used for the fallback line. Real geometries are passed through from OSRM unchanged. No decoder in this service.

## Caching

Cache-aside (`cached()` in `src/maps.ts`, `redisCache` in `src/lib/cache.ts`). Keys and TTLs in [data-model.md](data-model.md#redis-keys).

- Only successful engine answers are cached. Fallback answers are returned outside `cached()` and never stored.
- A `null` reverse result ("no address") **is** cached for 24 h and returns 404 from the cache.
- Redis errors are swallowed: `get` returns a miss, `set` is ignored.
- Without `REDIS_URL` (allowed outside production) the `noCache` stub is used and every request hits the engine.
- There is no request coalescing: concurrent misses for the same key each call the engine.

## Limits

`LIMITS` in `src/maps.ts` and the zod schemas in `src/http/routes.ts`:

| Limit | Value |
|---|---|
| Route waypoints | 2–10 |
| Table sides | 1–50 each, at most 625 cells |
| Search text | 2–120 characters after trimming and collapsing spaces |
| Search results | 1–10 (default 8) |
| Public rate limit | 60 / minute per user id (falls back to IP if no user id) |
| Body | 32 KB |

## Geocoding details

- Search: the cache key uses lower-cased text, `cityId`, language and limit; the engine gets the original-case text. Results are filtered by `inServiceArea`.
- Languages: `en` (default) or `am`, passed as `accept-language`.
- No autocomplete-specific logic, no POI ranking, no saved places here.

## Security model

| Route group | Check |
|---|---|
| `/internal/*` | `Bearer INTERNAL_SERVICE_TOKEN`, `timingSafeEqual`; no rate limit |
| `/api/maps/*` | access token verified against `AUTH_JWKS_URL` / `AUTH_ISSUER`, audience `ride-app`, else `ride-admin`; no permission check |
| `/health*` | open |

The token verifier is built **without** Redis, so the deny list (`deny:<userId>`) and permission-version (`pv:<userId>`) checks that pricing- and platform-service apply are not applied here: a suspended user's still-valid access token can use `/api/maps/*` until it expires. The permission matrix is not synced (no `createAuthzSync`).

Engines are called only by this service (`infra/mapping-stack/README.md`). Kong routes only `GET /api/maps*`.
