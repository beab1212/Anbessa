# Operations

## Run locally

Standalone (from `services/notification-service`, see [the README](../README.md)):

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (postgis), Redis, Redpanda
pnpm install
make -C ../.. secrets                             # .env with the generated keys
pnpm prisma migrate dev                           # creates notification_service
pnpm dev                                          # tsx watch, http://localhost:3006
```

Full stack: `make dev-services` from the repo root, or one service with `make dev-svc SVC=notification-service`; migrations with `make db-migrate`. Kong in front: `make dev-gateway` (`infra/kong/kong.dev.yml`).

To route real login codes here, set `OTP_DELIVERY=notification` (and `NOTIFICATION_INTERNAL_URL`) in `services/auth-service/.env`. With the defaults (`SMS_PROVIDER=console`, no Telegram token) the code is printed in this service's log under `DEV SMS (console provider, …)`.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `pnpm test` | `tests/unit/security.test.ts`: report signatures, sealing, phone hashing, SMS template length, config rules | nothing |
| `pnpm test:integration` | `tests/integration/notification.test.ts`: real app and real Postgres; fake Telegram/SMS/push, in-memory OTP store (no Redis), movable clock, local ES256 key set | Postgres on `localhost:5432` (`make infra-up`) |
| `pnpm lint`, `pnpm typecheck` | ESLint on `src`, `tsc --noEmit` | |

The integration global setup drops and recreates `notification_service_test` (refuses any name not ending in `_test`) and runs `prisma migrate deploy`. Files run serially; test timeout 30 s, hook timeout 120 s (`vitest.integration.config.ts`). The Kafka consumer is not exercised: tests call `c.handlers[topic](event)` directly.

## Build and deploy

- `pnpm build` → `dist/` (`tsc -p tsconfig.json`). Build workspace libs first: `pnpm turbo run build --filter=@ride-app/notification-service...`.
- Image: `docker build -f services/notification-service/Dockerfile -t ride-app/notification-service .` from the **repo root**. Two stages; runtime is `node:24-alpine`, non-root user `app`, `EXPOSE 3006`, `HEALTHCHECK` = `wget http://localhost:3006/health` every 15 s, `CMD node dist/server.js`. The image contains `prisma/` but the Prisma CLI is a devDependency and is not installed by `pnpm deploy --prod`, so migrations are run outside the container.
- `infra/docker/docker-compose.yml` (`make stack-up`) builds the image with `env_file: ../../.env` and `depends_on: [redpanda]` only, and publishes no port.
- Kubernetes: `infra/k8s/base` has generic manifests; nothing specific to this service was found.

## Health

| Endpoint | Checks |
|---|---|
| `/health`, `/health/live` | process up |
| `/health/ready` | Postgres `SELECT 1` → 200 or 503 |

Redis, Kafka and providers are not part of readiness. The admin System page (platform-service) shows `/health/ready`, consumer-group lag for `notification-service`, and `/internal/ops/integrations`.

## Logging

pino, name `notification-service`, pretty-printed outside production (`libs/shared-utils/src/logger.ts`). Fastify request logging is on (the logger is passed as `loggerInstance`). Messages worth alerting on:

| Message | Level | Meaning |
|---|---|---|
| `telegram gateway balance is low: top up the account` | warn | `remaining_balance` below `TELEGRAM_BALANCE_ALERT_USD` |
| `otp sms failed` | error | SMS provider refused a login code |
| `otp delivery failed` / `otp fallback failed` / `fallback poll failed` | error | unexpected error in the background send or the poller (often Redis or Postgres) |
| `otp not delivered and SMS fallback is disabled` | warn | Telegram did not deliver and `sms` is not in the live channels |
| `notification failed, will retry` / `notification failed permanently` | error | push/SMS from an event failed (attempt n / 5) |
| `skipping malformed event` | error | non-JSON or no `eventId` on a topic |
| `TELEGRAM_GATEWAY_TOKEN not set…`, `SMS_PROVIDER=console…`, `KAFKA_BROKERS not set…` | warn | start-up configuration notices |
| `settings refresh failed…`, `permission matrix refresh failed…` | warn | platform-service / auth-service unreachable |

Codes are not logged except by the console SMS provider. Phone numbers are masked.

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Process exits at start with a Zod error | missing/invalid env (keys not 64 hex chars, production rules) | [configuration.md](configuration.md) |
| Process exits at start, Kafka error | `consumer.start()` is not wrapped in a catch in `src/server.ts`; brokers unreachable | broker address, Redpanda up |
| auth-service logs `request rejected by notification-service` with 401 | `INTERNAL_SERVICE_TOKEN` differs between the two services | rerun `make secrets` |
| `400 no delivery channel available` | SMS needed but not in `otp.channels` (e.g. Telegram-only and a resend) | admin Settings, `OTP_CHANNELS` |
| Every Telegram code also arrives by SMS | no delivery reports: `TELEGRAM_CALLBACK_URL` unset or not reachable, or signature rejected (401 in logs) | Kong route, public HTTPS, token |
| Webhook returns 404 | `TELEGRAM_GATEWAY_TOKEN` unset, so the route is not registered | env |
| Webhook returns 401 | wrong token, body altered by a proxy, or server clock off by > 5 min | NTP, Kong config |
| No SMS fallback after a crash | none expected: the schedule is in Redis; the poller resumes on restart. If Redis was flushed, pending fallbacks and active codes are lost | Redis persistence |
| Pushes not arriving | user has no `device_token` (row status `SKIPPED`), `PUSH_PROVIDER=console`, or FCM errors (`notification.error`) | `SELECT * FROM notification WHERE user_id = …` |
| Consumer lag growing on one partition | a send keeps failing; the partition retries the same message up to 5 times per `(event, channel)` | `notification` rows with `attempts > 0` |
| `smsFallbackRate` always `null` on the System page | known code issue (case mismatch in `status()`) | [api.md](api.md#get-internalopsintegrations) |

## Key rotation

From [docs/production/README.md](../../../docs/production/README.md): rotating `PHONE_HASH_KEY` only breaks the resend lookup for codes in flight; rotating `OTP_ENCRYPTION_KEY` drops codes in flight (they read as absent, `getCode` returns null). Both follow from `src/lib/crypto.ts` and `src/otp/otp-store.ts`.
