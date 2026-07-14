# ride-app

Production-structured ride-hailing platform.

```
Four teams. Four entry points. Zero friction.
```

---

## I'm on the mobile team

```bash
make setup-mobile   # installs Flutter deps for rider-app + driver-app

# Daily work
make dev-mobile     # prompts: rider-app or driver-app?
```

Open **`.vscode/mobile.code-workspace`** in VS Code.
Full guide → [`apps/rider-app/README.md`](apps/rider-app/README.md) · [`apps/driver-app/README.md`](apps/driver-app/README.md)

---

## I'm on the backend (services) team

```bash
make setup-services   # installs Node deps + starts local infra + migrates DB

# Daily work
make dev-services            # all eight services with hot reload
make dev-svc SVC=auth-service # just one service
make logs-svc SVC=trip-service
```

Open **`.vscode/services.code-workspace`** in VS Code.
Full guide → [`services/auth-service/README.md`](services/auth-service/README.md) (the reference template)

**Want to work on just one service without the full stack?**
```bash
cd services/auth-service
docker compose -f docker-compose.dev.yml up -d   # starts only what this service needs
pnpm install && cp .env.example .env
pnpm prisma migrate dev --name init
pnpm dev
```
Every service has its own `docker-compose.dev.yml` and `README.md`.

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
make infra-up      # postgres + redis + redpanda + kong
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
│   ├── rider-app/            Flutter — riders book + track trips
│   ├── driver-app/           Flutter — drivers go online, accept, navigate
│   └── admin-dashboard/      React/Vite — ops tooling
│
├── packages/
│   └── core/                 Shared Dart models + widgets (rider + driver apps)
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
├── Makefile                  ← team entry points (make help)
├── CONTRIBUTING.md           ← start here if you're new to the repo
└── README.md                 ← you are here
```

---

## Technology choices at a glance

| Layer | Technology | Why |
|-------|-----------|-----|
| Mobile | Flutter + Riverpod | Single codebase for iOS + Android |
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
| Monorepo | pnpm workspaces + Turborepo (Node) · Melos (Flutter) | Separate toolchains, shared contracts |
# Anbessa
