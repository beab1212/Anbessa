# auth-service

Identity for Anbessa on **[Better Auth](https://better-auth.com)**: phone OTP sign-in for the app, password + TOTP for staff, sessions, partner organisations, and short-lived **ES256 JWTs** published as a JWKS. Plus `/api/identity`, the operations Better Auth doesn't do: call-center guests, staff accounts, maker–checker staff roles, suspension, organisation verification.

Design: [docs/design/Auth.md](../../docs/design/Auth.md) (what was built: [§17](../../docs/design/Auth.md#17-implementation-notes-v1)) · roles and permissions: [docs/design/Role.md](../../docs/design/Role.md).

## Quick start (standalone, no other services needed)

Requires Node 24 (`nvm use`) and pnpm via `corepack enable` (see the root README's Toolchain table).

```bash
# 1. Start only the infra this service requires
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies (once)
pnpm install

# 3. Create .env and generate BETTER_AUTH_SECRET + INTERNAL_SERVICE_TOKEN (never overwrites)
make -C ../.. secrets

# 4. Apply migrations (creates the auth_service database if missing).
#    After editing schema.prisma: pnpm prisma migrate dev --name <change>
pnpm prisma migrate dev

# 5. Start with hot reload (tsx watch, loads libs/* TypeScript source directly)
pnpm dev

# 6. First staff login: create a super admin (works until two exist)
pnpm bootstrap:super-admin --email you@anbessa.et --name "Your Name"

# …or, for local work, ready-made staff and partner accounts for the web app's dev sign-in
pnpm seed:dev
```

Service URL: http://localhost:3001 · health: `/health`, `/health/ready` (checks the database).

With `OTP_DELIVERY=console` (the default), login codes are printed in the log. See [docs/development/README.md](../../docs/development/README.md#phone-sign-in-during-development) for a curl walkthrough.

> **Working across the full stack?** From the repo root, run `make dev-services` instead. It starts all services together.

---

## HTTP surface

| Prefix | Who | What |
|---|---|---|
| `/api/auth/*` | Phone app (bearer session) | Better Auth **app surface**: `phone-number/send-otp`, `phone-number/verify`, `token` (15-min JWT, `aud=ride-app`), `jwks`, sessions, self-service fleet/corporate organisations and invitations |
| `/api/admin-auth/*` | Staff dashboard (cookie) | Better Auth **admin surface**: `sign-in/email`, `change-password`, `two-factor/*`, `token` (10-min JWT, `aud=ride-admin`) |
| `/api/identity/*` | Staff dashboard (staff JWT) | Guests, staff accounts, role requests/approvals/revocation, suspension, organisation verification. Administration: the approvals inbox (`/approvals`), the live permission matrix (`GET /authz`, changes proposed at `POST /authz/changes`, dry run at `/authz/preview`), the user directory (`/users`, `/users/:id`, sign out everywhere, MFA reset) and aggregates (`/stats`) |
| `/internal/*` | Other services (`INTERNAL_SERVICE_TOKEN`) | Driver role on activation; an organisation's kind, status, city and legal name; whether a user is a member (fleet-service); the permission matrix snapshot every service loads (`/internal/authz/snapshot`); cities from platform-service (`PUT /internal/cities/:id`); outbox backlog for the system page. Never routed by Kong |
| `/api/dev/*` | Web app dev sign-in, **development only** | `accounts` (the `seed:dev` roster) and `code` (current TOTP of a dev staff account, last console OTP of a phone). Mounted only with `DEV_LOGIN=on`, which config refuses in production; never routed by Kong |

Only allowlisted Better Auth endpoints are served (`src/auth/allowlist.ts`). Everything else is 404, including every admin-plugin endpoint. The full route table is in [Auth.md §17](../../docs/design/Auth.md#identity-api).

### How access is secured

- **Two surfaces, two audiences.** A session belongs to one surface. App tokens never work on staff APIs, and app sessions can't mint admin tokens.
- **Staff roles need 2FA and a changed initial password.** Until then, the admin token has `roles: []` and a `setup` claim.
- **Every staff role is maker–checker.** One super admin requests, another approves, and the identity service executes the grant in one transaction (state + `permissionVersion` + outbox + audit). Better Auth can't change staff organisations at all.
- **Authorization uses `libs/shared-authz`** with scopes (`SELF` / `ORG` / `CITY` / `GLOBAL`). Super admin manages people. It isn't "can do everything".
- **Revocation is fast.** Role changes bump `pv`, and older tokens are refused. Suspension deletes all sessions and sets the Redis denylist, so existing JWTs are refused at once.
- **Minimal tokens.** `sub`, `roles`, `pv`, `amr` only. No name, phone or email.

---

## Project layout

```
src/
├── auth/           Better Auth: instances (two surfaces), allowlist, claims, org hooks,
│                   access control from shared-authz, OTP delivery, password hashing
├── identity/       identity domain operations (service.ts), all authorised with shared-authz
├── http/           Better Auth mount + guards, /api/identity and /internal routes, JWT principal
├── outbox/         outbox writes and the Kafka relay (FOR UPDATE SKIP LOCKED)
├── lib/            errors, Redis secondary storage, deny/pv security signals
├── cli/            bootstrap-super-admin
├── dev/            development-only accounts, seed:dev (DEV_LOGIN)
├── config/         env → typed config (Zod). Refuses insecure settings in production
├── middlewares/    error handler (registered before routes)
├── generated/      Prisma client output (gitignored, created by `prisma generate`)
├── container.ts    composition root: builds every dependency from config
├── app.ts          builds the Fastify instance from dependencies, no listen() (testable)
└── server.ts       loads config, starts the outbox relay, listens, graceful shutdown
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start with hot reload (tsx watch) |
| `pnpm build` | Compile TypeScript → dist/ (build libs first: `pnpm turbo run build --filter=@ride-app/auth-service...`) |
| `pnpm start` | Run compiled output (production) |
| `pnpm test` | Unit tests (no database needed) |
| `pnpm test:integration` | Integration tests against a throwaway `auth_service_test` database (needs Postgres: `make infra-up`) |
| `pnpm lint` / `pnpm typecheck` | ESLint / type-check only |
| `pnpm bootstrap:super-admin --email … --name …` | Create one of the first two super admins |
| `pnpm seed:dev` | Development accounts (staff with password + authenticator and roles, fleet and company partners) for the web app's dev sign-in. Runs only with `NODE_ENV=development`; run again to reset them |
| `pnpm prisma migrate dev --name <change>` | New migration after editing `schema.prisma` |
| `pnpm prisma studio` | Open Prisma DB browser |

---

## Data and migrations

- Tables follow Better Auth's core and plugin models (`app_user`, `session`, `account`, `verification`, `jwks`, `two_factor`, `organization`, `member`, `invitation`) plus ours: `city`, `approval_request`, `outbox`. Snake_case via `@map`, UUIDv7 ids.
- `20261025120000_better_auth_identity` migrates the old `User` table (roles `RIDER → rider`, `DRIVER → driver`, `ADMIN → super_admin`, password hashes → credential accounts), adds check constraints and partial unique indexes, and seeds the city `addis-ababa` with its staff organisation.
- Prisma 7: `prisma.config.ts` holds the paths and `DATABASE_URL`. The client is generated to `src/generated/prisma` and used through `@prisma/adapter-pg` (`src/db.ts`).

---

## Docker image

Build from the **repo root** so the workspace libs are in the build context:

```bash
docker build -f services/auth-service/Dockerfile -t ride-app/auth-service .
```

The image is `node:24-alpine`. The build stage uses pnpm (`pnpm deploy --prod`), and the runtime stage ships only `dist/` and production `node_modules`.

---

## Environment variables

See `.env.example`: every variable is documented there. Production rules (https base URL, Redis, Kafka, service token, real OTP delivery, rate limits on) are enforced at start-up. See [docs/production/README.md](../../docs/production/README.md#5-configuration-reference).
Never commit a `.env` file with real secrets.
