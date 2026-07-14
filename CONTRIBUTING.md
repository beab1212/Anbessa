# Contributing — team guide

## Who works on what

| Team | Folder(s) | Their workspace file |
|------|-----------|---------------------|
| **Mobile** | `apps/rider-app`, `apps/driver-app`, `packages/core` | `.vscode/mobile.code-workspace` |
| **Backend** | `services/*`, `libs/*` | `.vscode/services.code-workspace` |
| **Admin dashboard** | `apps/admin-dashboard` | `.vscode/admin.code-workspace` |
| **Infra / DevOps** | `infra/`, `.github/workflows/` | `.vscode/infra.code-workspace` |

Open your workspace file instead of the repo root: it limits the file tree, search scope, and installed extensions to just your context.

---

## First-time setup (choose your path)

### Mobile team
```bash
make setup-mobile
# Then: make dev-mobile
```
Requires Flutter ≥3.24. Install at https://docs.flutter.dev/get-started/install.

### Backend (services) team
```bash
make setup-services
# Then: make dev-services          (all services)
# Or:   make dev-svc SVC=auth-service  (one service)
```
Requires Node ≥20 + Docker Desktop.

### Admin dashboard team
```bash
make setup-admin
# Then: make dev-admin
```
Requires Node ≥20.

### Infra / DevOps team
```bash
make setup-infra
```
Requires Terraform ≥1.8, kubectl, Docker.

---

## Working on a single service without the full stack

Every service is independently runnable:

```bash
cd services/auth-service

# Start only what this service needs (postgres, redis, redpanda)
docker compose -f docker-compose.dev.yml up -d

# Install deps and run
pnpm install
cp .env.example .env
pnpm prisma migrate dev --name init
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
