# Contributing — team guide

Detailed guides: [architecture](docs/architecture/overview.md) · [design docs](docs/design/README.md) ([roles & permissions](docs/design/Role.md)) · [development](docs/development/README.md) ·
[testing](docs/testing/README.md) · [production](docs/production/README.md).

## Who works on what

| Team | Folder(s) | Their workspace file |
|------|-----------|---------------------|
| **Mobile** | `apps/phone-app` (rider + driver modes), `packages/core` | `.vscode/mobile.code-workspace` |
| **Backend** | `services/*`, `libs/*` | `.vscode/services.code-workspace` |
| **Web** (staff dashboard, fleet and corporate portals) | `apps/web` | `.vscode/web.code-workspace` |
| **Infra / DevOps** | `infra/`, `.github/workflows/` | `.vscode/infra.code-workspace` |

Open your workspace file instead of the repo root: it limits the file tree, search scope, and installed extensions to just your context.

---

## First-time setup (choose your path)

### Mobile team
```bash
make setup-mobile
# Then: make dev-mobile
```
Requires Flutter ≥3.44 (Dart ≥3.12). Install at https://docs.flutter.dev/get-started/install.
The repo root `pubspec.yaml` is a Dart pub workspace: one `dart pub get` resolves
the app and `packages/core` together, and Melos 8 runs from it via `dart run melos`.
For Android builds, accept the SDK licenses once: `flutter doctor --android-licenses`.

### Backend (services) team
```bash
make setup-services
# Then: make dev-services          (all services)
# Or:   make dev-svc SVC=auth-service  (one service)
```
Requires Node ≥24 (`nvm use` reads `.nvmrc`) + Docker. pnpm comes from `corepack enable`.

### Web team
```bash
make setup-web
# Then: make dev-web
```
Requires Node ≥24.

### Infra / DevOps team
```bash
make setup-infra
```
Requires Terraform ≥1.8, kubectl, Docker.

---

## Quality gates

CI runs exactly these; run them before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # Node workspace (Turborepo)
dart run melos run analyze && dart run melos run test   # Flutter workspace
```

`pnpm format` applies Prettier (`.prettierrc.json`); it isn't enforced in CI.

---

## Working on a single service without the full stack

Every service is independently runnable:

```bash
cd services/auth-service

# Start only what this service needs (postgres, redis, redpanda)
docker compose -f docker-compose.dev.yml up -d

# Install deps and run
pnpm install          # auth-service also runs `prisma generate` here
cp .env.example .env
pnpm prisma migrate dev   # applies prisma/migrations; only services with a schema (auth-service today)
pnpm dev
```

See each `services/*/README.md` for service-specific notes.

---

## Branch & PR conventions

- Branch off `main`. Name: `<team>/<short-description>` e.g. `backend/trip-state-machine`
- One PR per logical change. Keep diffs reviewable.
- CI must pass (lint, typecheck, tests) before merge.
- Production deploys require a manual approval gate in GitHub Actions.

---

## Shared contracts

When you change a Kafka event shape or an HTTP response body that another
team consumes, update `libs/shared-types/src/` in the same PR and notify
the consuming team in the PR description. The shared-types package is the
contract boundary; diverging without updating it is the fastest way to
cause a production incident.

---

## Secrets

- Never commit `.env` files or `secrets/` to git.
- Copy `.env.example` → `.env` and fill in values locally.
- Staging/production secrets live in Kubernetes Secrets (populated from
  the cloud secrets manager by the infra team).
