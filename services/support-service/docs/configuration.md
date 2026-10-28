# Configuration

Read by `src/config/index.ts` (zod). A blank value (`KEY=`) counts as unset. `.env.example` lists every key; `make secrets` creates `.env` and copies `INTERNAL_SERVICE_TOKEN` from auth-service.

| Variable | Purpose | Default | Required | Notes |
|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | none: **required** (`nodeEnvSchema`) | yes | production refuses a missing `REDIS_URL` or `KAFKA_BROKERS` |
| `TRUST_PROXY` | hop count, or comma-separated proxy IPs/CIDRs | `1` (Kong) |  | `true` refused (`trustProxyFromEnv`) |
| `KAFKA_SSL`, `KAFKA_SSL_CA`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | Kafka TLS/SASL (`kafkaClientConfig`) | off / unset | in production | TLS and SASL required in production; see infra/docs/data-stores.md |
| `PORT` | HTTP port | `3009` | | |
| `LOG_LEVEL` | pino level | from `NODE_ENV` | | |
| `DATABASE_URL` | Postgres `support_service` | | yes | also read by `prisma.config.ts` |
| `REDIS_URL` | deny list / permission versions; Socket.io emitter; authz change channel | unset | production | without it: suspended users are refused only when their token expires, no pushes |
| `KAFKA_BROKERS` | CSV of brokers: outbox relay and refund consumer | unset | production | without it events wait in `outbox`, refund outcomes don't arrive |
| `INTERNAL_SERVICE_TOKEN` | calls to trip-service and auth-service; guards `/internal/*` | | yes (≥ 32 chars) | |
| `AUTH_ISSUER` | JWT issuer | `http://localhost:3001` | | |
| `AUTH_JWKS_URL` | JWKS | `http://localhost:3001/api/auth/jwks` | | |
| `AUTH_INTERNAL_URL` | permission matrix snapshot | `http://localhost:3001` | | |
| `TRIP_INTERNAL_URL` | trip facts | `http://localhost:3002` | | in-cluster URL in production |

Fixed in code (`src/support/policy.ts`, `LIMITS`), not configurable yet: SLAs per category, the 7-day reopen and auto-close windows, the 72 h no-reply timeout, the 7-day lost-item window, the 48 h not-found close, SOS 30 min after drop-off, the 2-minute SOS dedupe window, the 60 s acknowledgement target and the 90-day not-found lookback. Moving them to platform-service live settings is a follow-up.
