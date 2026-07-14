# location-service

## Quick start — standalone, no other services needed

```bash
# 1. Start only the infra this service requires
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies (once)
pnpm install

# 3. Copy the env file
cp .env.example .env

# Start with hot reload
pnpm dev
```

Service URL  : http://localhost:3003
Health check : http://localhost:3003/health

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
| `pnpm build` | Compile TypeScript → dist/ |
| `pnpm start` | Run compiled output (production) |
| `pnpm test` | Run all tests |
| `pnpm test -- --watch` | Tests in watch mode |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Type-check only, no emit |

---

## Running tests

```bash
pnpm test            # all tests once
pnpm test -- --watch # watch mode during development
```

- **Unit tests** (`tests/unit/`): mock the repository and Kafka boundaries,
  assert on pure business logic only.
- **Integration tests** (`tests/integration/`): spin up a real DB via
  Testcontainers so migrations and queries run against an actual Postgres.

---

## Environment variables

See `.env.example` — every variable is documented there.
Never commit a `.env` file with real secrets.
