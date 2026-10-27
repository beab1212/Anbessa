# Operations

## Run locally

Standalone (the service's own README has the full quick start):

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres (postgis 18), Redis 8, Redpanda on 5432 / 6379 / 9092
pnpm install                                       # runs prisma generate
make -C ../.. secrets                              # .env with BETTER_AUTH_SECRET + INTERNAL_SERVICE_TOKEN
pnpm prisma migrate dev                            # creates auth_service and applies migrations
pnpm dev                                           # tsx watch on src/server.ts, http://localhost:3001
pnpm bootstrap:super-admin --email you@anbessa.et --name "Your Name"   # or: pnpm seed:dev
```

Whole stack: `make infra-up`, `make db-migrate`, `make dev-services` from the repo root. `make dev-gateway` puts Kong (:8000) in front, using the generated `infra/kong/kong.dev.yml`.

With `OTP_DELIVERY=console`, OTP codes appear in the log as `DEV OTP (console delivery, never enabled in production)` with the masked phone and the code. With `DEV_LOGIN=on`, `GET /api/dev/code?phone=…` returns the last one.

### Start-up sequence (`src/server.ts`)

1. Load and validate config (exit on error).
2. Build the container (Prisma, Redis, Better Auth instances, services).
3. Seed the permission matrix if `role_definition` is empty (`permission matrix seeded from libs/shared-authz`).
4. Start the authz sync (loads the matrix, subscribes to `authz:changed`, 30 s poll).
5. Build the Fastify app.
6. Run the approval expiry sweep, then hourly.
7. Start the outbox relay if `KAFKA_BROKERS` is set, else warn.
8. Warn about `OTP_DELIVERY=console` and `DEV_LOGIN=on` if set.
9. Listen on `0.0.0.0:$PORT`.

Migrations are **not** applied at start. Apply them with `prisma migrate deploy` (`make db-migrate` does it for every Prisma service) before starting a new version.

### Super admins

`pnpm bootstrap:super-admin --email … --name …` creates a staff account with `super_admin`, `must_change_password = true`, and prints a one-time temporary password. It works only while fewer than two users hold `super_admin`. The person must sign in at the staff dashboard, change the password and enrol TOTP before their token carries any role.

### Development accounts

`pnpm seed:dev` (only with `NODE_ENV=development`, non-https `AUTH_BASE_URL`) upserts the accounts in `src/dev/accounts.ts`: staff with a fixed password and a shared TOTP secret, partner phones, the `dev-fleet` and `dev-corporate` organisations (`VERIFIED`). Run again to reset them; it bumps `permission_version` on existing accounts. It writes roles directly, skipping maker–checker.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `pnpm test` | Unit tests in `tests/unit` (Vitest) | nothing |
| `pnpm test:integration` | `tests/integration` against the real app via Fastify `inject` | Postgres. `global-setup.ts` drops and recreates `auth_service_test` (name must end in `_test`) and runs `prisma migrate deploy`; each test file then runs on its own copy (`CREATE DATABASE auth_service_test_<random> TEMPLATE auth_service_test`, dropped when the file ends), so rows one file leaves behind can't affect another. Files run sequentially; 30 s per test |
| `pnpm lint`, `pnpm typecheck` | ESLint on `src`, `tsc --noEmit` | |

The integration harness (`tests/integration/harness.ts`) uses `OTP_DELIVERY=console` with a sink that captures codes, in-memory `deny`/`pv` signals instead of Redis, `AUTH_RATE_LIMIT=off`, no Kafka (events stay in `outbox`, and tests read them from the table).

| File | Covers |
|---|---|
| `tests/unit/roles-codec.test.ts` | Splitting/joining stored roles; stored data → scoped assignments: SELF/GLOBAL/CITY/ORG, unknown roles, wrong org kind, expired memberships, suspended orgs, unverified partner orgs |
| `tests/unit/claims.test.ts` | Roles per surface, the 2FA and password gate, surface mismatch, banned users, minimal claims, fresh user read, `setup` claim, `g: true` |
| `tests/unit/allowlist-config.test.ts` | Endpoint allowlist; config rules (blank = unset, issuer default, short secret, production refusals, notification settings, dev login) |
| `tests/unit/guardrails.test.ts` | Permission-matrix guardrails |
| `tests/unit/dev-accounts.test.ts` | Dev roster vs seed, OTP inbox expiry |
| `tests/integration/auth.test.ts` | OTP sign-up and lockout, ES256 claims without PII, phone change refused, number validation, protected user fields, profile image, audience separation, endpoint lockdown, staff-org guard, internal token, staff 2FA/password gate, maker ≠ checker, city-scoped grant and `pv`, last-two-super-admins rule, guest create and claim, city scoping, suspension, staff suspension rules, fleet create → verify → invite by phone → join, corporate creator and TIN uniqueness, protected org fields, no staff orgs via Better Auth, internal driver role |
| `tests/integration/admin.test.ts` | Matrix change with approval and live effect, guardrails, who may propose, custom roles, approvals inbox (withdraw, expiry), directory with masked phones, sign out everywhere, MFA reset (immediate vs approval), staff sign-in audit and stats permission, city sync from platform-service |

Not covered by tests: the outbox relay against Kafka, Redis signals and secondary storage, the notification OTP sender, key rotation.

## Build and deploy

```bash
# from the repo root (workspace libs must be in the context)
docker build -f services/auth-service/Dockerfile -t ride-app/auth-service .
```

| Stage | What |
|---|---|
| `build` (`node:24-alpine`, corepack pnpm) | `pnpm fetch`, offline `pnpm install --frozen-lockfile --filter @ride-app/auth-service...`, build the service and its libs, `pnpm deploy --prod --legacy /out` |
| `runtime` (`node:24-alpine`) | `NODE_ENV=production`, non-root `app` user, copies `node_modules`, `dist`, `prisma`, `package.json`. `EXPOSE 3001`. `HEALTHCHECK` every 15 s: `wget -qO- http://localhost:3001/health`. `CMD node dist/server.js` |

`pnpm build` alone needs the libs built first: `pnpm turbo run build --filter=@ride-app/auth-service...`.

In `infra/docker/docker-compose.yml` (`make stack-up`) the service gets `env_file: ../../.env` and `DATABASE_URL=postgresql://ride:ride@postgres:5432/ride_app`, and depends on Postgres and Redpanda. Production deployment (Kubernetes, secrets) is described in [docs/production/README.md](../../../docs/production/README.md); no auth-service manifest was found under `infra/k8s`.

Production checklist from the code: `NODE_ENV=production`, https `AUTH_BASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `INTERNAL_SERVICE_TOKEN` (same value in the callers), `OTP_DELIVERY=notification` + `NOTIFICATION_INTERNAL_URL`, `AUTH_ISSUER` equal to what verifiers expect, origins set, migrations applied, two super admins bootstrapped.

## Health endpoints

| Path | Meaning | Use as |
|---|---|---|
| `/health` | process up | Docker `HEALTHCHECK` |
| `/health/live` | process up | liveness |
| `/health/ready` | Postgres answers `SELECT 1` (else 503) | readiness |

Redis and Kafka health are not reported. The outbox backlog is visible at `GET /internal/ops/outbox` (`{ pending, oldestAt }`), shown on platform-service's system page.

## Logging

pino via `@ride-app/shared-utils` `createLogger("auth-service", NODE_ENV)`: `pino-pretty` outside production, JSON in production; level from `LOG_LEVEL` (default `info`). Fastify request logging uses the same logger.

Messages worth knowing:

| Level | Message | Meaning |
|---|---|---|
| warn | `KAFKA_BROKERS not set: identity events stay in the outbox table until a relay runs` | No relay |
| warn | `OTP_DELIVERY=console: OTP codes are logged (development only)` | |
| warn | `DEV_LOGIN=on: /api/dev/* hands out sign-in codes …` | |
| warn | `DEV OTP (console delivery, never enabled in production)` | Contains the code |
| info | `permission matrix seeded from libs/shared-authz` | First start on an empty table |
| info | `permission matrix updated` | Sync loaded a new version |
| warn | `permission matrix refresh failed; keeping the current one` | Sync couldn't read the database |
| warn | `outbox relay: publish failed, will retry` | Kafka down or unreachable |
| warn | `security signal unavailable` | Redis error on `deny`/`pv` |
| warn | `couldn't publish authz:changed; services pick it up on their next poll` | Redis error after a matrix change |
| error | `request rejected by notification-service` / `notification-service request failed` | OTP delivery failed (masked phone, no code) |
| error | `approval expiry sweep failed` | |
| error | `unhandled error` | Any 500, with the request id |

## Metrics

No metrics endpoint or metrics library in the code.

## Common failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Process exits at start with a Zod error | Missing/invalid env var or a production rule | The error names the variable; see [configuration.md](configuration.md) |
| `/health/ready` 503 | Postgres down or wrong `DATABASE_URL` | `psql "$DATABASE_URL" -c 'select 1'` |
| Users don't receive OTP codes | `OTP_DELIVERY=console`, notification-service down, or token mismatch (401 there) | auth-service log for `notification-service request failed` / `request rejected`; notification-service logs |
| `send-otp` answers 429 | Better Auth limit (3/60 s) or Kong (60/min) | Wait; in tests set `AUTH_RATE_LIMIT=off` |
| Every `/internal/*` call 401 `invalid service credentials` | `INTERNAL_SERVICE_TOKEN` differs between caller and auth-service | Run `make secrets` locally; compare secrets in production |
| `/internal/*` 403 `internal API disabled` | `INTERNAL_SERVICE_TOKEN` not set in auth-service | |
| `/internal/*` 429 | Fastify limit, 300/min per source IP (shared by all calls from one caller pod) | Snapshot polling plus `/internal/users` lookups from busy callers |
| Other services reject every token `invalid_token` | `AUTH_ISSUER` mismatch, wrong `AUTH_JWKS_URL`, or the app token used on an admin route | Decode the JWT `iss`/`aud`; compare with the verifier config |
| A user's token fails with `token_outdated` | Their roles changed (`pv` bumped) | Client should call `/token` again; this is expected |
| Staff token has `roles: []` | 2FA not enabled or initial password not changed (see the `setup` claim) | `GET /api/identity/users/:id` → `twoFactorEnabled`, `mustChangePassword` |
| Granted role missing from tokens | City role requested without the right `cityId`, the org isn't `VERIFIED` (partner roles), the membership expired, or the role is archived | `GET /api/identity/users/:id` → `roles`, `memberships` |
| `/token` 403 `session does not belong to this surface` | App session used on `/api/admin-auth/token` or vice versa | |
| Events not reaching consumers | `KAFKA_BROKERS` unset or Kafka down | `GET /internal/ops/outbox` (pending, oldestAt); `SELECT count(*) FROM outbox WHERE published_at IS NULL` |
| Suspended user still gets through for a few minutes | Redis unavailable (no `deny`/`pv` keys) | Sessions are still deleted; JWTs expire within 15 min |
| Matrix change not visible in another service | Redis pub/sub missed | Wait for the 30 s poll; check that service's `permission matrix refresh failed` warnings |
| First start of several replicas on an empty database: one crashes | `ensureAuthzSeeded` isn't locked; two replicas insert the same built-in roles (unique violation) | The restarted replica sees a seeded table and starts normally |
| Approve returns 409 `expired` | Request older than 7 days (the sweep marks it `EXPIRED` within an hour) | Ask again |
| `seed:dev` fails `no staff organisation for addis-ababa` | Migrations not applied | `pnpm prisma migrate dev` |

## Troubleshooting queries

```sql
-- outbox backlog
SELECT topic, count(*), min(created_at) FROM outbox WHERE published_at IS NULL GROUP BY topic;

-- a user's stored roles and memberships
SELECT id, email, phone_number, role, banned, permission_version, two_factor_enabled, must_change_password
FROM app_user WHERE id = '<uuid>';
SELECT o.kind, o.city_id, o.status, m.role, m.valid_until
FROM member m JOIN organization o ON o.id = m.organization_id WHERE m.user_id = '<uuid>';

-- pending approvals
SELECT id, action, payload, maker_id, expires_at FROM approval_request WHERE status = 'PENDING' ORDER BY created_at;

-- current matrix version
SELECT version FROM authz_version;
```

```bash
redis-cli GET pv:<userId>      # latest permission version
redis-cli EXISTS deny:<userId> # 1 while suspended (≤ 30 min)
redis-cli SUBSCRIBE authz:changed
```
