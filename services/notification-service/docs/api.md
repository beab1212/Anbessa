# HTTP API

All routes are in `src/app.ts` (health) and `src/http/routes.ts`. Port 3006. Bodies are JSON; the body limit is 16 KiB (`bodyLimit` in `src/app.ts`).

## Summary

| Method | Path | Caller | Auth | Through Kong |
|---|---|---|---|---|
| GET | `/health` | load balancer, Docker `HEALTHCHECK` | none | no |
| GET | `/health/live` | orchestrator | none | no |
| GET | `/health/ready` | orchestrator, platform-service system page | none | no |
| POST | `/internal/otp-deliveries` | auth-service | service token | no |
| POST | `/internal/otp-deliveries/verified` | auth-service | service token | no |
| GET | `/internal/ops/integrations` | platform-service | service token | no |
| POST | `/api/webhooks/telegram-gateway` | Telegram Gateway | HMAC signature | yes |
| POST | `/api/notifications/devices` | phone app | access token, audience `ride-app` | yes |
| POST | `/api/notifications/devices/remove` | phone app | access token, audience `ride-app` | yes |

No route checks a permission from the matrix (`authorize()` is not used in this service).

## Errors

From `src/middlewares/error-handler.ts`. Every error body is `{ "error": "<code>", "message": "<text>" }`.

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` (+ `issues: [{ path, message }]`) | Zod schema failed |
| 400 | `bad_request` | Domain check in the OTP service (E.164, code format, no channel) |
| 401 | `unauthorized` | Missing bearer token, wrong service token |
| 401 | `invalid_token` / `token_revoked` / `token_outdated` | Access token rejected by `libs/shared-authz` (only `invalid_token` can occur here: no deny list or permission version is configured) |
| 401 | `invalid_signature` | Telegram webhook signature or timestamp check failed |
| 404 | `not_found` | Unknown route (also the webhook when `TELEGRAM_GATEWAY_TOKEN` is unset) |
| 413, 415, other 4xx | Fastify's code | Body too large, wrong content type, etc. |
| 429 | rate-limit plugin response | More than 300 requests/min from one IP (per process) |
| 503 | `auth_unavailable` | `TokenCheckUnavailable` is mapped (503, `retry-after: 5`) but can't occur here: no deny list or permission version is configured |
| 500 | `internal_error` | Anything else; details are logged, not returned |

## Rate limits

| Layer | Limit | Applies to |
|---|---|---|
| Service (`@fastify/rate-limit`, `src/app.ts`) | 300 / minute / IP, in memory | every route except `POST /internal/otp-deliveries` and `POST /internal/otp-deliveries/verified` (`rateLimit: false`) |
| Kong (`infra/kong/kong.yml`) | 120 / minute, `policy: local`; request size 16 KB | `/api/notifications` and `/api/webhooks/telegram-gateway` |

`trustProxy: true`, so the client IP comes from `X-Forwarded-For` set by Kong or the load balancer.

---

## Health

### `GET /health`, `GET /health/live`

`200 { "status": "ok" }`. No dependency checks.

### `GET /health/ready`

Runs `SELECT 1` on Postgres. `200 { "status": "ok" }` or `503 { "status": "unavailable" }`. Redis and Kafka are not checked.

---

## Internal routes

Header: `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`. A wrong or missing token gives `401 { error: "unauthorized", message: "invalid service credentials" }`.

### `POST /internal/otp-deliveries`

Deliver a login code. Called by auth-service's `notificationOtpSender` (`services/auth-service/src/auth/otp-delivery.ts`, 2 s timeout, the result is only logged there).

Request:

| Field | Type | Rules |
|---|---|---|
| `phoneNumber` | string | E.164: `^\+[1-9]\d{7,14}$` (checked in the service → 400 `bad_request`) |
| `code` | string | 4–8 digits (→ 400 `bad_request`) |
| `ttlSeconds` | integer | clamped to 60–1800 |
| `purpose` | `"sign_in" \| "phone_change" \| "claim_guest"` | Zod enum |

Response `202`:

```json
{ "deliveryId": "0192f7a8-…", "channel": "telegram" }
```

`channel` is `telegram` or `sms`: the first channel tried. The send happens after the response; failures there don't change the status code.

Other responses: `400 { error: "bad_request", message: "no delivery channel available" }` when SMS would be needed (no Telegram, or a resend of an undelivered Telegram attempt) but SMS is not in the live channel list.

### `POST /internal/otp-deliveries/verified`

auth-service reports a successful verify (best effort).

Request: `{ "phoneNumber": "+2519…" }` (E.164, else 400).

Response `200`: `{ "closed": true }` if an active code was found and closed, `{ "closed": false }` if not (expired, already closed, or never sent through this service).

### `GET /internal/ops/integrations`

For platform-service's system page (`services/platform-service/src/system/health.ts`, under `integrations.messaging`).

Response `200`:

```json
{
  "otp": {
    "channels": ["telegram", "sms"],
    "fallbackSeconds": 20,
    "telegramConfigured": true,
    "telegramBalance": { "usd": 49.99, "at": "2026-10-27T09:00:00.000Z" },
    "lastHour": [{ "channel": "TELEGRAM", "status": "DELIVERED", "count": 12 }],
    "smsFallbackRate": 0.08
  },
  "failedNotifications24h": { "PUSH": 3 }
}
```

- `telegramBalance` is the last balance seen by this process, or `null`.
- `lastHour` groups `otp_delivery` rows created in the last hour by channel and status.
- `smsFallbackRate` = SMS fallbacks (rows with `fallback_of_id`) / Telegram attempts (rows with `channel = "TELEGRAM"`) in the last hour; `null` when there were no Telegram attempts (`src/otp/otp-service.ts`, `status()`). It used to compare with lowercase `"telegram"` and was always `null` (fixed 2026-10-27).
- `failedNotifications24h` counts `notification` rows with status `FAILED` created in the last 24 h, per channel.

---

## Provider callback

### `POST /api/webhooks/telegram-gateway`

Telegram Gateway delivery reports. Registered **only** when `TELEGRAM_GATEWAY_TOKEN` is set; otherwise 404. Public through Kong without auth plugins.

Headers:

| Header | Meaning |
|---|---|
| `Content-Type: application/json` | The body is read raw (string) in this route's scope |
| `X-Request-Timestamp` | Unix seconds; must be digits and within ±300 s of server time |
| `X-Request-Signature` | Hex `HMAC-SHA256(key = SHA256(TELEGRAM_GATEWAY_TOKEN), "{timestamp}\n{rawBody}")` |

Body (`RequestStatus` in `src/otp/telegram-gateway.ts`; fields used): `request_id`, `payload` (our `otp_delivery.id`), `delivery_status.status` (`sent|delivered|read|expired|revoked`), `request_cost`, `is_refunded`, `remaining_balance`.

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{ "ok": true }` | Signature valid and JSON parsed. Returned even when no matching row exists |
| 400 | `{ error: "bad_request", message: "invalid JSON" }` | Valid signature, unparsable body |
| 401 | `{ error: "invalid_signature", message: "invalid signature" }` | Missing/bad signature or stale timestamp |

