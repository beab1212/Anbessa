# Configuration

Parsed once at start by `loadConfig()` in `src/config/index.ts` (Zod). A blank value (`KEY=`) counts as unset. Invalid configuration makes the process exit at start with the Zod error. `.env.example` lists the variables with comments; `make secrets` fills `INTERNAL_SERVICE_TOKEN`, `PHONE_HASH_KEY` and `OTP_ENCRYPTION_KEY` when blank. Production values are summarised in [docs/production/README.md](../../../docs/production/README.md#5-configuration-reference).

## Variables

| Variable | Meaning | Default | Required | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test` or `production` | `development` | no | enum |
| `PORT` | HTTP port | `3006` | no | number |
| `LOG_LEVEL` | pino level override | `info` in production, `debug` otherwise (`libs/shared-utils/src/logger.ts`) | no | string |
| `DATABASE_URL` | Postgres URL (`notification_service`) | — | **yes** | URL |
| `REDIS_URL` | Redis URL (sealed codes, fallback schedule, pub/sub) | — | **yes** | URL |
| `KAFKA_BROKERS` | comma-separated brokers | unset (consumer disabled, warning logged) | **yes in production** | CSV |
| `AUTH_ISSUER` | expected `iss` of access tokens | `http://localhost:3001` | no | URL |
| `AUTH_JWKS_URL` | auth-service JWKS | `http://localhost:3001/api/auth/jwks` | no | URL |
| `AUTH_INTERNAL_URL` | auth-service base URL for `/internal/authz/snapshot` | `http://localhost:3001` | no | URL |
| `PLATFORM_INTERNAL_URL` | platform-service base URL for `/internal/settings/snapshot` | `http://localhost:3011` | no | URL |
| `INTERNAL_SERVICE_TOKEN` | shared secret for `/internal/*` (both directions) | — | **yes** | ≥ 32 chars |
| `PHONE_HASH_KEY` | HMAC key for `otp_delivery.phone_hash` | — | **yes** | exactly 32 bytes as hex (64 hex chars) |
| `OTP_ENCRYPTION_KEY` | AES-256-GCM key for codes in Redis | — | **yes** | exactly 32 bytes as hex |
| `OTP_CHANNELS` | channel order; default for the live setting `otp.channels` | `telegram,sms` | no | CSV of `telegram`/`sms`, at least one. `telegram` is dropped when `TELEGRAM_GATEWAY_TOKEN` is unset |
| `OTP_FALLBACK_SECONDS` | seconds before the SMS fallback; default for `otp.fallbackSeconds` | `20` | no | int 5–120 |
| `TELEGRAM_GATEWAY_TOKEN` | Telegram Gateway API token; its SHA256 verifies reports | unset (Telegram off, webhook route absent) | **yes in production if `telegram` in `OTP_CHANNELS`** | ≥ 16 chars |
| `TELEGRAM_GATEWAY_URL` | Gateway API base URL | `https://gatewayapi.telegram.org` | no | URL. Not in `.env.example` |
| `TELEGRAM_SENDER_USERNAME` | verified channel passed as `sender_username` | unset | no | string |
| `TELEGRAM_CALLBACK_URL` | public URL of the webhook, passed as `callback_url` | unset (no reports) | **yes in production if `telegram` in `OTP_CHANNELS`** | URL; must start with `https://` in production |
| `TELEGRAM_BALANCE_ALERT_USD` | warn below this prepaid balance | `20` | no | number |
| `SMS_PROVIDER` | `console` or `twilio` | `console` | `twilio` in production | `console` refused in production |
| `TWILIO_ACCOUNT_SID` | Twilio account | unset | with `twilio` | all three Twilio vars required for `twilio` |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | unset | with `twilio` | |
| `TWILIO_FROM` | sender number / id | unset | with `twilio` | |
| `PUSH_PROVIDER` | `console` or `fcm` | `console` | `fcm` in production | `console` refused in production |
| `FCM_PROJECT_ID` | Firebase project | unset | with `fcm` | all three FCM vars required for `fcm` |
| `FCM_CLIENT_EMAIL` | service-account email | unset | with `fcm` | email |
| `FCM_PRIVATE_KEY` | service-account PEM key; `\n` escapes are turned into newlines | unset | with `fcm` | |

The production checks run only when `NODE_ENV=production`. The Twilio and FCM completeness checks run in every environment.

Test-only: `TEST_DATABASE_URL` (default `postgresql://ride:ride@localhost:5432/notification_service_test`, must end in `_test`) in `tests/integration/global-setup.ts`. `prisma.config.ts` reads `DATABASE_URL` through `dotenv`.

## Live settings (not environment)

| Key | Type | Registry default | Effect | Source |
|---|---|---|---|---|
| `otp.channels` | enum list `telegram`, `sms` | `["telegram","sms"]` | channel order per send; filtered by whether a Telegram token exists | `libs/shared-settings/src/registry.ts` |
| `otp.fallbackSeconds` | int 5–120 | 20 | fallback delay per send | same |

Resolution: stored global value → this service's env value (`OTP_CHANNELS`, `OTP_FALLBACK_SECONDS`) → registry default. Changes apply on the next send after the settings client reloads (Redis `settings:changed` or the 30 s poll).

## Hard-coded values

| Value | Where |
|---|---|
| 1 s fallback poll, 50 ids per poll | `src/server.ts`, `src/otp/otp-store.ts` |
| 1 h purge, 30-day retention of `otp_delivery` | `src/server.ts`, `src/otp/otp-service.ts` |
| TTL clamp 60–1800 s, code 4–8 digits | `src/otp/otp-service.ts` |
| 5 send attempts per notification | `src/notify/notifier.ts` |
| 10 devices per user | `src/http/routes.ts` |
| 5 s timeout for Telegram, Twilio, FCM, Google OAuth | `src/otp/telegram-gateway.ts`, `src/channels/*.ts` |
| ±300 s report timestamp window | `src/otp/telegram-gateway.ts` |
| 300 req/min rate limit, 16 KiB body | `src/app.ts` |
