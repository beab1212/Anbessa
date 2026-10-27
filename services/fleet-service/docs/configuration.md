# Configuration

The environment is parsed once at start by `loadConfig()` in `src/config/index.ts` (zod). A blank value (`KEY=`, as in `.env.example`) counts as unset. An invalid environment makes the process exit with the zod error. `pnpm dev` and `pnpm seed:dev` load `.env` with `--env-file-if-exists`; `prisma.config.ts` loads it with `dotenv`. `make secrets` (`scripts/dev-secrets.sh`) creates `.env` from `.env.example`, fills the three keys and copies the shared `INTERNAL_SERVICE_TOKEN`.

Never commit `.env`; the values below are defaults from the schema, not secrets.

## Environment variables

| Variable | Meaning | Default | Required in production | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test` or `production` | `development` | set it to `production` | enum |
| `PORT` | HTTP port (listens on `0.0.0.0`) | `3008` | — | number |
| `LOG_LEVEL` | pino level override | unset: `info` in production, `debug` otherwise (`libs/shared-utils`) | — | string |
| `DATABASE_URL` | Postgres connection string for `fleet_service` | — | **yes** (always required) | URL |
| `REDIS_URL` | Redis written by auth-service (deny list, permission versions) and pub/sub for matrix and settings changes | unset → no deny-list / pv checks, polling only (warning at start) | **yes** | URL |
| `KAFKA_BROKERS` | Comma-separated brokers for the outbox relay and the consumer | unset → no relay, no consumer (warning at start) | **yes** | CSV, trimmed, empty → unset |
| `INTERNAL_SERVICE_TOKEN` | Shared service token: sent to auth/payment/platform, required on `/internal/*` | — | **yes** (always) | ≥ 32 characters |
| `AUTH_ISSUER` | Expected JWT `iss` | `http://localhost:3001` | set to the real issuer | URL |
| `AUTH_JWKS_URL` | JWKS used to verify tokens | `http://localhost:3001/api/auth/jwks` | set | URL |
| `AUTH_INTERNAL_URL` | Base URL for auth-service `/internal/*` (organisations, memberships, DRIVER role, authz snapshot); also `/api/dev/accounts` for `seed:dev` | `http://localhost:3001` | set | URL |
| `PII_ENCRYPTION_KEY` | AES-256-GCM key for licence numbers. Losing it makes stored licences unreadable | — | **yes** (always) | 64 hex characters |
| `PII_BLIND_INDEX_KEY` | HMAC key for the licence blind index. Changing it breaks duplicate detection for existing rows | — | **yes** (always) | 64 hex characters |
| `UPLOAD_SIGNING_KEY` | Root key for upload tickets and local file links (two HMAC-derived sub-keys). Changing it invalidates outstanding tickets and links only | — | **yes** (always) | 64 hex characters |
| `STORAGE` | `s3` or `local` | `local` | must be `s3` | enum; `local` refused when `NODE_ENV=production` |
| `STORAGE_DIR` | Directory for `STORAGE=local` (relative to the working directory) | `.dev-data/uploads` | — | string |
| `S3_BUCKET` | Bucket for `STORAGE=s3` | — | **yes** with `s3` | required when `STORAGE=s3` |
| `S3_REGION` | S3 region | `eu-central-1` | — | string |
| `S3_ENDPOINT` | S3-compatible endpoint (MinIO); unset for AWS | unset | — | URL |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO-style path addressing | `false` | — | `"true"` / `"false"` |
| `PAYMENT_INTERNAL_URL` | payment-service base for `/internal/balances/state` | `http://localhost:3005` | set | URL |
| `PLATFORM_INTERNAL_URL` | platform-service base for `/internal/settings/snapshot` | `http://localhost:3011` | set | URL |
| `EXPIRY_WARNING_DAYS` | Default for the `documents.expiryWarningDays` setting | `30` | — | integer 1–90 |

Cross-field rules (`superRefine`):

- `NODE_ENV=production` requires `STORAGE=s3`, `KAFKA_BROKERS` and `REDIS_URL`.
- `STORAGE=s3` requires `S3_BUCKET`.
- `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY` and `UPLOAD_SIGNING_KEY` must all be different (compared case-insensitively).

S3 credentials are not in the schema: the AWS SDK's default credential chain is used (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, profile, instance role, …).

Test-only: `TEST_DATABASE_URL` (default `postgresql://ride:ride@localhost:5432/fleet_service_test`) is read by `tests/integration/global-setup.ts`; its database name must end in `_test`.

## Live settings (platform-service)

Read through `libs/shared-settings` (registry: `libs/shared-settings/src/registry.ts`). Admins change them on the admin dashboard → Settings; they reach the service on `settings:changed` or within 30 s. Resolution: stored global value → this service's default (env) → registry default. Both are `global` scope; the code reads them without a city.

| Key | Type | Default | Used by |
|---|---|---|---|
| `documents.expiryWarningDays` | int 1–90 (days) | env `EXPIRY_WARNING_DAYS`, else 30 | `expiringSoon` on document views; `expiringSoon` count in the review queue |
| `documents.reminderDays` | int list, each 1–90 | `[30, 7, 1]` (no env default) | `remindExpiring()`: one `document.expiring` per document per listed day |

The settings snapshot also carries cities and vehicle types, but fleet-service doesn't use them: cities come from `CITIES` (`libs/shared-location/src/cities.ts`: `addis-ababa`, `hawassa`) and vehicle types from `VEHICLE_TYPES` (`src/fleet/rules.ts`).

## Built-in constants

Not configurable; change the code.

| Constant | Value | Where |
|---|---|---|
| Max upload size | 10 MB (`10 * 1024 * 1024`) | `MAX_UPLOAD_BYTES`, `src/lib/storage.ts` |
| Upload types | `image/jpeg`, `image/png`, `application/pdf` | `UPLOAD_TYPES` |
| Upload URL / view URL validity | 5 min | `UPLOAD_URL_SECONDS`, `VIEW_URL_SECONDS` |
| Upload ticket validity | 15 min (3 × upload URL) | `uploadTicket()` in `src/fleet/service.ts` |
| JSON body limit | 32 KB | `src/app.ts` |
| Rate limit | 300 / min / IP | `src/app.ts` |
| Expiry job interval | 1 h | `startExpiryJob()` |
| Expiry batch | 500 documents per run | `expireDocuments()` |
| Outbox relay | 500 ms, batches of 100 | `src/outbox/relay.ts` |
| Idempotency purge | every 24 h, rows older than 24 h | `src/server.ts`, `src/lib/idempotency.ts` |
| auth-service / payment-service timeouts | 3 s / 2 s | `src/lib/clients.ts` |
| Approval transaction timeout | 15 s | `approveDriver()` |
| Matrix and settings poll | 30 s | shared libs |
| Vehicle types and seats | economy 3–4, comfort 3–4, minivan 5–8 | `VEHICLE_TYPES` |
| Model year | 1990 … next year | `registerVehicle()` |