Processing is idempotent and forward-only (see [architecture.md](architecture.md#delivery-reports-onreport)).

---

## App routes

Header: `Authorization: Bearer <access token>`. The token must be an auth-service JWT for audience `ride-app` (the phone app). Staff tokens (`ride-admin`) are rejected. No permission is checked: any signed-in app user may call these.

### `POST /api/notifications/devices`

Register (or re-claim) a push token for the caller.

| Field | Type | Rules |
|---|---|---|
| `token` | string | 20–4096 chars |
| `platform` | `"android" \| "ios" \| "web"` | |

Response `204`. Effects: upsert by `token` (sets `user_id` to the caller, updates `platform` and `last_seen_at`), then deletes the caller's tokens beyond the 10 most recently seen.

Errors: 401 without/with an invalid token, 400 `validation_error`.

### `POST /api/notifications/devices/remove`

Remove a push token on sign-out.

Request: `{ "token": "<1–4096 chars>" }`. Response `204`, also when nothing matched. Only a token owned by the caller is deleted.

## Campaign routes (workflow 15, added)

Source: `src/campaigns/routes.ts` (registered from `src/http/routes.ts`). Kong already routes `/api/notifications` (`notification-device-routes`). Staff routes need a `ride-admin` token and `campaign:send` (MARKETING, CITY scope) **in the campaign's city**; a campaign of another city answers `404`. A `ride-app` token on a staff route is `401` (wrong audience).

| Method and path | Who | Success |
|---|---|---|
| `GET /api/notifications/campaigns?cityId=&status=&limit=` | `campaign:send` | `200 { campaigns: Campaign[], quietHours: { from, to } }`; without `cityId`, the caller's cities |
| `GET /api/notifications/campaigns/audience?cityId=&audience=&channel=&lastActiveDays=` | `campaign:send` in `cityId` | `200 { count }`: people the segment reaches now, opt-outs excluded |
| `POST /api/notifications/campaigns` `{ cityId, audience: RIDER \| DRIVER, channel: PUSH \| SMS, lastActiveDays? (1–365), title? (≤ 80, required for PUSH), body (≤ 500; ≤ 300 for SMS) }` | `campaign:send` in `cityId`; `Idempotency-Key` honoured | `201 { campaign }` (DRAFT) |
| `GET /api/notifications/campaigns/:id` | `campaign:send` in its city | `200 { campaign }` plus `audienceEstimate` (DRAFT/SCHEDULED) and `quietNow` |
| `PUT /api/notifications/campaigns/:id` | same; drafts only (`409 not_draft`) | `200 { campaign }` |
| `POST /api/notifications/campaigns/:id/schedule` `{ at? }` | same; DRAFT only | `200 { campaign }` (SCHEDULED; without `at`, now). `at` in the past → `400 in_past`; > 90 days → `400 too_far` |
| `POST /api/notifications/campaigns/:id/cancel` | same; DRAFT, SCHEDULED or SENDING | `200 { campaign }` (CANCELLED; unsent deliveries → SKIPPED `cancelled`) |
| `GET /api/notifications/me/marketing` | `ride-app` token | `200 { push: boolean, sms: boolean }` (true = receives marketing) |
| `PUT /api/notifications/me/marketing` `{ push?, sms? }` | `ride-app` token | `200 { push, sms }` |

`Campaign`: `{ id, cityId, audience, lastActiveDays, channel, title, body, status: DRAFT | SCHEDULED | SENDING | SENT | CANCELLED, scheduledAt, startedAt, finishedAt, targeted, counts: { pending, sent, skipped, failed }, createdBy, updatedBy, createdAt, updatedAt }`.

Errors: `400 title_required`, `400 body_too_long`, `409 invalid_transition`, `409 invalid_state` (concurrent change), `422 idempotency_mismatch`, `409 request_in_progress`, plus the common ones above. Every staff change writes `audit.recorded` (service `notification-service`) through the new outbox.
