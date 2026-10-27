# Operations

Running, testing, building and troubleshooting payment-service. Repo-wide setup is in [docs/development](../../../docs/development/README.md).

## Run locally

Needs Postgres 18 (for `uuidv7()`), Redis and Kafka/Redpanda; auth-service and platform-service for tokens, the permission matrix and settings (the service still starts without the last two, on built-in defaults).

From the repo root:

```bash
make infra-up       # Postgres, Redis, Redpanda (infra/docker/docker-compose.yml)
make secrets        # services/payment-service/.env from .env.example; fills the three webhook secrets and INTERNAL_SERVICE_TOKEN
make db-migrate     # prisma migrate deploy for every Prisma service, payment-service included
make dev-services   # every service, or: make dev-svc SVC=payment-service
```

Or only this service's infrastructure: `docker compose -f services/payment-service/docker-compose.dev.yml up -d` (Postgres with database `payment_service`, Redis, Redpanda), then `pnpm dev` in `services/payment-service` (`tsx watch`, loads `.env`).

At start the log shows `payment providers are SIMULATED` (warn), plus warnings if `REDIS_URL` or `KAFKA_BROKERS` are missing.

### Trying a payment by hand

1. Complete a mobile money or card trip (or publish a `trip.completed` to Kafka).
2. With `SIM_AUTO_APPROVE_SECONDS=0`, open the payment's `checkoutUrl` (`GET /api/payments/trips/{tripId}` as the rider, or the web payments page) and choose Pay, Decline or Insufficient funds. With `SIM_AUTO_APPROVE_SECONDS=8` (the `.env.example` value) it approves itself after 8 s.
3. A payout destination ending in `0000` fails, to see a reversal.
4. `SIM_DROP_WEBHOOKS=0.5` drops half the callbacks; the reconcile job recovers them after `RECONCILE_AFTER_SECONDS`.

The `seed:dev` script in `package.json` points at `src/dev/seed.ts`, which does not exist.

## Tests

| Command | What runs |
|---|---|
| `pnpm test` (or `make test-svc SVC=payment-service`) | unit tests, `tests/unit/**` (vitest, integration excluded) |
| `pnpm test:integration` | `vitest.integration.config.ts`: `tests/integration/**/*.test.ts`, files serially, 30 s per test |
| `pnpm typecheck`, `pnpm lint` | `tsc --noEmit`, eslint on `src` |

**Unit** (no infrastructure):

| File | Covers |
|---|---|
| `tests/unit/rules.test.ts` | commission (percentage with minimum, fixed, zero), trip money for card and cash, VAT on commission or full fare, balance states through the limits, overdue blocking, prepaid, suggested top-up, payment dues and their status, Addis dates |
| `tests/unit/consumer.test.ts` | event schemas: a `CORPORATE` `trip.completed` or `trip.cancelled` without `billingOrgId` is invalid (never settled as cash); with it, or a cash trip, passes |
| `tests/unit/gateways.test.ts` | reference round trip (with attempts), each provider's callback format read back by its adapter, tampered or wrongly signed callbacks refused, simulator auto-approval, payout delay and the `0000` failure |

**Integration** (`tests/integration/payments.test.ts`, `tests/integration/reports.test.ts`): `global-setup.ts` drops and recreates `payment_service_test` (refuses a database name not ending in `_test`) and runs `prisma migrate deploy`. `harness.ts` builds the real app and container with a test clock, the in-process simulator whose callbacks are injected into the app's webhook route (signatures included), static settings, a local ES256 key set for tokens, and recorded realtime pushes. Kafka is not used: tests call `onTripCompleted` / `onTripCancelled` directly. Needs Postgres reachable at `TEST_DATABASE_URL`.

`reports.test.ts` covers a fleet's earnings (totals, per day and per driver, cash-trip net, other org / fleet driver / corporate admin / city staff 403, finance allowed), a company's corporate charges (`owedMinor`, newest first, keyset paging, permissions) and the finance daily report and CSV (settlements by method, fees, collections, refunds, payouts, top-ups per Addis day, city filter, `report:read_finance` only, default 7-day range). Each test uses its own city or org ids, since the database is shared by the files.

