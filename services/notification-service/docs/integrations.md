# Integrations

## Overview

| System | Direction | How | Auth | Timeout | On failure |
|---|---|---|---|---|---|
| auth-service | in | `POST /internal/otp-deliveries`, `POST /internal/otp-deliveries/verified` | `INTERNAL_SERVICE_TOKEN` bearer | 2 s on auth-service's side | auth-service logs and carries on (`services/auth-service/src/auth/otp-delivery.ts`) |
| auth-service | out | `GET {AUTH_INTERNAL_URL}/internal/authz/snapshot` | service token | 3 s | keeps the current (built-in) matrix, logs a warning |
| auth-service | out | `GET {AUTH_JWKS_URL}` (via `jose` remote JWKS) | none | jose defaults | token checks fail → 401 |
| platform-service | in | `GET /internal/ops/integrations` | service token | platform-service's `getJson` default | platform-service shows `{ error }` |
| platform-service | out | `GET {PLATFORM_INTERNAL_URL}/internal/settings/snapshot` | service token | 3 s | keeps current values (env defaults at start), logs a warning |
| Kafka | in | consumer group `notification-service` | none configured (no SASL/TLS in code) | kafkajs defaults | see [events.md](events.md) |
| Telegram Gateway API | out | `POST {TELEGRAM_GATEWAY_URL}/{method}` | `Authorization: Bearer TELEGRAM_GATEWAY_TOKEN` | 5 s | falls back to SMS (see below) |
| Telegram Gateway | in | `POST /api/webhooks/telegram-gateway` via Kong | HMAC signature | n/a | non-200 makes Telegram retry (route comment: up to 10 times) |
| Twilio | out | `POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` | HTTP Basic `sid:authToken` | 5 s | OTP: row `FAILED`; events: retry by Kafka redelivery |
| Google OAuth | out | `POST https://oauth2.googleapis.com/token` (JWT bearer grant, RS256, scope `firebase.messaging`) | service-account key | 5 s | push send fails → retry by redelivery |
| FCM HTTP v1 | out | `POST https://fcm.googleapis.com/v1/projects/{id}/messages:send` | OAuth access token | 5 s | 404/`UNREGISTERED`: token deleted; other errors: retry by redelivery |
| Phone app | in | `/api/notifications/devices`, `/devices/remove` via Kong | access token `aud=ride-app` | n/a | app-side handling |
| Postgres | out | Prisma with `@prisma/adapter-pg` | `DATABASE_URL` | driver defaults | 500 on routes; Kafka redelivery for handlers |
| Redis | out | ioredis | `REDIS_URL` | `maxRetriesPerRequest: 2` | OTP delivery fails (500 on `/internal/otp-deliveries`); fallback poll errors logged |

## auth-service (login codes)

auth-service uses this path only when `OTP_DELIVERY=notification` and `NOTIFICATION_INTERNAL_URL` is set (`services/auth-service/src/config/index.ts`). Otherwise it logs the code itself (`consoleOtpSender`, development only). Both services must share the same `INTERNAL_SERVICE_TOKEN`; `make secrets` copies it ([docs/development/README.md](../../../docs/development/README.md)).

## Telegram Gateway API

Client: `src/otp/telegram-gateway.ts`. Every call is a JSON POST; the response must have `ok: true`, else `TelegramGatewayError(method, error ?? "http {status}")`. Network errors become reason `network error`, timeouts `timeout`.

