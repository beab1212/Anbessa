# platform-service configuration

Source: `src/config/index.ts` (zod). `loadConfig()` drops variables that are empty or whitespace, so `KEY=` in `.env` means "not set". An invalid value stops the process at start with the zod error.

`.env` is read by `pnpm dev` (`--env-file-if-exists=.env`) and by `prisma.config.ts` (`dotenv/config`). `make secrets` (`scripts/dev-secrets.sh`) creates `.env` from `.env.example` and copies `INTERNAL_SERVICE_TOKEN` from auth-service.

| Variable | Meaning | Default | Required in production | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test`, `production` | `development` | set to `production` | enum |
| `PORT` | HTTP port | `3011` | no | coerced number |
| `LOG_LEVEL` | pino level override | logger default from `createLogger` | no | string |
| `DATABASE_URL` | Postgres connection URL (`platform_service`) | none | **yes** (always) | URL |
| `REDIS_URL` | Redis: `settings:changed` publish, token deny list / permission version, system-page Redis check, `authz:changed` subscription | unset | **yes** (refused at start if missing) | URL |
| `KAFKA_BROKERS` | comma-separated brokers: outbox relay and system-page lag | unset (outbox stays in the table, lag shows `configured: false`) | **yes** (refused at start if missing) | CSV → list; empty → unset |
| `INTERNAL_SERVICE_TOKEN` | shared service token: guards `/internal/settings/snapshot`, used for calls to auth-service and `/internal/ops/*` | none | **yes** (always) | string, ≥ 32 characters |
| `AUTH_ISSUER` | expected `iss` of access tokens | `http://localhost:3001` | set to the real issuer | URL |
| `AUTH_JWKS_URL` | auth-service JWKS | `http://localhost:3001/api/auth/jwks` | set | URL |
| `AUTH_INTERNAL_URL` | auth-service base URL for `/internal/cities/:id` and `/internal/authz/snapshot` | `http://localhost:3001` | set | URL |
| `SERVICE_URLS` | system page: `name=url,name=url` of every service | the eleven local services on `localhost:3000–3010` (see `.env.example`) | set to in-cluster URLs | parsed into `{ name, url }[]`; not URL-validated |
| `CONSUMER_GROUPS` | system page: consumer groups whose lag is shown | `location-service,notification-service,fleet-service,payment-service,audit-service,support-service` | no | CSV |

Names in `SERVICE_URLS` matter: outbox checks are made only for `auth-service`, `trip-service`, `fleet-service`, `payment-service`, `support-service`; integrations read `notification-service`, `mapping-service`, `realtime-gateway`, `fleet-service`, `payment-service`.

Test-only: `TEST_DATABASE_URL` (default `postgresql://ride:ride@localhost:5432/platform_service_test`, must end in `_test`) in `tests/integration/global-setup.ts`.

## Settings that are not env vars

The live settings (matching, fees, fares, flags…) are not configured here; they are stored values edited in the admin dashboard. Their defaults and bounds are in `libs/shared-settings/src/registry.ts`.

## Constants in code

| Constant | Value | Where |
|---|---|---|
| Change request lifetime | 7 days | `APPROVAL_TTL_MS`, `src/settings/service.ts` |
| Expiry job interval | 1 hour | `src/server.ts` |
| Seed / city-sync retry | 30 s | `src/server.ts` |
| Outbox relay | every 500 ms, batches of 100 | `src/outbox/relay.ts` |
| System page cache | 10 s | `src/system/health.ts` |
| client-config `max-age` | 15 s | `src/http/routes.ts` |
| Rate limit | 300 / minute | `src/app.ts` |
| Body limit | 32 KB | `src/app.ts` |
| Max city box side | 3° | `src/catalog/service.ts` |
