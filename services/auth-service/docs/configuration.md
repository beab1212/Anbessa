# Configuration

All configuration is environment variables, validated with Zod at start (`src/config/index.ts`). An invalid or missing value stops the process. A variable set to an empty string (`KEY=` as in `.env.example`) counts as **not set**.

`pnpm dev` loads `.env` with `--env-file-if-exists=.env`; `prisma.config.ts` loads it with `dotenv`. `make secrets` (`scripts/dev-secrets.sh`) creates `.env` from `.env.example` and fills `BETTER_AUTH_SECRET` and `INTERNAL_SERVICE_TOKEN`; it also copies the same `INTERNAL_SERVICE_TOKEN` into the services that receive `/internal/*` calls.

## Variables

| Variable | Type / allowed values | Default | Production | Meaning |
|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | `production` | Enables the production rules below, secure cookies, and the logger's production mode |
| `PORT` | positive integer | `3001` | | HTTP port (listens on `0.0.0.0`) |
| `LOG_LEVEL` | string | `info` | | pino level; overrides the logger default |
| `DATABASE_URL` | URL | — (**required**) | required | Postgres connection (also used by `prisma migrate`) |
| `BETTER_AUTH_SECRET` | string, ≥ 32 characters | — (**required**) | required, unique per environment | Encrypts JWKS private keys and TOTP secrets, signs cookies. Rotating it needs a key migration ([Auth.md §12](../../../docs/design/Auth.md#12-security)) |
| `AUTH_BASE_URL` | URL | — (**required**) | must start with `https://` | Public base URL (Better Auth `baseURL`) and default issuer |
| `AUTH_ISSUER` | URL, optional | `AUTH_BASE_URL` | | `iss` of every JWT; verifiers in other services must use the same value |
| `AUTH_INTERNAL_URL` | URL, optional | `http://localhost:${PORT}` | | Parsed but **not used** by auth-service (tokens are verified in process) |
| `APP_TRUSTED_ORIGINS` | comma-separated list | empty | the web app origin | Better Auth `trustedOrigins` for the app surface; also allowed by CORS |
| `ADMIN_TRUSTED_ORIGINS` | comma-separated list | empty | the web app origin only | `trustedOrigins` for the admin surface; also allowed by CORS |
| `REDIS_URL` | URL, optional | unset | **required** | Better Auth secondary storage, shared rate limits, `deny`/`pv` signals, `authz:changed`. ioredis with `maxRetriesPerRequest: 2` |
| `KAFKA_BROKERS` | comma-separated host:port, optional | unset | **required** | Starts the outbox relay. Unset → events stay in `outbox` (warning logged) |
| `OTP_DELIVERY` | `notification` \| `console` | `console` | must be `notification` | `console` logs codes (warning at start) |
| `NOTIFICATION_INTERNAL_URL` | URL, optional | unset | required with `notification` | notification-service base URL |
| `INTERNAL_SERVICE_TOKEN` | string ≥ 32, optional | unset | **required** | Accepted bearer on `/internal/*` and sent to notification-service. Unset → `/internal/*` answers 403 |
| `TRUSTED_PROXIES` | comma-separated IPs / CIDR ranges | loopback + private ranges (`DEV_TRUSTED_PROXIES`: `127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7`) | **required** (Kong's / the ingress network) | Better Auth `advanced.ipAddress.trustedProxies` and Fastify `trustProxy`. The client IP is the rightmost `X-Forwarded-For` entry outside these ranges. Without it Better Auth trusts only a single-entry header and every proxied request lands in one shared rate-limit bucket. Invalid entries are refused at start |
| `AUTH_RATE_LIMIT` | `on` \| `off` | `on` | must be `on` | Better Auth rate limiting and the per-phone OTP limits (tests turn it off) |
| `DEV_LOGIN` | `on` \| `off` | `off` | must be `off` | Mounts `/api/dev/*` and keeps console OTPs in memory |

`.env.example` sets `NODE_ENV=development`, `PORT=3001`, `LOG_LEVEL=debug`, a local `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_BASE_URL=http://localhost:3001`, both origin lists `http://localhost:5173`, `OTP_DELIVERY=console`, `NOTIFICATION_INTERNAL_URL=http://localhost:3006`, `DEV_LOGIN=on`, a blank `TRUSTED_PROXIES` (development default), and leaves the two secrets blank. It does not list `AUTH_ISSUER`, `AUTH_INTERNAL_URL` or `AUTH_RATE_LIMIT`.

## Cross-field rules

Enforced in `superRefine` (`src/config/index.ts`), covered by `tests/unit/allowlist-config.test.ts`:

| Condition | Rule |
|---|---|
| `NODE_ENV=production` | `OTP_DELIVERY ≠ console`; `REDIS_URL`, `KAFKA_BROKERS`, `INTERNAL_SERVICE_TOKEN` set; `AUTH_RATE_LIMIT ≠ off`; `DEV_LOGIN ≠ on`; `AUTH_BASE_URL` starts with `https://`; `TRUSTED_PROXIES` set |
| always | every `TRUSTED_PROXIES` entry is an IP address or CIDR range |
| `DEV_LOGIN=on` | `OTP_DELIVERY=console` |
| `OTP_DELIVERY=notification` | `NOTIFICATION_INTERNAL_URL` and `INTERNAL_SERVICE_TOKEN` set |

## Script-only variables

| Variable | Used by | Default |
|---|---|---|
| `TEST_DATABASE_URL` | integration tests (`tests/integration/global-setup.ts`); the database name must end in `_test` (it is dropped and recreated) | `postgresql://ride:ride@localhost:5432/auth_service_test` |

`seed:dev` refuses to run unless `NODE_ENV=development` and `AUTH_BASE_URL` is not `https://`.

## Fixed in code (not configurable)

| Setting | Value | Where |
|---|---|---|
| App session | 30 days, refreshed after 1 day | `src/auth/instances.ts` |
| Admin session | 12 h, refreshed after 1 h | same |
| JWT lifetime | app 15 min, admin 10 min | same |
| JWT keys | ES256, rotate 90 days, grace 30 days | same |
| OTP | 6 digits, 5 min, 3 attempts | same |
| Staff password | 12–128 characters, argon2id | same, `src/auth/password.ts` |
| Invitations | expire after 7 days; 5000 members per organisation | same |
| Approvals | expire after 7 days, swept hourly | `src/identity/approvals.ts`, `src/server.ts` |
| Rate limits | see [api.md](api.md#rate-limits) | `src/app.ts`, `src/auth/instances.ts` |
| Body limit | 64 KB | `src/app.ts` |
| Outbox relay | every 500 ms, batches of 100 | `src/outbox/relay.ts` |
| Denylist / pv TTL | 30 min / 24 h | `src/lib/signals.ts` |
| Cookie prefixes | `anb` (app), `anb-admin` (admin) | `src/auth/instances.ts` |

## Runtime settings from platform-service

None. auth-service does not depend on `libs/shared-settings` and reads no platform settings. Its only live, database-backed configuration is the permission matrix it owns.
