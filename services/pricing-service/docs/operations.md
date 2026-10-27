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
- `make stack-up`: `infra/docker/docker-compose.yml` service `pricing-service` (depends on postgres, redis, redpanda; in-network `DATABASE_URL` → `pricing_service`, `KAFKA_BROKERS=redpanda:29092`, `REDIS_URL`, `LOCATION_INTERNAL_URL`, `MAPPING_INTERNAL_URL`, `AUTH_*`, `PLATFORM_INTERNAL_URL`; run `make db-migrate` first).
- Kubernetes: `infra/k8s/base/pricing-service.{deployment,service,hpa}.yaml` (port 3004, 2–6 replicas, `envFrom` ConfigMap `pricing-service-config` + Secret `pricing-service-secrets`; `DATABASE_URL` and `INTERNAL_SERVICE_TOKEN` go in the Secret, `KAFKA_BROKERS` — required in production — and the `*_INTERNAL_URL`s in the ConfigMap). Run `prisma migrate deploy` before a rollout. See `infra/docs/kubernetes.md`.
- State is in Postgres (rules, zones, promos, outbox) and Redis (quotes): replicas can be added freely.

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
| warn | `token check unavailable (Redis)` | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |
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
| Every authenticated call → `503 auth_unavailable` (`retry-after: 5`) | Redis down: the deny-list / `pv` lookup fails, so the token is refused as temporarily unchecked | warn `token check unavailable (Redis)`; `/health/ready` |

## Workflow 15 (added)

Run locally now needs Postgres too: `docker compose -f docker-compose.dev.yml up -d postgres redis` (the `db` profile is gone; database `pricing_service`), `make secrets` (adds `DATABASE_URL`, `KAFKA_BROKERS`, … to an existing `.env`), then `pnpm exec prisma migrate deploy` (or `make db-migrate`, which includes pricing-service).

| Command | What |
|---|---|
| `pnpm test` | unit: `tests/unit/pricing.test.ts` (unchanged behaviour with the empty catalog) and `tests/unit/workflow15.test.ts` (geometry, zone effects, surge + airport fee, promo discounts, impact preview) |
| `pnpm test:integration` | `tests/integration/pricing.test.ts` on a recreated `pricing_service_test` database and its own Redis container `anbessa-test-redis-pricing` on port **6398** (started and stopped by the suite; `TEST_REDIS_URL` / `TEST_DATABASE_URL` override). Zones (validation, scoping, idempotency, versioning, effect on quotes), fare changes (maker–checker, 24 h notice, scheduled activation, quotes keep their price, emergency, reject/withdraw/expire), promos (activation threshold, discounted quotes, booking, redemption and exhaustion via the trip event handler, cancellation release, pause, expiry) |

Failure modes:

| Situation | Effect |
|---|---|
| Postgres down at start | estimates `503 dependency_unavailable` until the catalog loads; readiness 503 |
| Postgres down later | estimates keep using the last catalog (warning `pricing catalog reload failed`); promo codes fail (500) |
| Kafka down | events wait in `outbox`; trip events wait in Kafka; promo reservations stay BOOKED (expire after 24 h if never redeemed) |
| Redis `pricing:catalog_changed` lost | other replicas pick the change up within 60 s |

Useful queries: pending fare changes `SELECT * FROM fare_change_request WHERE status='PENDING'`; promo burn `SELECT code, spent_minor, budget_minor, redemption_count FROM promo WHERE status='ACTIVE'`; unpublished events `SELECT count(*) FROM outbox WHERE published_at IS NULL`.
