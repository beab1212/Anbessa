# Configuration

Parsed by `loadConfig()` in `src/config/index.ts` (Zod). Blank values count as unset. Invalid configuration stops the process at start. `make secrets` copies `INTERNAL_SERVICE_TOKEN` from auth-service into `.env` (comment in `.env.example`).

| Variable | Meaning | Default | Required | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test`, `production` | none: **required** | yes | enum (`nodeEnvSchema`) |
| `TRUST_PROXY` | hop count, or comma-separated proxy IPs/CIDRs | `1` (Kong) |  | `true` refused (`trustProxyFromEnv`) |
| `KAFKA_SSL`, `KAFKA_SSL_CA`, `KAFKA_SASL_MECHANISM`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD` | Kafka TLS/SASL (`kafkaClientConfig`) | off / unset | in production | TLS and SASL required in production; see infra/docs/data-stores.md |
| `PORT` | HTTP port | `3010` | no | number |
| `LOG_LEVEL` | pino level override | `info` in production, else `debug` | no | string |
| `DATABASE_URL` | Postgres URL (`audit_service`) | — | **yes** | URL |
| `KAFKA_BROKERS` | comma-separated brokers | unset (no consumer, warning) | **yes in production** | CSV |
| `REDIS_URL` | Redis written by auth-service (deny list, permission versions, `authz:changed`) | unset (those checks skipped, matrix polled only) | no | URL |
| `INTERNAL_SERVICE_TOKEN` | bearer token for auth-service's `/internal/authz/snapshot` | — | **yes** | ≥ 32 chars |
| `AUTH_ISSUER` | expected token issuer | `http://localhost:3001` | no | URL |
| `AUTH_JWKS_URL` | JWKS URL | `http://localhost:3001/api/auth/jwks` | no | URL |
| `AUTH_INTERNAL_URL` | auth-service base URL | `http://localhost:3001` | no | URL |

Only production rule: `KAFKA_BROKERS` must be set. `REDIS_URL` is optional even in production, which means a production instance without it accepts tokens of suspended users until they expire.

Test-only: `TEST_DATABASE_URL` (default `postgresql://ride:ride@localhost:5432/audit_service_test`, must end in `_test`).

## Hard-coded values

| Value | Where |
|---|---|
| Partitions: current month + 2 ahead, maintained every 24 h | `src/server.ts`, migration |
| Page size 1–200, default 50; CSV max 50 000 rows | `src/http/routes.ts`, `src/store.ts` |
| Rate limit 300/min, body 32 KiB | `src/app.ts` |
| Field length limits (action 80, resource type 60, id 200, reason 2000, service 60) | `src/store.ts` |
