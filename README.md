# ride-app

Production-structured ride-hailing platform.

```
Four teams. Four entry points. Zero friction.
```

## Toolchain

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24 LTS | `nvm use` reads `.nvmrc` |
| pnpm | 11 (pinned in `package.json` → `packageManager`) | `corepack enable` installs the right one |
| TypeScript | 7 (`tsc`) | TS 6 API kept alongside only for typescript-eslint |
| Flutter / Dart | 3.44 / 3.12 | Dart pub workspace + Melos 8 |
| Docker | Compose v2 | Postgres 18 + PostGIS 3.6, Redis 8, Redpanda 26, Kong 3.9 |
| Terraform | ≥ 1.8 | AWS provider 6.x |

---

## Guides

| Guide | For |
|-------|-----|
| [Architecture](docs/architecture/overview.md) | System diagrams, services, flows, data, events, security, deployment, known gaps |
| [Development](docs/development/README.md) | Setup, JWT keys, ports, daily loop per team, troubleshooting |
| [Testing](docs/testing/README.md) | CI gates, running and writing unit / widget / integration tests |
| [Production](docs/production/README.md) | Images, Terraform, Kubernetes, config, migrations, releases, readiness checklist |

---

## I'm on the mobile team

```bash
make setup-mobile   # dart pub get for the whole Flutter workspace

# Daily work
make dev-mobile     # flutter run the phone app
make lint           # includes melos analyze
make test           # includes melos test
```

There is **one phone app** — `apps/rider-app` — for both riders and drivers.
The signed-in user's role (`RIDER` / `DRIVER` in the JWT) decides which home
screen, features and theme they get.

Open **`.vscode/mobile.code-workspace`** in VS Code.
Full guide → [`apps/rider-app/README.md`](apps/rider-app/README.md)

---

## I'm on the backend (services) team

```bash
make setup-services   # pnpm install + starts local infra + migrates DB

# Daily work
make dev-services            # all eight services with hot reload
make dev-svc SVC=auth-service # just one service
make logs-svc SVC=trip-service

# Quality gates (same as CI)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Open **`.vscode/services.code-workspace`** in VS Code.
Full guide → [`services/auth-service/README.md`](services/auth-service/README.md) (the reference template)

**Want to work on just one service without the full stack?**
```bash
cd services/auth-service
docker compose -f docker-compose.dev.yml up -d   # starts only what this service needs
pnpm install && cp .env.example .env
pnpm prisma migrate dev
pnpm dev
```
Every service has its own `docker-compose.dev.yml` and `README.md`.

Shared libs (`libs/*`) are built to `dist/` for production. In dev, `tsx watch
--conditions=development` loads their TypeScript source directly, so lib edits
hot-reload without a rebuild.

Docker images build from the **repo root** so workspace libs are in context:
```bash
docker build -f services/auth-service/Dockerfile -t ride-app/auth-service .
```

---

## I'm on the admin dashboard team

```bash
make setup-admin   # installs Node deps

# Daily work
make dev-admin     # → http://localhost:5173
```

Open **`.vscode/admin.code-workspace`** in VS Code.
Full guide → [`apps/admin-dashboard/README.md`](apps/admin-dashboard/README.md)

---

## I'm on the infra / DevOps team

```bash
make setup-infra   # initialises Terraform, checks kubectl

# Local stack
make infra-up      # postgres + redis + redpanda (services run on the host)
make stack-up      # everything in containers incl. kong on :8000
make infra-down
make infra-reset   # wipe volumes + restart

# Kubernetes
kubectl apply -k infra/k8s/overlays/staging
kubectl apply -k infra/k8s/overlays/production  # needs manual approval in CI
```

Open **`.vscode/infra.code-workspace`** in VS Code.
Full guide → [`infra/README.md`](infra/README.md)

---

## Full repo layout

```
ride-app/
├── apps/
│   ├── rider-app/            Flutter phone app — rider AND driver modes (role-based)
│   └── admin-dashboard/      React/Vite — ops tooling
│
├── packages/
│   └── core/                 Shared Dart models + widgets
│
├── services/                 Node.js + TypeScript microservices
│   ├── realtime-gateway/     WebSocket: live driver location + trip status
│   ├── auth-service/         Identity, JWT  ← fully built, use as template
│   ├── trip-service/         Ride lifecycle state machine + matching
│   ├── location-service/     Geo queries backed by Redis
│   ├── pricing-service/      Fare estimates + surge
│   ├── payment-service/      Stripe Connect charges + driver payouts
│   ├── notification-service/ Push (FCM) + SMS (Twilio), Kafka-driven
│   └── mapping-service/      Wraps OSRM / Nominatim / tiles (free OSM stack)
│
├── libs/                     Shared TypeScript packages
│   ├── shared-types/         Kafka event shapes, domain types
│   ├── shared-utils/         Logger factory, AppError class
│   └── shared-config/        Zod env validator helper
│
├── infra/
│   ├── docker/               Full local docker-compose stack
│   ├── kong/                 Declarative REST gateway config
│   ├── mapping-stack/        Self-hosted free mapping: tiles + Nominatim + OSRM
│   ├── k8s/                  Kustomize base + staging/production overlays
│   └── terraform/            EKS, RDS Postgres, ElastiCache, MSK (Kafka)
│
├── .vscode/                  Per-team VS Code workspace files
│   ├── mobile.code-workspace
│   ├── services.code-workspace
│   ├── admin.code-workspace
│   └── infra.code-workspace
│
├── .github/workflows/        CI (lint/test/build) · CD (build→push→deploy)
├── docs/                     Architecture notes, API conventions
├── scripts/                  setup.sh, seed-db.ts
│
├── package.json              pnpm workspace root (Node 24, Turborepo)
├── pubspec.yaml              Dart pub workspace root + Melos scripts
├── eslint.config.mjs         Flat ESLint config for every TS package
├── Makefile                  ← team entry points (make help)
├── CONTRIBUTING.md           ← start here if you're new to the repo
└── README.md                 ← you are here
```

---

## Technology choices at a glance

| Layer | Technology | Why |
|-------|-----------|-----|
| Mobile | Flutter + Riverpod 3 | One app, one codebase for iOS + Android, rider + driver |
| Map rendering | flutter_map + OpenStreetMap | Free, no API key, no usage bill |
| Backend | Node.js + TypeScript + Fastify | Fast, type-safe, familiar |
| REST gateway | Kong (DB-less) | Routing, JWT, rate limits as config |
| WebSocket | Socket.io + Redis adapter | Scales horizontally across gateway pods |
| Database | Postgres + PostGIS | Relational data + geospatial queries |
| Cache / geo index | Redis | Sub-ms nearby-driver lookups |
| Event bus | Kafka / Redpanda | Durable, ordered event stream between services |
| Routing / ETA | OSRM (self-hosted) | Free, production-grade, OSM-based |
| Geocoding | Nominatim (self-hosted) | Free, OSM-based |
| Payments | Stripe Connect | Handles the rider charge + driver payout split |
| Container runtime | Docker + Kubernetes | Horizontal scaling, rolling deploys |
| IaC | Terraform | Reproducible cloud infra |
| ORM | Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) | Typed queries, migrations |
| Monorepo | pnpm workspaces + Turborepo (Node) · Dart pub workspace + Melos (Flutter) | Separate toolchains, shared contracts |