| Area | Tests |
|---|---|
| Settlement | cash (commission + VAT owed; replay settles once); card (approval at the provider, callback credits the driver; replays and forged callbacks do nothing); corporate (company receivable, driver credited at once); cash cancellation fee (rider receivable, driver compensated) |
| Earnings | today's totals by day; only the driver may read them |
| Balance limits | cash trips pause cash; a card trip repays and lifts it |
| Declined charges | retried, then a rider receivable; paying later collects it; a lost callback recovered by reconciliation |
| Top-ups | `open=false` only reads and creates no account; mobile money via callback, retried request returns the same top-up (idempotency); office cash maker–checker |
| Refunds | requested by support, approved by finance, charged to the driver when at fault |
| Settlement and payouts | positive balances paid after a second person approves; negative balances get a due that blocks when overdue |
| Rules | operations proposes, finance approves, the next trip uses the new rule |
| Access | owners see their own balance, fleets theirs, others get 404, finance lists; the ledger balances and `UPDATE`/`DELETE` on the ledger fail |

Not covered by tests: the Kafka consumer (only its schemas, in `tests/unit/consumer.test.ts`) and outbox relay against a real broker, the HTTP gateway mode (doesn't exist), Redis-backed paths (deny list, realtime emitter, Redis sim store), the jobs scheduler itself.

## Build and deploy

`Dockerfile` (build from the repo root: `docker build -f services/payment-service/Dockerfile -t ride-app/payment-service .`):

1. `base`: `node:24-alpine`, corepack (pnpm).
2. `build`: `pnpm fetch`, copy the repo, `pnpm install --frozen-lockfile --offline --filter @ride-app/payment-service...` (runs `prisma generate` via `postinstall`), `pnpm --filter @ride-app/payment-service... build` (`tsc`), `pnpm deploy --prod --legacy /out`.
3. `runtime`: `node:24-alpine`, `NODE_ENV=production`, non-root user `app`, `node_modules` + `dist` + `package.json`, `EXPOSE 3005`, `HEALTHCHECK` every 15 s (`wget http://localhost:3005/health`, 3 s timeout), `CMD node dist/server.js`.

Migrations are not run by the container; run `prisma migrate deploy` with the service's `DATABASE_URL` before starting a new version. In `infra/docker/docker-compose.yml` (`make stack-up`) the service reads the root `.env`.

Several replicas can run: the outbox relay uses `SKIP LOCKED`, Kafka partitions are shared by the consumer group, and the jobs use conditional updates. Every replica runs every job.

## Health

| Endpoint | Checks | Use |
|---|---|---|
| `GET /health` | nothing | Docker `HEALTHCHECK` |
| `GET /health/live` | nothing | liveness |
| `GET /health/ready` | `SELECT 1` on Postgres; lists gateways and their mode | readiness, platform-service system page |

Not checked by any health endpoint: Redis, Kafka, auth-service, platform-service. For those, look at the logs and at platform-service's system page (`/internal/ops/outbox`, `/internal/ops/integrations`).

## Logging

pino via `libs/shared-utils` (`createLogger("payment-service", NODE_ENV)`): JSON in production, `pino-pretty` otherwise; level `LOG_LEVEL` or `info`/`debug`. Fastify request logs use the same logger (with request ids). Useful messages:

| Level | Message | Meaning |
|---|---|---|
| warn | `payment providers are SIMULATED: no real money moves` | at start, simulated mode |
| warn | `REDIS_URL not set…`, `KAFKA_BROKERS not set…` | at start, dev without Redis / Kafka |
| error | `Kafka consumer failed to start; trips won't be settled until it does` | consumer start failed; the service keeps running without it |
| error | `skipping invalid event` | a Kafka message failed JSON/zod validation and was skipped |
| warn | `outbox relay: publish failed, will retry` | Kafka unreachable from the relay |
| warn | `charge could not start; trying again soon` | provider unreachable for a charge (retried in 30 s) |
| warn | `top-up charge could not start` | the top-up was marked `FAILED` |
| warn | `payout could not be sent; reversed` | provider unreachable for a payout |
| warn | `refund request to the provider failed…` | refund stays `PROCESSING` |
| error | `provider reported a different amount; not applied` | callback amount ≠ payment amount |
| error | `a second capture arrived for a paid payment; refund it` | the rider paid twice (an old prompt approved late) |
| warn | `webhook rejected` | bad signature / format |
| info | `reconciliation applied provider results that never arrived by callback` | lost callbacks recovered (`fixed` count) |
| info | `payment dues are overdue; those balances are blocked` | overdue sweep |
| info | `weekly settlement prepared; waiting for a finance manager` | Monday batch created |
| error | `LEDGER INTEGRITY CHECK FAILED` | hourly integrity check found a mismatch |
| error | `job failed` (with `job`) | a background job threw |
| warn | `settings refresh failed; keeping the current values` | platform-service unreachable |
| warn | `token check unavailable (Redis)` | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |

## Metrics

No metrics endpoint or metrics library in the code (not found in code). Operational numbers are available from `GET /api/payments/overview`, `GET /api/payments/gateways`, `GET /api/payments/ledger/integrity` and the two `/internal/ops/*` routes.

## Job schedule

| Every | Job | Notes |
|---|---|---|
| 500 ms | outbox relay | only with `KAFKA_BROKERS` |
| 15 s | `charges` | due retries and interrupted charges (50 per run) |
| 1 min | `reconcile` | providers queried for operations open longer than `RECONCILE_AFTER_SECONDS` (50 per kind per run) |
| 5 min | `dues-and-rules` | overdue dues (200 per run), proposal expiry, policy start recompute |
| 10 min | `weekly-settlement` | Mondays (Addis date) with `SETTLEMENT_SCHEDULE=weekly` |
| 5 min | `money-controls` | expire undecided adjustments / write-offs / overrides / incentives; recompute balances whose override window opened or closed; close and pay incentive programs whose window ended (20 per run) |
| 1 h | `ledger-integrity` | |
| 24 h | idempotency purge | first run 24 h after start |
| 30 s | settings and authz poll | plus Redis pub/sub |

All intervals start at process start (not wall-clock aligned). The weekly batch is created on the first `weekly-settlement` tick that falls on a Monday Addis date, i.e. within 10 minutes after 00:00 Addis if the service is up; if the service is down all Monday, that week has no scheduled batch (finance can still run it).

## Failure modes and diagnosis

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Trips complete but nothing settles | consumer not running (no `KAFKA_BROKERS`, start failure, or a message failing every time) | logs for `Kafka consumer failed to start` / handler errors; consumer group `payment-service` lag (platform-service system page shows Kafka lag); `inbox` has the `eventId` once processed |
| Events don't reach notification / location | relay can't publish | `GET /internal/ops/outbox` (`pending`, `oldestAt`); logs `outbox relay: publish failed` |
| Payment stuck in `ACTION_REQUIRED` | callback lost or rejected; rider never approved | `GET /api/payments/gateways` (recent callbacks, `signatureOk`, outcome); `POST /api/payments/payments/{id}/reconcile`; the reconcile job runs every minute after `RECONCILE_AFTER_SECONDS` |
| Payment stuck in `RETRY_SCHEDULED` with `the provider is unreachable` | provider calls throw | retried every 30 s without counting an attempt, indefinitely |
| Payment `RETRY_SCHEDULED`, provider `none` | no enabled provider for the method | `PAYMENT_PROVIDERS`, settings `payments.mobileMoneyProviders` / `payments.cardProvider` |
| Callbacks answered 401 | wrong webhook secret, or body changed in transit | `webhook_event` rows with `signature_ok = false` and `outcome` = reason; secrets must match the provider's (or the simulator's, i.e. the same `.env`) |
| Callbacks answered 500 | handler error (database) | the `webhook_event` row stays unprocessed; `GET /api/payments/gateways` `webhooks.unprocessed`; the provider's redelivery (or reconciliation) applies it later |
| `amount_mismatch` outcome | provider amount ≠ ours | not applied; investigate the provider record; the payment stays open |
| Rider charged twice | an earlier attempt approved after a later one captured | error log `a second capture arrived…`; refund it from the payments page |
| Driver can't go online (`balance_blocked`) | state `BLOCKED`: hard limit, prepaid minimum, or an `OVERDUE` due | `GET /api/payments/balances/{accountId}` (state, dues, policy); a top-up of at least the due's minimum lifts an overdue block |
| Balance state didn't change after a policy approval | recompute runs at approval (now) or when `valid_from` passes (5-minute job) | wait for the job, or check the policy's `valid_from`; any posting also recomputes |
| Refund stuck in `PROCESSING` | provider call failed at approval | reconciliation queries it; with the simulator, a refund whose call failed has no stored operation, so the query returns nothing and it stays `PROCESSING` |
| Payout line `FAILED` | provider refused or unreachable | reversed automatically (`PAYOUT_REVERSAL`); `payout.failed` sent; fix the payout method and wait for the next batch |
| Batch stuck in `SENDING` | a line is still `SENT` | the reconcile job queries `SENT` lines; check the line's `failure` |
| `LEDGER INTEGRITY CHECK FAILED` | cached `balance_minor` ≠ Σ postings, or total ≠ 0 | `GET /api/payments/ledger/integrity` lists up to 50 mismatched account codes. Postings can't be edited (triggers), so a mismatch means `ledger_account.balance_minor` was changed outside `post()`. Correct with new journal entries, never by editing postings |
| Startup fails with a zod error | invalid or missing env var | the message names the variable; see [configuration.md](configuration.md). With `NODE_ENV=production` the service never starts (simulated gateways are refused) |
| `make stack-up`: payment-service exits | the root `.env.example` has no `*_WEBHOOK_SECRET` values and its `DATABASE_URL` points at `ride_app` | provide the payment-service variables in the root `.env` |
| 409 `request_in_progress` | same `Idempotency-Key` sent while the first request is running | retry later with the same key |

