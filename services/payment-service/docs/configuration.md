# Configuration

Environment variables are parsed by a zod schema in `src/config/index.ts` (`loadConfig`). A variable set to an empty or blank string (`KEY=`, as in `.env.example`) counts as not set. Invalid config throws at start and the process exits. `pnpm dev` loads `.env` if present (`--env-file-if-exists=.env`); `make secrets` creates `.env` from `.env.example` and fills the secrets (`scripts/dev-secrets.sh`). Never commit `.env`.

## Environment variables

### Runtime and infrastructure

| Variable | Default | Required in production | Rules | Meaning |
|---|---|---|---|---|
| `NODE_ENV` | `development` | — | `development` \| `test` \| `production` | production turns on the checks below, hides the simulator checkout routes, stops the consumer from creating topics, and sets the default log level to `info` |
| `PORT` | `3005` | no | number | HTTP port (listens on `0.0.0.0`) |
| `LOG_LEVEL` | — | no | any string | pino level; without it, `info` in production and `debug` otherwise (`libs/shared-utils/src/logger.ts`) |
| `DATABASE_URL` | — | **yes (always)** | URL | Postgres `payment_service` |
| `REDIS_URL` | — | **yes** | URL | deny list and permission versions, realtime pushes, simulator state, settings/authz pub/sub. Without it (dev only): no live pushes, suspensions and role changes take effect only when tokens expire, simulator state in memory |
| `KAFKA_BROKERS` | — | **yes** | comma-separated list | without it (dev only) no consumer and no relay: trips are never settled and events never leave the outbox |

### Service-to-service

| Variable | Default | Required in production | Rules | Meaning |
|---|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | — | **yes (always)** | ≥ 32 characters | accepted on `/internal/*`, and sent to auth-service and platform-service. Same value as auth-service (`make secrets` copies it) |
| `AUTH_ISSUER` | `http://localhost:3001` | set it | URL | expected `iss` of access tokens |
| `AUTH_JWKS_URL` | `http://localhost:3001/api/auth/jwks` | set it | URL | token signing keys |
| `AUTH_INTERNAL_URL` | `http://localhost:3001` | set it | URL | `/internal/authz/snapshot` |
| `PLATFORM_INTERNAL_URL` | `http://localhost:3011` | set it | URL | `/internal/settings/snapshot` |
| `PUBLIC_URL` | `http://localhost:3005` | set it | URL | base of the webhook URLs given to providers (`{PUBLIC_URL}/api/payments/webhooks/{provider}`) and of the simulator's checkout URLs. Behind Kong: the public API URL. A trailing `/` is removed |

### Providers

| Variable | Default | Required in production | Rules | Meaning |
|---|---|---|---|---|
| `PAYMENT_PROVIDERS` | `telebirr,cbebirr,chapa` | — | comma-separated; each must be one of `telebirr`, `cbebirr`, `chapa` | the gateways that are enabled |
| `GATEWAY_MODE` | `simulated` | — | only `simulated` is accepted; **refused when `NODE_ENV=production`** | how providers are reached |
| `TELEBIRR_WEBHOOK_SECRET` | — | yes (always) | ≥ 32 characters | verifies telebirr callbacks; the simulator signs with it |
| `CBEBIRR_WEBHOOK_SECRET` | — | yes (always) | ≥ 32 characters | same for CBE Birr |
| `CHAPA_WEBHOOK_SECRET` | — | yes (always) | ≥ 32 characters | same for Chapa |

The three webhook secrets must all be different ("each provider needs its own webhook secret", reported on `CHAPA_WEBHOOK_SECRET`). They are required even for providers not listed in `PAYMENT_PROVIDERS`.

Because `GATEWAY_MODE` has no value other than `simulated`, and `simulated` is refused in production, the service cannot start with `NODE_ENV=production` until a real gateway mode exists. The Dockerfile sets `NODE_ENV=production`; `infra/docker/docker-compose.yml` overrides it from the root `.env`.

### Simulator

| Variable | Default (code) | `.env.example` | Rules | Meaning |
|---|---|---|---|---|
| `SIM_AUTO_APPROVE_SECONDS` | `0` | `8` | 0–600 | charges approve themselves after this many seconds (the rider approving on their phone). `0`: only the checkout page decides |
| `SIM_PAYOUT_SECONDS` | `3` | `3` | 0–600 | payouts are decided after this delay; a destination ending in `0000` fails |
| `SIM_DROP_WEBHOOKS` | `0` | `0` | 0–1 | share of first callback deliveries dropped on purpose, to exercise reconciliation |

