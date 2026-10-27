# pricing-service operations

## Run locally

```bash
cd services/pricing-service
docker compose -f docker-compose.dev.yml up -d redis   # Redis (the file also has Redpanda, and Postgres under the db profile; neither is used)
make -C ../.. secrets                                  # .env + INTERNAL_SERVICE_TOKEN
pnpm dev                                               # http://localhost:3004
```

Or from the root: `make infra-up` and `make dev-services` (all services), `make dev-svc SVC=pricing-service` (this one).

For real estimates it needs mapping-service (and OSRM for road distances: `make map-data` once, then `make dev-infra`; see [mapping-service operations](../../mapping-service/docs/operations.md)), platform-service for live fares, location-service for ETAs. Without platform-service, registry default fares apply. Without location-service, ETAs are null. Without mapping-service, estimates fail with 503.

## Test

| Command | What |
|---|---|
| `pnpm test` | `tests/unit/pricing.test.ts`: `price()` (rounding, minimum), estimates with a fake mapping and location client and an in-memory quote store, city fare overrides, route line on the response and each quote, ETA per type, location-service down, a fare change not affecting earlier quotes, internal lookup with token / 401 / 404, outside the service area, unknown type, anonymous caller, public fare card |
| `pnpm lint`, `pnpm typecheck` | ESLint, `tsc --noEmit` |

The tests create a real `ioredis` client pointed at `redis://localhost:1` with `lazyConnect` (because a store is injected); Redis is not needed.

## Build and deploy

- `pnpm build` → `dist/`; `pnpm start`.
- `docker build -f services/pricing-service/Dockerfile -t ride-app/pricing-service .` from the repo root (node:24-alpine, non-root `app`, port 3004, `HEALTHCHECK` on `/health`).
- `make stack-up`: `infra/docker/docker-compose.yml` service `pricing-service` (depends on redis).
- No Kubernetes manifest for this service was found (`infra/k8s/base` is a template).
- Stateless apart from Redis: replicas can be added freely.

## Health endpoints

| Path | Meaning |
|---|---|
| `/health`, `/health/live` | process up |
| `/health/ready` | Redis `PING` = `PONG`; else 503. mapping-, location- and platform-service are not part of readiness |

## Logging

pino (`createLogger("pricing-service", …)`), `LOG_LEVEL` override.

| Level | Message | Meaning |
|---|---|---|
| info | `settings updated` (`version`, `reason`) | new snapshot loaded |
| warn | `settings refresh failed; keeping the current values` | platform-service unreachable |
| warn | `can't subscribe to settings changes; polling only` | Redis subscribe failed |
| warn | `location-service unavailable, no ETA on the quote` | ETA call failed (per vehicle type) |
| error | `unhandled error` | a 500 |

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Estimates → 503 `dependency_unavailable` | mapping-service down, slower than 2.5 s, or answered 404 (no road) / 400 | mapping-service logs and `/health/ready`; try `POST /internal/route` directly |
| All quotes `approximate: true` | OSRM down or not built; mapping-service falls back | mapping-service `/health/ready` → `engines.osrm: "degraded"`; `make map-data` |
| `etaToPickupSeconds: null` everywhere | location-service down, or no available drivers within 6 km | pricing warn log; location-service |
| Fares don't follow the admin change | change still pending approval; or platform-service unreachable | `GET /api/platform/settings/changes?status=PENDING`; `settings refresh failed` |
| Estimate → 400 `unknown_vehicle_type` without asking for a type | an enabled vehicle type in the catalogue has no `fares.<type>.*` keys | [architecture.md](architecture.md#vehicle-types-without-fares) |
| Estimate → 400 `outside_service_area` for a city that exists in the admin | pricing uses the static boxes in `libs/shared-location`, not the admin's city list | |
| trip-service says the quote is gone | quote expired (`quote.ttlSeconds`) or Redis was flushed | `TTL quote:<id>` |
| `/health/ready` 503 | Redis down | |
