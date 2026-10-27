# location-service: operations

## Run locally

| Way | Commands | Notes |
|---|---|---|
| Alone | `docker compose -f docker-compose.dev.yml up -d` (Redis 6379, Redpanda 9092), `pnpm install`, `make -C ../.. secrets`, `pnpm dev` | http://localhost:3003. `tsx watch --conditions=development` loads `libs/*` from TypeScript source, so lib edits hot-reload |
| With everything | `make infra-up` then `make dev-services` from the repo root | all services in watch mode (turbo, `--concurrency=32`) |
| One service from the root | `make dev-svc SVC=location-service` | |
| Without Kafka | leave `KAFKA_BROKERS` blank; put drivers online with `POST /internal/dev/drivers/:id/online` (development only, see [api.md](api.md)) | the sweeper still runs; lost drivers are not reported |

Port 3003 must be free. If another project already owns Redis on 6379 on your machine, point `REDIS_URL` at another instance; realtime-gateway and trip-service must use the **same** Redis, or pings and matching won't see each other.

## Test

| Command | What |
|---|---|
| `pnpm test` | unit tests outside `tests/integration` (`--passWithNoTests`; there are none in this service today) |
| `pnpm test:integration` | `tests/integration/location.test.ts` against a throwaway Redis container `anbessa-test-redis` on port **6392** (needs Docker; `tests/integration/global-setup.ts`). Set `TEST_REDIS_URL` to use another *dedicated* instance: the suite runs `FLUSHDB` before every test. Mapping is faked; JWTs are signed with a local ES256 key |
| `pnpm --filter @ride-app/shared-location test` | unit tests of ping checks, distances and key guards (`libs/shared-location/tests/geo.test.ts`) |
| `pnpm lint` / `pnpm typecheck` | ESLint on `src`; `tsc --noEmit` against lib sources |

Integration coverage (test names): geo index and nearest-first, offline/implausible pings ignored, vehicle-type, cash and offer filters, balance state per beneficiary, vehicle-type switch, sweeper 20 s / 10 min / on-trip / lock, trip members and `trip:{id}:last`, 404 for strangers and fleet-owner access, invalid events, ETA with and without mapping-service, public nearby cars, access control, dev routes.

## Build and deploy

- `pnpm build` → `dist/` (`tsc`). Build workspace libs first (`pnpm turbo run build --filter=@ride-app/location-service...`).
- Docker, from the repo root: `docker build -f services/location-service/Dockerfile -t ride-app/location-service .` Two stages on `node:24-alpine`; runtime runs as user `app`, `NODE_ENV=production`, `EXPOSE 3003`, `CMD node dist/server.js`, Docker `HEALTHCHECK` on `/health` every 15 s.
- Kubernetes: `infra/k8s/base` is a template shown for trip-service (Deployment, Service, HPA 2–10 on CPU 70%); copy it per service. No location-service manifest exists in the repo.
- Kafka topics must exist in production (auto-creation is off when `NODE_ENV=production`).

## Scaling

- **Stateless replicas.** Any number can run: state is in Redis, the Kafka consumer group splits partitions between replicas, and the sweeper lock (`lock:sweep:{city}`) lets only one replica sweep a city per round.
- **Redis is the bottleneck and the single point of failure.** Every ping (gateway) and every nearby query hit it. Keys are hash-tagged per city for a future cluster; note that the code uses non-tagged keys too (`driver:{id}`, `location:cities`), and the ping pipeline touches both, which is fine for pipelines but not for multi-key commands in a cluster.
- The sweeper loops over every city sequentially, one `HGETALL` and one pipeline per stale driver, every 5 s.
- The public nearby route does one `GEOSEARCH` plus a pipeline per vehicle type of the city, and one mapping call, per request.

## Health

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /health` | process up | Docker `HEALTHCHECK`, k8s template probes |
| `GET /health/live` | same | |
| `GET /health/ready` | Redis answers `PING` (else 503) | platform-service system page (`SERVICE_URLS`) |

Kafka health isn't part of readiness. Consumer lag for group `location-service` is shown on the admin system page (platform-service).

## Logging

pino, logger name `location-service` (`libs/shared-utils/src/logger.ts`): JSON in production at `info`, `pino-pretty` elsewhere at `debug`; `LOG_LEVEL` overrides. Fastify request logging uses the same logger. Useful messages:

| Message | Level | Meaning |
|---|---|---|
| `KAFKA_BROKERS not set: driver/trip events are not consumed …` | warn | started without Kafka |
| `consuming events` | info | consumer running, lists topics |
| `skipping invalid event` | error | bad JSON or schema; topic/partition/offset logged |
| `mapping-service unavailable, estimating ETA` | warn | ETA fallback |
| `could not report lost driver` | error | `driver.connection_lost` publish failed |
| `sweep failed` | error | a sweep round threw (Redis) |
| `permission matrix updated` / `… refresh failed; keeping the current one` | info / warn | authz sync |
| `unhandled error` | error | 500 answered |

There are no metrics endpoints in code.

## Failure modes and diagnosis

| Symptom | Likely cause | Check |
|---|---|---|
| Driver streams but never appears in matching | no `driver.online` applied (Kafka down, fleet-service not publishing, invalid event) → pings ack `not_online` | `HGETALL driver:<id>`; logs for `skipping invalid event`; consumer lag |
| Driver appears on the ops map but not in `/internal/drivers/nearby` | `stale`, `on_trip`, offer lock (`EXISTS offer:driver:<id>`), `balanceState=BLOCKED`, cash filter, or the phone clock is > 20 s slow (freshness uses the device `at`) | `HGETALL driver:<id>`, compare `at` with server time |
| Driver stuck `on_trip` after the trip ended | `trip.completed` without `driverId`, or processed before `trip.matched` | `HGET driver:<id> tripId`; trip-service outbox |
| Nearby/ETA calls return 500 | Redis down, or `cityId`/`vehicleType` not matching the key format (uppercase, spaces) | logs `unhandled error` |
| Quotes show "approximate" ETAs | mapping-service slow (> 2.5 s) or down | mapping-service health |
| Drivers never auto-ended after losing signal | Kafka not configured, or fleet-service not consuming `driver.connection_lost` | logs, consumer lag of fleet-service |
| Rider gets 404 on the trip position | not a member yet (Kafka lag after the match), no ping since the match, or > 5 min after the trip ended | `SMEMBERS trip:<id>:members`, `HGETALL trip:<id>:last` |
| Staff get 403 on the ops map | no `location:read_live` for that city in the current matrix | role assignments; authz sync logs |
