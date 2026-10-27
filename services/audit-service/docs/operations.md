# Operations

## Run locally

From `services/audit-service`:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (postgis, POSTGRES_DB=audit_service), Redpanda
pnpm install && make -C ../.. secrets
pnpm prisma migrate dev                           # creates audit_service
pnpm dev                                          # http://localhost:3010
```

The local compose file has no Redis; without `REDIS_URL` the service still runs. With the full stack: `make dev-services` / `make dev-svc SVC=audit-service`, `make db-migrate`. Without `KAFKA_BROKERS` nothing arrives. To see entries, perform a staff action in auth, fleet, payment or platform service with their outbox relays running.

## Tests

| Command | What |
|---|---|
| `pnpm test` | unit tests: none exist (`--passWithNoTests`) |
| `pnpm test:integration` | `tests/integration/audit.test.ts` on a throwaway `audit_service_test` DB (recreated, `prisma migrate deploy`). Covers idempotent inserts, skipping invalid events, refusing UPDATE/DELETE, filters, cursor paging, CSV and its own audit entry, 403 for a dispatcher. Kafka is not needed: tests call `handle()` directly. Needs Postgres (`make infra-up`) |
| `pnpm lint`, `pnpm typecheck` | ESLint, `tsc --noEmit` |

## Build and deploy

- `pnpm build` → `dist/`.
- Image: `docker build -f services/audit-service/Dockerfile -t ride-app/audit-service .` from the repo root. Runtime `node:24-alpine`, user `app`, `EXPOSE 3010`, `HEALTHCHECK` on `/health` every 15 s. Unlike notification-service, the runtime stage does **not** copy `prisma/`, so migrations must be applied from outside the image (`make db-migrate` or a separate job).
- `infra/docker/docker-compose.yml`: `depends_on: [postgres, redpanda]`, port `3010:3010`, `env_file: ../../.env`.
- Database role: the migration creates a function that creates tables, and the service calls it daily. A role limited to INSERT/SELECT (as docs/production/README.md suggests) would make `ensure_audit_partitions` fail unless the function or partitions are managed by a different role.

## Health

| Endpoint | Checks |
|---|---|
| `/health`, `/health/live` | process up |
| `/health/ready` | Postgres `SELECT 1` → 200 / 503 |

Kafka consumption is not in readiness. Watch consumer-group lag for `audit-service` on the admin System page (platform-service).

## Logging

pino, name `audit-service`. Fastify request logs on.

| Message | Level | Meaning |
|---|---|---|
| `consuming audit.recorded` | info | consumer running |
| `KAFKA_BROKERS not set: no audit events arrive` | warn | consumer disabled |
| `Kafka consumer failed to start; audit events wait in Kafka` | error | brokers unreachable at start; restart the service once Kafka is back |
| `skipping invalid audit event` | error | a producer sent something the schema refuses; that entry is lost |
| `partition maintenance failed` | error | `ensure_audit_partitions` failed (permissions, default-partition conflict) |
| `permission matrix refresh failed; keeping the current one` | warn | auth-service unreachable |
| `token check unavailable (Redis)` | warn | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Audit page empty | no `KAFKA_BROKERS`, consumer failed at start, or producers' relays not running | logs above; producer `outbox` rows with `published_at IS NULL` |
| An action is missing from the log | the event failed validation (e.g. `actorId` not a UUID, `action` > 80 chars) | `skipping invalid audit event` log lines |
| Lag growing | database errors make kafkajs retry the same message | Postgres health, error logs |
| 401 `invalid_token` from the dashboard | wrong `AUTH_ISSUER`/`AUTH_JWKS_URL`, or an app token instead of a staff token | env |
| 403 | caller lacks `audit_log:read` (only `SUPER_ADMIN`, `AUDITOR` in the built-in matrix) | role assignments |
| `audit entries are write-once` error | something tried UPDATE or DELETE; expected | — |
| Rows piling up in `audit_entry_default` | partition maintenance not running or failing | `SELECT count(*) FROM audit_entry_default` |
| CSV export slow | 50 000-row cap with filters that don't hit an index (`outcome`, `service` only) | add `from`/`to` or `actorId` |