| Method | When | Parameters sent |
|---|---|---|
| `checkSendAbility` | first step of a Telegram delivery | `phone_number` |
| `sendVerificationMessage` | the number can receive | `phone_number`, `request_id` (from the check, so it isn't charged twice), `code`, `ttl`, `payload` = delivery id, `callback_url` if `TELEGRAM_CALLBACK_URL`, `sender_username` if `TELEGRAM_SENDER_USERNAME` |
| `revokeVerificationMessage` | SMS fallback fired, or a resend went to SMS | `request_id` (errors ignored) |
| `checkVerificationStatus` | `verified()` | `request_id`, `code` (errors ignored) |

Values read from responses: `request_id`, `request_cost`, `remaining_balance`. Without `TELEGRAM_CALLBACK_URL` no delivery reports arrive, so every Telegram attempt also gets the SMS fallback after `fallbackSeconds` (noted in [docs/development/README.md](../../../docs/development/README.md)).

## SMS (`src/channels/sms.ts`)

`SmsSender.send(to, body)`. Implementations:

- `twilioSms`: form-encoded `To`, `From`, `Body`. Non-2xx → error `twilio {status} ({code})`. Returns Twilio's `sid` (not stored).
- `consoleSms`: logs `{ to: masked, body }` at warn level with `DEV SMS (console provider, never enabled in production)`. The body includes login codes.

The Ethiopian SMS provider is not chosen yet (comment in the file, Auth.md Q3); adding one means implementing `SmsSender`. No SMS delivery reports are received.

## Push (`src/channels/push.ts`)

- `fcmPush`: builds a service-account JWT (`iss = FCM_CLIENT_EMAIL`, `aud = https://oauth2.googleapis.com/token`, 1 h), exchanges it for an access token, caches it until 60 s before expiry. The message is `{ token, notification: { title, body }, data }`.
- `consolePush`: logs the first 8 chars of the token and the message, returns `sent`.

## platform-service

- Calls `/internal/ops/integrations` for the admin **System** page and also checks `/health/ready` (`services/platform-service/src/system/health.ts`). It lists `notification-service` among the Kafka consumer groups it watches for lag (`CONSUMER_GROUPS` in `services/platform-service/src/config/index.ts`).
- Owns the settings `otp.channels` and `otp.fallbackSeconds` (`libs/shared-settings/src/registry.ts`, `owner: "notification-service"`).

## Kong

From `infra/kong/kong.yml` (and the same routes in `infra/kong/kong.dev.yml`, pointing at `host.docker.internal:3006`):

| Route name | Paths | Methods | `strip_path` |
|---|---|---|---|
| `notification-device-routes` | `/api/notifications` | all | false |
| `telegram-gateway-webhook` | `/api/webhooks/telegram-gateway` | POST | false |

Service plugins: `rate-limiting` 120/min (`policy: local`), `request-size-limiting` 16 KB. Kong does not verify JWTs (file header); this service does. `/internal/*` is not routed. The production callback URL in `.env.example` is `https://api.anbessa.et/api/webhooks/telegram-gateway`.

## Sequence: sending a login code

```mermaid
sequenceDiagram
  autonumber
  participant BA as auth-service
  participant N as notification-service
  participant PG as Postgres
  participant R as Redis
  participant TG as Telegram Gateway
  participant SMS as SMS provider
  participant K as Kong
  BA->>N: POST /internal/otp-deliveries {phoneNumber, code, ttlSeconds, purpose}
  N->>PG: find recent TELEGRAM attempt (REQUESTED/SENT) for phone_hash
  N->>PG: insert otp_delivery (REQUESTED, TELEGRAM)
  N->>R: SET otp:code:{hash} sealed EX ttl
  N->>R: ZADD otp:fallback now+fallbackSeconds deliveryId
  N-->>BA: 202 {deliveryId, channel: "telegram"}
  N->>TG: checkSendAbility(phone)
  alt can't receive / send fails
    N->>PG: row NOT_REACHABLE or FAILED
    N->>R: ZREM otp:fallback deliveryId
    N->>PG: insert SMS row (fallback_of)
    N->>SMS: same code
  else accepted
    N->>TG: sendVerificationMessage(code, payload=deliveryId, callback_url)
    N->>PG: row SENT, telegram_request_id, cost_usd
    TG->>K: POST /api/webhooks/telegram-gateway (signed)
    K->>N: forward
    N->>PG: status DELIVERED / READ (forward only)
    N->>R: ZREM otp:fallback deliveryId
  end
  opt no DELIVERED before the score (poller, every 1 s)
    N->>R: ZRANGEBYSCORE + ZREM (one replica wins)
    N->>PG: insert SMS row (fallback_of)
    N->>SMS: same code
    N->>TG: revokeVerificationMessage (best effort)
  end
  BA->>N: POST /internal/otp-deliveries/verified {phoneNumber}
  N->>TG: checkVerificationStatus(request_id, code)
  N->>PG: rows of this code → VERIFIED
  N->>R: DEL otp:code:{hash}
```

## Sequence: push on a trip event (receipt)

`trip.settled` is the only trip-related topic with a handler today.

```mermaid
sequenceDiagram
  autonumber
  participant P as payment-service
  participant K as Kafka
  participant N as notification-service
  participant PG as Postgres
  participant FCM as FCM
  participant App as phone app
  App->>N: POST /api/notifications/devices {token, platform} (earlier, via Kong)
  P->>K: trip.settled {eventId, riderId, tripId, fareMinor, paymentMethod, purpose} (outbox relay)
  K->>N: message (group notification-service)
  N->>PG: find/create notification dedupe_key = eventId:PUSH (PENDING)
  alt row already SENT / SKIPPED / FAILED
    N-->>K: done (no send)
  else PENDING
    N->>PG: device_token where user_id = riderId
    loop each device
      N->>FCM: messages:send {title "Trip receipt", body, data {type: trip.receipt, tripId}}
      alt 404 / UNREGISTERED
        N->>PG: delete device_token
      end
    end
    alt at least one sent
      N->>PG: status SENT, attempts+1
    else all errors (attempts < 5)
      N->>PG: attempts+1, error
      N-->>K: throw → offset not committed, redelivered
    end
  end
  FCM-->>App: notification
```
