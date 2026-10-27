# Production checklist

What each service refuses when `NODE_ENV=production`, which secrets it needs, and what the repo
has (or lacks) for TLS, scaling and observability. Every service validates its environment with Zod
at start (`src/config/index.ts`), so a refused or missing value stops the process and crash-loops
the pod. Blank values (`KEY=`) count as unset.

The broader release process and the full configuration reference are in
[docs/production/README.md](../../docs/production/README.md); this page is the per-service view
taken from the config code.

## 1. Production refusals per service

| Service | Refused / required when `NODE_ENV=production` | Always required (any environment) |
|---------|-----------------------------------------------|-----------------------------------|
| auth-service | `OTP_DELIVERY=console`; missing `REDIS_URL`; missing `KAFKA_BROKERS`; missing `INTERNAL_SERVICE_TOKEN`; `AUTH_RATE_LIMIT=off`; `DEV_LOGIN=on`; `AUTH_BASE_URL` not `https://` | `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥ 32 chars), `AUTH_BASE_URL`. `NOTIFICATION_INTERNAL_URL` and `INTERNAL_SERVICE_TOKEN` when `OTP_DELIVERY=notification`. `DEV_LOGIN=on` needs `OTP_DELIVERY=console` |
| trip-service | `PRICING=builtin`; `SHARE_BASE_URL` starting with `http://localhost` or `http://127.` (its default is `http://localhost:5173`, so it **must be set** to the public web app URL); missing `KAFKA_BROKERS` | `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_TOKEN` (≥ 32). `MATCH_RADII_METERS` each 100–20000 |
| location-service | missing `KAFKA_BROKERS` | `REDIS_URL`, `INTERNAL_SERVICE_TOKEN` |
| pricing-service | missing `KAFKA_BROKERS` | `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_TOKEN` |
| payment-service | `GATEWAY_MODE=simulated`; missing `KAFKA_BROKERS`; missing `REDIS_URL` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `TELEBIRR_WEBHOOK_SECRET`, `CBEBIRR_WEBHOOK_SECRET`, `CHAPA_WEBHOOK_SECRET` (each ≥ 32 and all different) |
| notification-service | `SMS_PROVIDER=console`; `PUSH_PROVIDER=console`; missing `KAFKA_BROKERS`; with `telegram` in `OTP_CHANNELS`: missing `TELEGRAM_GATEWAY_TOKEN`, or `TELEGRAM_CALLBACK_URL` not `https://` | `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SERVICE_TOKEN`, `PHONE_HASH_KEY` and `OTP_ENCRYPTION_KEY` (32 bytes hex). `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` for `SMS_PROVIDER=twilio`; `FCM_PROJECT_ID` + `FCM_CLIENT_EMAIL` + `FCM_PRIVATE_KEY` for `PUSH_PROVIDER=fcm` |
| mapping-service | missing `REDIS_URL` | `INTERNAL_SERVICE_TOKEN` |
| fleet-service | `STORAGE=local`; missing `KAFKA_BROKERS`; missing `REDIS_URL` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY`, `UPLOAD_SIGNING_KEY` (32 bytes hex each, all different). `S3_BUCKET` when `STORAGE=s3` |
| audit-service | missing `KAFKA_BROKERS` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| support-service | missing `REDIS_URL`; missing `KAFKA_BROKERS` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| platform-service | missing `REDIS_URL`; missing `KAFKA_BROKERS` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| realtime-gateway | none (no production checks in `src/config/index.ts`) | `REDIS_URL`. `KAFKA_BROKERS` optional: without it `driver.location` is not published (a warning is logged) |

**payment-service cannot start in production today.** `GATEWAY_MODE` is `z.enum(["simulated"])`,
the only value, and `simulated` is refused in production. Real provider adapters
(`services/payment-service/src/gateways/*.ts`) and a new mode are needed first.

Other production behaviour in code:

- auth-service sets secure cookies (`useSecureCookies: NODE_ENV === "production"`, `src/auth/instances.ts`).
- `seed:dev` in auth-service and fleet-service refuses unless `NODE_ENV=development`.
- location-service registers `/internal/dev/*` routes only when `NODE_ENV=development`.
- payment-service's simulator routes are only active when `GATEWAY_MODE=simulated` and not in production.
- Kafka consumers don't create topics in production; create them before the first deploy
  ([data-stores.md](data-stores.md)).

## 2. Required secrets (names only)

| Secret | Services | Format |
|--------|----------|--------|
| `INTERNAL_SERVICE_TOKEN` | all 11 (same value everywhere) | ≥ 32 chars |
| `DATABASE_URL` | auth, trip, payment, notification, fleet, audit, platform, support (one database each) | Postgres URL |
| `BETTER_AUTH_SECRET` | auth | ≥ 32 chars, unique per environment |
| `PHONE_HASH_KEY`, `OTP_ENCRYPTION_KEY` | notification | 32 bytes hex |
| `TELEGRAM_GATEWAY_TOKEN` | notification | ≥ 16 chars |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | notification | |
| `FCM_PRIVATE_KEY` (with `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`) | notification | PEM, `\n` escapes accepted |
| `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY`, `UPLOAD_SIGNING_KEY` | fleet | 32 bytes hex, all different |
| `TELEBIRR_WEBHOOK_SECRET`, `CBEBIRR_WEBHOOK_SECRET`, `CHAPA_WEBHOOK_SECRET` | payment | ≥ 32 chars, all different |
| `REGISTRY_USER`, `REGISTRY_TOKEN` | GitHub Actions (`deploy.yml`) | |

Not read by any service, although they appear in the root `.env.example`: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `FCM_SERVER_KEY`, `TILESERVER_URL`. Where secrets come from in each
environment: `infra/README.md` ("Secrets management") and [kubernetes.md](kubernetes.md) section 3.

## 3. TLS

- No TLS termination, certificates, ingress or load balancer config was found in repo. Kong listens on
  plain HTTP `:8000` in both compose files.
- What the code enforces: `AUTH_BASE_URL` must be `https://` (auth-service) and `TELEGRAM_CALLBACK_URL`
  must be `https://` when Telegram is enabled (notification-service).
- Service-to-service traffic uses plain HTTP with `INTERNAL_SERVICE_TOKEN`; config comments call it
  interim "until mTLS".
- `REDIS_URL` accepts `rediss://` (any URL passes the schema); `DATABASE_URL` TLS is set through the
  URL. [docs/production/README.md](../../docs/production/README.md) asks for both.
- Public URLs the providers and the apps need over HTTPS: `PUBLIC_URL` (payment webhooks
  `/api/payments/webhooks/{provider}`), `TELEGRAM_CALLBACK_URL`, `SHARE_BASE_URL`, the API and WS
  hosts in `apps/phone-app/env/staging.json`.

## 4. Scaling notes

- Kubernetes: only trip-service has a Deployment and HPA (2–10 replicas at 70 % CPU). See
  [kubernetes.md](kubernetes.md) for the replica/HPA interaction in the overlays.
- realtime-gateway scales horizontally through the Socket.io Redis adapter; trip-service must use the
  same Redis for its emitter.
- Background loops coordinate through Redis locks (trip matching leases, location sweeper per city),
  so they tolerate several replicas.
- Kong rate limits are per Kong node (`policy: local`).
- Fastify rate limit inside services: auth, trip, location, pricing, payment, notification, fleet,
  audit and platform register `@fastify/rate-limit` with 300 requests/minute (`src/app.ts`), with no
  store configured, so the counter is per instance.

## 5. Observability

What exists in code:

- Logging: pino, via `libs/shared-utils/src/logger.ts`. With `NODE_ENV=production` the output is JSON
  on stdout at `info`; otherwise `pino-pretty` at `debug`. Each service's `src/utils/logger.ts`
  applies `LOG_LEVEL` on top; realtime-gateway ignores `LOG_LEVEL`. Kong in `make dev-gateway` logs
  access to stdout; the `stack-up` Kong uses Kong's defaults.
- Health: `/health`, `/health/live`, `/health/ready` on every service ([kubernetes.md](kubernetes.md) section 4).
- platform-service system page: polls every service's `/health/ready` (`SERVICE_URLS`), outbox
  backlogs (`/internal/ops/outbox`), integrations and storage checks, and Kafka consumer-group lag
  (`CONSUMER_GROUPS`) (`services/platform-service/src/system/health.ts`).
- realtime-gateway's `/health/ready` includes Kafka publisher stats.
- notification-service logs a warning when the Telegram Gateway balance drops below
  `TELEGRAM_BALANCE_ALERT_USD`.

Not found in repo: Prometheus metrics endpoints, OpenTelemetry tracing, dashboards, alert rules, a
log shipper config.

## 6. Checklist

- [ ] `NODE_ENV=production` in every service's ConfigMap.
- [ ] Every value in section 1 set, and none of the refused ones.
- [ ] `SHARE_BASE_URL` set on trip-service to the public web app URL.
- [ ] Real payment adapters and a non-simulated `GATEWAY_MODE` (payment-service won't start otherwise).
- [ ] Secrets from section 2 in the secrets manager, synced to `<svc>-secrets`.
- [ ] Kafka topics created ahead of time.
- [ ] Migrations applied before rollout (`prisma migrate deploy` per Prisma service).
- [ ] Manifests for all 11 services, Kong and the mapping stack ([kubernetes.md](kubernetes.md)).
- [ ] fleet-service, platform-service, audit-service and support-service added to the deploy matrix ([ci-cd.md](ci-cd.md)).
- [ ] `.github/` removed from `.gitignore`.
- [ ] Image tags set from the git SHA; cluster credentials in the deploy jobs.
- [ ] Terraform modules written; S3 documents bucket, TLS and ingress defined somewhere.
- [ ] Readiness probes switched to `/health/ready` if pods should leave rotation when their database
      or Redis is down (the base uses `/health`).
- [ ] Log shipping, metrics and alerting decided.