### Money behaviour

| Variable | Default (code) | `.env.example` | Rules | Meaning |
|---|---|---|---|---|
| `PAYMENT_RETRY_SECONDS` | `60,600,3600` | same | comma-separated numbers, each finite and ≥ 1 | delay before each retry of a declined charge; the list length is the number of retries. After the last one the trip is settled through a rider receivable |
| `RECONCILE_AFTER_SECONDS` | `300` | `120` | integer ≥ 10 | open charges, top-ups, refunds and payouts older than this are queried at the provider by the 1-minute reconcile job |
| `SETTLEMENT_SCHEDULE` | `weekly` | `weekly` | `weekly` \| `off` | `weekly`: the settlement batch is prepared on Mondays (Addis Ababa date); `off`: only `POST /api/payments/settlements/run` |

### Production checks

`superRefine` in `src/config/index.ts` fails start when `NODE_ENV=production` and:

- `GATEWAY_MODE` is `simulated`;
- `KAFKA_BROKERS` is not set;
- `REDIS_URL` is not set.

Always: `PAYMENT_RETRY_SECONDS` must be valid and the webhook secrets distinct.

### Used only by tests

| Variable | Default | Meaning |
|---|---|---|
| `TEST_DATABASE_URL` | `postgresql://ride:ride@localhost:5432/payment_service_test` | integration test database; its name must end in `_test` (it is dropped and recreated) — `tests/integration/global-setup.ts` |

`prisma.config.ts` reads `DATABASE_URL` (via `dotenv/config`) for the Prisma CLI; it may be unset for `prisma generate`.

## Live settings (platform-service)

Read through `createSettingsClient` (`libs/shared-settings`), loaded at start from `{PLATFORM_INTERNAL_URL}/internal/settings/snapshot`, reloaded on the Redis channel `settings:changed`, and polled every 30 s. If platform-service is unreachable the registry defaults apply. Definitions: `libs/shared-settings/src/registry.ts`.

| Key | Scope | Default | Owner | Used by payment-service for |
|---|---|---|---|---|
| `payments.methods` | city | `["CASH","MOBILE_MONEY","CARD"]` | trip-service | echoed as `methods` on `GET /api/payments/methods?cityId=` |
| `payments.mobileMoneyProviders` | global | `["telebirr","cbebirr"]` | payment-service | order of mobile money providers for riders without a preference |
| `payments.cardProvider` | global | `"chapa"` | payment-service | card provider |

A provider named in a setting but not enabled in `PAYMENT_PROVIDERS` is skipped.

## Settings that live in the database

Commission rules and balance policies are not environment variables or platform settings: they are rows in `commission_rule` and `balance_policy`, changed through the maker–checker API (`POST /api/payments/rules/changes`). With no row for a city the built-in defaults in `src/money/rules.ts` apply (`DEFAULT_RULE`, `DEFAULT_POLICY`; see [architecture.md](architecture.md#beneficiaries-balances-states-and-policies)).

## Constants in code

| Constant | Value | Where |
|---|---|---|
| HTTP body limit | 32 KB (webhooks 64 KB) | `src/app.ts`, `src/http/routes.ts` |
| Global rate limit | 300/min per IP; webhooks 600/min; `/internal/balances/state` none | `src/app.ts`, `src/http/routes.ts` |
| Mobile money top-up range | 1 000–10 000 000 santim | `TOP_UP_LIMITS` in `src/money/topups.ts` |
| Office cash / bank top-up range | 100–10 000 000 santim | `topups.ts` `record` |
| Unreachable provider retry | 30 s, attempt not counted | `payments.ts` `startCharge` |
| Interrupted charge pickup | `PENDING` without `provider_ref` older than 10 s | `payments.ts` `chargeDue` |
| Rule proposal lifetime | 7 days | `rule-changes.ts` |
| Earnings custom range | up to 92 days | `earnings.ts` |
| Idempotency key lifetime | 24 h | `src/lib/idempotency.ts` |
| Outbox relay | every 500 ms, batches of 100 | `src/outbox/relay.ts` |
| Simulator redelivery | 1 s, 5 s, 15 s | `src/gateways/simulator.ts` |
| Simulator state TTL | 7 days | `src/gateways/simulator.ts` |