### Useful queries

```sql
-- unpublished events
SELECT topic, count(*), min(created_at) FROM outbox WHERE published_at IS NULL GROUP BY topic;
-- callbacks not processed
SELECT provider, event_key, received_at FROM webhook_event WHERE processed_at IS NULL ORDER BY received_at;
-- open charges
SELECT id, provider, status, attempts, next_attempt_at, last_error FROM payment
WHERE status IN ('PENDING','ACTION_REQUIRED','RETRY_SCHEDULED') ORDER BY updated_at;
-- a balance and its recent postings
SELECT a.code, a.balance_minor, b.state FROM beneficiary b JOIN ledger_account a ON a.id = b.account_id WHERE b.owner_id = '<uuid>';
SELECT p.created_at, p.amount_minor, e.kind, e.memo FROM posting p JOIN journal_entry e ON e.id = p.journal_entry_id
WHERE p.account_id = '<account uuid>' ORDER BY p.created_at DESC LIMIT 20;
```

### Money controls

| Symptom | Where to look |
|---|---|
| An approval answers `409 limit_exceeded` / `invalid_override` / `invalid_incentive` | the limits are re-checked on approval (`src/money/controls.ts`); the request stays pending, reject it with the message as the reason |
| A write-off approval answers `409 balance_changed` | money moved on the balance since the request; reject and ask again for the new amount |
| A driver's state didn't change when an override started or ended | the `money-controls` job recomputes within 5 minutes; check `policy_override` (`status = 'APPROVED'`, the window) and `SELECT state FROM beneficiary WHERE account_id = …` |
| An incentive stays `APPROVED` after its end | the job logs `incentive could not be closed`; it retries every 5 minutes. Awards are unique, so a rerun never pays twice |
| A company says its invoice is wrong | issued invoices never change (trigger). Correct with an adjustment or a credit on the next month's receivable; `invoice_line.posting_id` shows which postings it covered |

```sql
-- what each control posted, by kind
SELECT kind, count(*), sum(p.amount_minor) FILTER (WHERE a.kind = 'BENEFICIARY_BALANCE') AS to_balances
FROM journal_entry je JOIN posting p ON p.journal_entry_id = je.id JOIN ledger_account a ON a.id = p.account_id
WHERE je.kind IN ('ADJUSTMENT','WRITE_OFF','INCENTIVE','INVOICE_PAYMENT') GROUP BY kind;
-- unpaid invoices past due
SELECT number, org_id, total_minor - paid_minor AS outstanding, due_at FROM invoice WHERE status = 'ISSUED' AND due_at < now() ORDER BY due_at;
```
