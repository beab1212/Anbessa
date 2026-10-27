# Operations

## Run locally

From `services/support-service`:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (support_service), Redis, Redpanda
pnpm install && make -C ../.. secrets
pnpm exec prisma migrate deploy
pnpm dev                                          # http://localhost:3009
```

With the whole stack: `make dev-services` (or `make dev-svc SVC=support-service`) after `make db-migrate`. auth-service and trip-service must run for tokens and trip facts. The web pages call `/api/support` through Vite's proxy (`SUPPORT_URL`) or Kong (`make dev-gateway`).

## Tests

| Command | What |
|---|---|
| `pnpm test` | `tests/unit/policy.test.ts`: SLAs, overdue, every state machine, reopen / report / SOS windows |
| `pnpm test:integration` | `tests/integration/support.test.ts` on a throwaway `support_service_test` DB (dropped and re-migrated each run). The global setup also starts its own Redis container `anbessa-test-redis-support` on **port 6396** and stops it afterwards (set `TEST_REDIS_URL` to use your own). trip-service is a fake; Kafka isn't needed (events are read from the outbox, the consumer's `handle()` is called directly). Needs Postgres (`make infra-up`) and Docker |
| `pnpm lint`, `pnpm typecheck` | ESLint on `src` and `tests`, `tsc --noEmit` |

The integration suite covers:
- **Tickets:** visibility (404), city scoping, SLA and P1 SAFETY with its incident, internal notes, first response, waiting → in progress, resolve / reopen windows, call-center tickets with audit and idempotency, filters (`#ref`, text, overdue, assignee, status list), refund links and the refund consumer, the 72 h and 7-day timers.
- **Lost items:** the full flow with driver, fleet and staff; the 7-day window; the not-found counter; the 48 h close.
- **SOS:** dedupe and the 2-minute window; the city queue; dispatchers acknowledge but can't resolve; safety officers resolve; the 30-minute window; strangers get 404; accepted unverified when trip-service is down; the Redis deny list.
- **Incidents:** opened from SOS, ticket and by hand; patch, notes, actions, resolve; the legal-hold triggers.
- **Internal:** `/internal/ops/outbox`.

## Build and deploy

- `pnpm build` → `dist/`. Image: `docker build -f services/support-service/Dockerfile -t ride-app/support-service .` from the repo root (node:24-alpine, user `app`, `EXPOSE 3009`, `HEALTHCHECK` on `/health`). The runtime image has no Prisma CLI: run migrations with `make db-migrate` or a separate job.
- `infra/docker/docker-compose.yml`: `support-service`, port `3009:3009`, depends on postgres, redis, redpanda.
- Kong: `/api/support` (`infra/kong/kong.yml`).

## Health and monitoring

| Signal | Where |
|---|---|
| `/health/ready` | `SELECT 1` |
| Outbox backlog | `GET /internal/ops/outbox`, platform-service System page |
| Consumer lag | group `support-service`, System page |
| Logs | `SOS triggered` (warn, with alert id and city), `SOS accepted without trip-service (unverified)`, `sweep` (info, counts), `skipping invalid event` |

Metrics to add (workflow 13 §10, 14 §10): SLA breach rate per category, time to acknowledge (p95 < 60 s), false-alarm rate, lost-item return rate. Until then, query the tables.

## Failure modes

| Symptom | Cause | What happens |
|---|---|---|
| `503 dependency_unavailable` on ticket / lost-item create | trip-service down | client retries; SOS with `cityId` is still accepted (`tripVerified: false`) |
| `503 auth_unavailable` | Redis lookup failed | client retries after 5 s |
| Staff don't see a new SOS | web not polling, or the officer has no `sos:respond` in that city | check `GET /api/support/sos?cityId=` |
| Events not in Kafka | `KAFKA_BROKERS` unset or Kafka down | rows wait in `outbox` (`published_at IS NULL`) |
| Refund status stays REQUESTED | consumer not running / wrong refund id linked | link the id payment-service returned |
| `DELETE` fails on SOS / incident tables | legal-hold trigger | intended; there is no delete path |
