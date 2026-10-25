# auth-service

## Quick start — standalone, no other services needed

Requires Node 24 (`nvm use`) and pnpm via `corepack enable` (see the root README's Toolchain table).

```bash
# 1. Start only the infra this service requires
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies (once)
pnpm install

# 3. Copy the env file and create the local dev JWT key pair (paths match .env.example)
cp .env.example .env
make -C ../.. secrets      # never overwrites existing keys; see docs/development/README.md

# 4. Apply migrations (creates the auth_service database if missing).
#    After editing schema.prisma: pnpm prisma migrate dev --name <change>
pnpm prisma migrate dev

# Start with hot reload (tsx watch — loads libs/* TypeScript source directly)
pnpm dev
```

Service URL  : http://localhost:3001
Health check : http://localhost:3001/health

> **Working across the full stack?**
> From the repo root, run `make dev-services` instead —
> it starts all services together.

---

## Project layout

```
src/
├── config/         env → typed config object (Zod, fails fast at boot)
├── routes/         HTTP route wiring → controller (no logic here)
├── controllers/    parse request · call service · shape response
├── services/       business logic lives here
├── repositories/   the only layer that talks to Prisma / Redis
├── models/         domain types (DB schema comes from prisma/schema.prisma)
├── generated/      Prisma client output — gitignored, created by `prisma generate`
├── middlewares/    error handler, auth guard
├── events/
│   ├── producers/  Kafka publish
│   └── consumers/  Kafka subscribe
├── utils/          logger, small helpers
├── app.ts          builds Fastify instance — no listen() call, fully testable
└── server.ts       calls app.ts, listens, wires graceful shutdown
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start with hot reload (tsx watch) |
| `pnpm build` | Compile TypeScript → dist/ (build libs first: `pnpm turbo run build --filter=@ride-app/auth-service...`) |
| `pnpm start` | Run compiled output (production) |
| `pnpm test` | Run all tests |
| `pnpm vitest` | Tests in watch mode |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Type-check only, no emit (against lib source, no build needed) |
| `pnpm prisma studio` | Open Prisma DB browser |
| `pnpm prisma generate` | Regenerate the client (also runs on install, build and typecheck) |

---

## Planned: Better Auth

This service is planned to move to **Better Auth** ([docs/design/Auth.md](../../docs/design/Auth.md)): phone OTP and staff 2FA login, sessions, organisations, and JWTs signed with rotating ES256 keys published at `/api/auth/jwks`. It replaces the hand-written `register`/`login` routes (both currently broken) and the RSA key files. Until then, the sections below describe the current code.

---

## Prisma 7 notes

- `prisma.config.ts` holds the schema path, the migrations path and the connection URL (`DATABASE_URL` from `.env`). `schema.prisma` no longer has a `url`.
- The `prisma-client` generator writes the client to `src/generated/prisma`. Import it from `../generated/prisma/client.js`, not `@prisma/client`.
- Queries go through the `@prisma/adapter-pg` driver adapter (see `src/repositories/user.repository.ts`).

---

## Running tests

```bash
pnpm test            # all tests once (passes when no test files exist yet)
pnpm vitest          # watch mode during development
```

- **Unit tests** (`tests/unit/`): mock the repository and Kafka boundaries,
  assert on pure business logic only.
- **Integration tests** (`tests/integration/`): spin up a real DB via
  Testcontainers so migrations and queries run against an actual Postgres.

---

## Docker image

Build from the **repo root** so the workspace libs are in the build context:

```bash
docker build -f services/auth-service/Dockerfile -t ride-app/auth-service .
```

The image is `node:24-alpine`. The build stage uses pnpm (`pnpm deploy --prod`) and the runtime stage ships only `dist/` and production `node_modules`.

---

## Environment variables

See `.env.example` — every variable is documented there.
Never commit a `.env` file with real secrets.
