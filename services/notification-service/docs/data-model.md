# Data model

Postgres database `notification_service` (name from `.env.example`), Prisma schema `prisma/schema.prisma`, client generated into `src/generated/prisma`. Tables and columns are snake_case through `@map`. Ids default to `uuidv7()` in the database (Postgres 18).

**No login code and no phone number is stored in Postgres** (schema header comment, enforced for the phone by `ck_otp_delivery_phone_hash`, and checked by the integration test "never stores the code or the phone number in Postgres").

## Tables

### `otp_delivery`

One delivery attempt of a login code on one channel. An SMS fallback is a new row pointing at the attempt it replaced.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `uuidv7()` | PK. Also sent to Telegram as `payload` |
| `phone_hash` | bytea | no | | HMAC-SHA256 of the E.164 number with `PHONE_HASH_KEY` |
| `purpose` | text | no | | `sign_in`, `phone_change`, `claim_guest` |
| `channel` | text | no | | `TELEGRAM`, `SMS` |
| `telegram_request_id` | text | yes | | Telegram's `request_id`; unique |
| `status` | text | no | `'REQUESTED'` | see the check below |
| `cost_usd` | decimal(10,4) | yes | | Telegram `request_cost` |
| `is_refunded` | boolean | yes | | Telegram `is_refunded` from reports |
| `error` | text | yes | | provider reason, max 200 chars (set by code) |
| `fallback_of` | uuid | yes | | FK → `otp_delivery.id`, `ON DELETE SET NULL` |
| `created_at` | timestamptz | no | now | set explicitly by the service clock on insert |
| `updated_at` | timestamptz | no | now | Prisma `@updatedAt` |

Constraints (raw SQL at the end of the migration):

| Name | Rule |
|---|---|
| `ck_otp_delivery_purpose` | `purpose IN ('sign_in','phone_change','claim_guest')` |
| `ck_otp_delivery_channel` | `channel IN ('TELEGRAM','SMS')` |
| `ck_otp_delivery_status` | `status IN ('REQUESTED','NOT_REACHABLE','SENT','DELIVERED','READ','EXPIRED','REVOKED','FAILED','VERIFIED')` |
| `ck_otp_delivery_telegram_only` | `channel = 'TELEGRAM' OR telegram_request_id IS NULL` |
| `ck_otp_delivery_phone_hash` | `octet_length(phone_hash) = 32` |

Indexes: PK `otp_delivery_pkey (id)`; unique `otp_delivery_telegram_request_id_key (telegram_request_id)`; `ix_otp_delivery_phone_recent (phone_hash, created_at DESC)` (resend lookup).

Retention: rows older than 30 days are deleted hourly (`purgeOld()`, `RETENTION_DAYS = 30` in `src/otp/otp-service.ts`).

### `device_token`

Push tokens registered by signed-in apps.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `uuidv7()` | PK |
| `user_id` | uuid | no | | auth-service user id (no FK: other database) |
| `token` | text | no | | FCM registration token; unique |
| `platform` | text | no | | `android`, `ios`, `web` (`ck_device_token_platform`) |
| `created_at` | timestamptz | no | now | |
| `last_seen_at` | timestamptz | no | now | updated on every registration |

Indexes: PK; unique `device_token_token_key (token)`; `device_token_user_id_idx (user_id)`.

Lifecycle: at most 10 per user (oldest `last_seen_at` deleted on registration); deleted on sign-out (`/remove`) or when FCM reports the token unregistered. No time-based purge.

### `notification`

One row per `(event, channel)` sent from Kafka. Message bodies and phone numbers are not stored.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `uuidv7()` | PK |
| `dedupe_key` | text | no | | `"{eventId}:{channel}"`; unique |
| `user_id` | uuid | yes | | push recipient; null for SMS |
| `channel` | text | no | | `PUSH`, `SMS` (`ck_notification_channel`) |
| `template` | text | no | | e.g. `driver_activated`, `org_invite` (see [events.md](events.md)) |
| `status` | text | no | `'PENDING'` | `PENDING`, `SENT`, `SKIPPED`, `FAILED` (`ck_notification_status`) |
| `attempts` | int | no | 0 | incremented per send attempt; `FAILED` at 5 |
| `error` | text | yes | | last error, max 200 chars |
| `created_at` | timestamptz | no | now | |
| `updated_at` | timestamptz | no | now | Prisma `@updatedAt` |

Indexes: PK; unique `notification_dedupe_key_key (dedupe_key)`; `notification_user_id_created_at_idx (user_id, created_at DESC)`.

Retention: none in code; rows are kept.

## Migrations

| Order | Folder | What |
|---|---|---|
| 1 | `prisma/migrations/20261026090000_init` | Creates the three tables, indexes, the self-FK, and the check constraints above |

`migration_lock.toml`: provider `postgresql`. Migrations are applied with `prisma migrate deploy` (`make db-migrate` at the repo root, or the integration-test global setup).

## Redis keys

Redis is required (`REDIS_URL`). Client: ioredis, `maxRetriesPerRequest: 2` (`src/container.ts`).

| Key / channel | Type | TTL | Written by | Purpose |
|---|---|---|---|---|
| `otp:code:{phoneHashHex}` | string | the code's TTL (60–1800 s); `updateCode` keeps the remaining TTL (`KEEPTTL`) and only writes if the key exists (`XX`) | `src/otp/otp-store.ts` | Active code for a phone, AES-256-GCM sealed. Base64 of `iv(12) ‖ tag(16) ‖ ciphertext`, AAD = phone hash hex. Plaintext JSON: `{ phoneNumber, code, purpose, ttlSeconds, deliveryIds[], telegram?: { deliveryId, requestId } }` |
| `otp:fallback` | sorted set | none | `src/otp/otp-store.ts` | Members: Telegram delivery ids; score: epoch ms when the SMS fallback is due. Removed on delivery report, verify, failure paths, or when claimed by the poller |
| `settings:changed` | pub/sub channel (subscribe) | n/a | platform-service | Triggers a settings reload (`libs/shared-settings`) |
| `authz:changed` | pub/sub channel (subscribe) | n/a | auth-service | Triggers a permission-matrix reload (`libs/shared-authz`) |

This service does not read the `deny:{userId}` or `pv:{userId}` keys that other services use for token checks.
