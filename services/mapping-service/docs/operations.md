# mapping-service operations

## Run locally

```bash
cd services/mapping-service
docker compose -f docker-compose.dev.yml up -d redis   # optional cache (the file also defines Redpanda, unused, and Postgres under the db profile)
make -C ../.. secrets                                  # .env + INTERNAL_SERVICE_TOKEN
pnpm dev                                               # http://localhost:3007
```

### Real routing and geocoding

```bash
make map-data    # once: Ethiopia extract (~140 MB) + OSRM graph (about 10 minutes, ~4 GB RAM)
make dev-infra   # OSRM :5000, Nominatim :8080, TileServer :8081 (foreground)
```

Nominatim imports the extract on its first start, which is slow (`infra/mapping-stack/README.md`). To start only OSRM: `docker compose -f infra/mapping-stack/docker-compose.mapping.yml up osrm`. Re-run `make map-data` after replacing `region.osm.pbf` with a newer extract (the script only downloads when the file is missing).

Without the engines the service still runs: route and table answer with `approximate: true`, snap returns the input point, search and reverse return `503`.

Quick checks (with `$T` = the internal token):

```bash
curl -s localhost:3007/health/ready
curl -s -XPOST localhost:3007/internal/route -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"points":[{"lat":8.9806,"lng":38.7578},{"lat":9.0349,"lng":38.7469}],"geometry":true}'
curl -s 'localhost:5000/route/v1/driving/38.7578,8.9806;38.7469,9.0349?overview=false'   # OSRM directly
```

## Test

| Command | What |
|---|---|
| `pnpm test` | `tests/unit/maps.test.ts` runs the real app against a local HTTP server that answers like OSRM v1 and Nominatim jsonv2: lng,lat order and rounding, cache hits for points ~1 m apart, geometry, steps cached separately, fallback polyline without steps, no road → 404, OSRM down → approximate, not cached, breaker opens, slow OSRM cut by the timeout, table indexes, service-area and table-size limits, service token, city viewbox search, reverse and snap for app and staff tokens, public route with steps, 503 when geocoding is down, rate limit per user |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | |

No Redis or engine is needed for the tests (an in-memory cache is injected).

## Build and deploy

- `pnpm build` → `dist/`; `pnpm start`.
- `docker build -f services/mapping-service/Dockerfile -t ride-app/mapping-service .` from the repo root (node:24-alpine, non-root, port 3007, `HEALTHCHECK` on `/health`).
- `make stack-up` runs it from `infra/docker/docker-compose.yml` with the root `.env`; that compose has no `depends_on` for it and does not start the engines.
- No Kubernetes manifest for this service was found.
- Replicas are independent; each has its own breakers. The cache is shared through Redis.

## Health endpoints

| Path | Meaning |
|---|---|
| `/health`, `/health/live` | process up |
| `/health/ready` | always 200, with `engines.osrm` / `engines.nominatim` = `ok` or `degraded` (breaker open). Redis is not checked |

platform-service's system page shows mapping-service as `degraded` when that body contains `"degraded"`, and shows the `engines` object under integrations → routing.

Because readiness never fails, an orchestrator will keep sending traffic while the engines are down; that is intentional (comment in `src/app.ts`).

## Logging

pino (`createLogger("mapping-service", …)`).

| Level | Message | Meaning |
|---|---|---|
| warn | `osrm unavailable, using straight-line estimate` (`op`, `err`) | a route/table/snap fallback |
| warn | `map engine unavailable` (`engine`, `reason`) | a 503 to the caller |
| warn | `REDIS_URL not set: map results are not cached` | start without cache |
| error | `unhandled error` | a 500 |

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Every route `approximate: true` | OSRM not running, graph not built, wrong `OSRM_URL`, or slower than `ENGINE_TIMEOUT_MS` | `/health/ready`; curl OSRM directly; `make map-data` |
| `degraded` for 10 s at a time | 3 consecutive OSRM failures opened the breaker | warn logs |
| Route → 404 | OSRM has no road between the points (e.g. a point far from any road) | try `/api/maps/snap` first |
| Table → 503 for some points | OSRM answered `NoRoute` or another code for the table (tables have no 404 mapping) | OSRM directly |
| Search/reverse → 503 | Nominatim down, still importing, or breaker open | Nominatim container logs |
| Search → 400 `unknown city` | `cityId` not in `libs/shared-location` `CITIES` (only `addis-ababa`, `hawassa`) | |
| 400 `outside_service_area` | a point outside Ethiopia's box | |
| 429 on `/api/maps/*` | over 60 requests / minute for one user | |
| High engine load | no `REDIS_URL`, or Redis down (errors are silent misses) | Redis `KEYS map:*` / `INFO` |
| A suspended user can still search | user tokens are verified without the deny list here | [architecture.md](architecture.md#security-model) |
