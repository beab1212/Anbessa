# platform-service operations

## Run locally

Alone (from `services/platform-service`):

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (postgis 18) + Redpanda; no Redis
pnpm install                                      # runs prisma generate
make -C ../.. secrets                             # .env, INTERNAL_SERVICE_TOKEN from auth-service
pnpm prisma migrate dev                           # or: pnpm exec prisma migrate deploy
pnpm dev                                          # tsx watch, http://localhost:3011
```

With the whole system (repo root): `make infra-up` (Postgres, Redis, Redpanda from `infra/docker/docker-compose.yml`), `make db-migrate` (runs `prisma migrate deploy` for every service in `PRISMA_SERVICES`, platform-service included), then `make dev-services`. `make dev-gateway` puts Kong on `:8000` in front of them.

The local compose file has no Redis. Without `REDIS_URL`, the service logs `REDIS_URL not set: services pick up settings changes on their next poll (≤ 30 s)` and runs.

On start the service needs auth-service for the city sync. If auth-service is down it logs `city sync with auth-service failed; retrying in 30 s` and still starts.

## Test

| Command | What |
|---|---|
| `pnpm test` | Unit tests outside `tests/integration` (none exist today; `--passWithNoTests`) |
| `pnpm test:integration` | `vitest.integration.config.ts`: drops and recreates `platform_service_test`, runs `prisma migrate deploy`, then the real app with a fake auth-service and a captured publisher. Needs Postgres on `localhost:5432` (`make infra-up`) |
| `pnpm lint`, `pnpm typecheck` | ESLint on `src`, `tsc --noEmit` |

The integration tests (`tests/integration/platform.test.ts`) cover: direct vs. approved changes, history, audit events, publish; validation of values, city overrides and unknown keys/cities; permissions (dispatcher refused, auditor read-only, internal route needs the token); city seed and sync (and nothing saved when auth-service is down); vehicle types and flags in client-config; announcement windows and audiences; the system page reporting an unreachable service.

## Build and deploy

- `pnpm build` → `tsc` into `dist/`; `pnpm start` → `node dist/server.js`.
- Docker: `docker build -f services/platform-service/Dockerfile -t ride-app/platform-service .` from the repo root. Multi-stage on `node:24-alpine`, `pnpm deploy --prod`, runs as user `app`, exposes 3011, `HEALTHCHECK wget http://localhost:3011/health`.
- The image does not run migrations. Run `prisma migrate deploy` before starting a new version (no migration job was found in `infra/`).
- `make stack-up` runs it in `infra/docker/docker-compose.yml` (depends on postgres, redis, redpanda) with the root `.env`.
- Kubernetes: `infra/k8s/base` contains only a template (written for trip-service); no platform-service manifest was found.
- Several replicas are safe for the outbox relay (`SKIP LOCKED`). The hourly expiry and the seed run in every replica; both are idempotent. The system-page cache is per replica.

## Health endpoints

| Path | Meaning |
|---|---|
| `/health` | process up (used by the Docker `HEALTHCHECK`) |
| `/health/live` | process up |
| `/health/ready` | `SELECT 1` on Postgres; `503 { status: "unavailable" }` otherwise. Redis and Kafka are not part of readiness |

## Logging

pino via `createLogger("platform-service", NODE_ENV)` from `libs/shared-utils`; `LOG_LEVEL` overrides the level. Fastify request logs use the same logger. Messages worth knowing:

| Level | Message | Meaning |
|---|---|---|
| info | `cities synced with auth-service` | seed + sync done |
| warn | `city sync with auth-service failed; retrying in 30 s` | auth-service unreachable or refused |
| warn | `REDIS_URL not set: …` / `KAFKA_BROKERS not set: audit events stay in the outbox table` | optional dependency missing (development) |
| warn | `couldn't publish settings:changed; services pick it up on their next poll` | Redis publish failed after a commit |
| warn | `outbox relay: publish failed, will retry` | Kafka unreachable |
| warn | `token check unavailable (Redis)` | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |
| error | `settings approval expiry failed` | the hourly job failed |
| error | `unhandled error` | a 500, with the request id |

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| A change applies but a service still uses the old value for up to 30 s | Redis publish failed or the service has no Redis subscription | `couldn't publish settings:changed` in logs; `PUBLISH`/`SUBSCRIBE` on `settings:changed` |
| A service never sees changes | it can't reach `/internal/settings/snapshot` (wrong `PLATFORM_INTERNAL_URL` or token) | its log `settings refresh failed; keeping the current values` |
| `POST/PUT /cities` → 503 | auth-service down or answering non-2xx | auth-service `/health/ready`, `AUTH_INTERNAL_URL`, token |
| `audit.recorded` missing in audit-service | relay not running or Kafka down | `SELECT count(*) FROM outbox WHERE published_at IS NULL`; System page "outbox" |
| `PUT /settings/:key` → 409 `change_pending` | another sensitive change for the same key and city is waiting | `GET /api/platform/settings/changes?status=PENDING` |
| Approve → 409 `expired` | older than 7 days; the hourly job may not have marked it yet | create a new request |
| Every staff call → 401 | JWKS unreachable, wrong `AUTH_ISSUER`, or token audience is not `ride-admin` | |
| Every staff call → 403 for a super admin | permission matrix not loaded or changed in auth-service | `authz` sync logs |
| System page slow | each check waits up to 2–4 s; Kafka admin can take longer | use the cached result (10 s) |
| Start fails with a zod error | missing `DATABASE_URL`/`INTERNAL_SERVICE_TOKEN`, or `REDIS_URL`/`KAFKA_BROKERS` missing in production | |
| New announcement takes up to about a minute to show in the phone app | the app refetches the client config every 60 s (and on resume; the response may be cached 15 s). Announcements don't change `version`, but the app also compares the announcement list (id/title/body), so it no longer waits for a restart (fixed 2026-10-27) | see [architecture.md](architecture.md#client-configuration); `apps/phone-app/lib/features/config/client_config_provider.dart` |
