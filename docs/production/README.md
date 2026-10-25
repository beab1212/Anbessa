# Production guide

How code gets from `main` to users: images, infrastructure, configuration,
migrations, releases and rollback. **Read section 9 first.** The pipeline is
scaffolded but not yet production-ready, and that section lists exactly what's missing.

---

## 1. Pipeline overview

```
PR ──► CI (.github/workflows/ci.yml)
        node:    pnpm install --frozen-lockfile → lint → typecheck → test → build
        flutter: dart pub get → melos analyze → melos test

push to main ──► Deploy (.github/workflows/deploy.yml)
        build-and-push   one job per service: docker build (repo-root context) → push
                         registry.example.com/ride-app/<svc>:<git sha>
        deploy-staging   kubectl apply -k infra/k8s/overlays/staging
        deploy-production  needs manual approval (GitHub "production" environment)
                         kubectl apply -k infra/k8s/overlays/production
```

Both workflows need these GitHub secrets: `REGISTRY_USER`, `REGISTRY_TOKEN`
(plus cluster credentials, see section 9). Replace `registry.example.com` with
the real registry.

> `.gitignore` currently ignores `.github/`. Remove that line, or the workflows never reach GitHub.

---

## 2. Service images

Every service has a three-stage `Dockerfile`, built from the **repo root**:

```bash
docker build -f services/auth-service/Dockerfile -t registry.example.com/ride-app/auth-service:<sha> .
```

| Stage | What happens |
|-------|--------------|
| `base` | `node:24-alpine`, `corepack enable` (pnpm version from `packageManager`) |
| `build` | `pnpm fetch` (cached by lockfile) → `pnpm install --offline --filter <svc>...` → build libs + service → `pnpm deploy --prod /out` |
| `runtime` | `node:24-alpine`, `NODE_ENV=production`, non-root `app` user, only `dist/` + production `node_modules` (+ `prisma/` for auth-service) |

- Entrypoint: `node dist/server.js`.
- Docker `HEALTHCHECK` and the Kubernetes probes both hit `GET /health`.
- Images are immutable per git SHA. Never deploy `:latest`.
- `NODE_ENV=production` switches the shared logger to JSON at `info` level (no `pino-pretty`).

---

## 3. Infrastructure (Terraform, AWS)

`infra/terraform/` describes EKS, RDS Postgres (+ PostGIS), ElastiCache Redis
and MSK (Kafka). State lives in S3 with DynamoDB locking.

```bash
cd infra/terraform
terraform init
terraform plan  -var="environment=production"
terraform apply -var="environment=production"
```

- Terraform ≥ 1.8, AWS provider `~> 6.0`.
- `modules/` (`eks`, `rds`, `elasticache`, `msk`) doesn't exist yet. `terraform init` fails until those modules are written.
- RDS is pinned to Postgres **16**; local dev runs 18. Decide before launch: upgrade RDS to 18 (preferred, matches dev) or pin dev back to 16.
- Enable PostGIS on RDS: `CREATE EXTENSION postgis;` in each service database.

---

## 4. Kubernetes

Kustomize, `infra/k8s/`:

- `base/`: Deployment + Service + HPA (2–10 replicas at 70% CPU). Shown for **trip-service only**.
- `overlays/staging`: `staging-` name prefix, 1 replica.
- `overlays/production`: `prod-` name prefix, 4 replicas, 1 CPU limit.

Each Deployment expects two objects that aren't in the repo, by design:

| Name | Contents | Source |
|------|----------|--------|
| `<svc>-config` (ConfigMap) | non-secret env: `PORT`, `NODE_ENV=production`, `LOG_LEVEL`, `KAFKA_BROKERS`, `REDIS_URL`, mapping URLs, `JWT_*_TTL` | Kustomize `configMapGenerator` per overlay |
| `<svc>-secrets` (Secret) | `DATABASE_URL`, `STRIPE_*`, `FCM_SERVER_KEY`, `TWILIO_*` | Cloud secrets manager → External Secrets / CSI driver |

JWT keys are read from **files** (`JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH`).
Mount them from a Secret as a volume. Only auth-service gets the private key;
realtime-gateway and anything else that verifies tokens gets only the public key.

---

## 5. Configuration reference

The full variable list, with dev defaults, is in the root `.env.example` and each `services/*/.env.example`.
Production values that differ from dev:

| Variable | Production value |
|----------|------------------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | RDS endpoint, one database per service (`auth_service`, `trip_service`, …), TLS on |
| `REDIS_URL` | ElastiCache endpoint (`rediss://` for TLS) |
| `KAFKA_BROKERS` | MSK bootstrap brokers, comma-separated |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `30d` unless security review says otherwise |
| `STRIPE_SECRET_KEY` | live key `sk_live_…`, never the test key |

Config is validated with Zod at process start, so a missing or invalid variable crash-loops the pod immediately.

---

## 6. Database migrations

- Production applies **committed** migrations only: `prisma migrate deploy`. Never `migrate dev`, which can reset data.
- Run it **before** rolling out the new image, as a Kubernetes Job or a deploy-workflow step, with the production `DATABASE_URL`.
- Make migrations backwards-compatible with the version still running (expand → deploy → contract), because pods roll gradually.
- The runtime image doesn't contain the Prisma CLI or `prisma.config.ts` (`prisma` is a devDependency). Run `migrate deploy` from the repo checkout in CI, or build a separate migration image from the `build` stage.

---

## 7. Edge: Kong and realtime-gateway

- Kong runs DB-less from `infra/kong/kong.yml`: `/api/auth` (rate-limited), and `/api/trips`, `/api/pricing`, `/api/payments` behind the `jwt` plugin.
- realtime-gateway (Socket.io) verifies the JWT once at handshake and uses the Redis adapter, so it scales horizontally. The load balancer needs WebSocket support. Sticky sessions are only needed if long-polling is enabled (the mobile app uses websocket-only transport).

---

## 8. Client releases

### Mobile (`apps/rider-app`, rider + driver in one app)

```bash
cd apps/rider-app
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://api.example.com \
  --dart-define=WS_URL=wss://ws.example.com
flutter build ipa --release --dart-define=...   # macOS only
```

- Android application ID / iOS bundle: `com.anbessa.ride_app_rider`. Display name: "Ride".
- Bump `version:` in `pubspec.yaml` (`1.0.0+1` → name + build number) for every store upload.
- Android release builds are still signed with the **debug key** (`android/app/build.gradle.kts`). Create an upload keystore and a `key.properties` (keep both out of git) before the first store release.
- Store listings must explain the location permission (driver mode). The iOS usage string is in `ios/Runner/Info.plist`.

### Admin dashboard

```bash
VITE_API_BASE_URL=https://api.example.com VITE_WS_URL=wss://ws.example.com \
  pnpm --filter @ride-app/admin-dashboard build     # → apps/admin-dashboard/dist
```

`VITE_*` values are compiled into the bundle, so build once per environment. Serve `dist/`
from any static host or CDN, with a fallback to `index.html` for client-side routes.

---

## 9. Production readiness checklist

These are known gaps in the current scaffold. Each one blocks or weakens a real production deploy.

- [ ] **Image tags:** CI pushes `:<git sha>`, but `base/deployment.yaml` references `:latest`, so deploys never pick up new images. Add `kustomize edit set image ...=<registry>/<svc>:${{ github.sha }}` (or an `images:` block) to the deploy jobs.
- [ ] **Cluster access:** the deploy jobs run `kubectl` with no credentials step. Add AWS OIDC (`aws-actions/configure-aws-credentials`) and `aws eks update-kubeconfig`.
- [ ] **Manifests for all 8 services:** only trip-service exists in `infra/k8s/base`.
- [ ] **ConfigMaps / Secrets** per service (section 4).
- [ ] **Migration step** before rollout (section 6).
- [ ] **Terraform modules** in `infra/terraform/modules/` (section 3), and the RDS 16-vs-18 decision.
- [ ] **Kong JWT:** `kong.yml` defines no consumers or RS256 credentials, and tokens from auth-service carry no `iss` claim. Kong's `jwt` plugin will reject every request until both are configured.
- [ ] **auth-service error handler** is registered after the routes, so `AppError`s use Fastify's default error format instead of `{ error, message }`. Register it before `authRoutes` in `src/app.ts`.
- [ ] **`.github/` is gitignored** (section 1).
- [ ] **Android release signing** (section 8).
- [ ] **Observability:** no metrics, tracing or alerting yet. Logs are JSON on stdout; ship them with the cluster's log agent.
- [ ] **Seed script** (`scripts/seed-db.ts`) is a TODO. Never run it against production anyway.

---

## 10. Rollback

- **Services:** `kubectl rollout undo deployment/prod-<svc>`, or redeploy the previous git SHA. Images are immutable, so rollback is a redeploy.
- **Database:** Prisma has no down-migrations. Roll forward with a new migration. This is why migrations must stay backwards-compatible (section 6).
- **Mobile:** you can't recall store builds. Gate risky features server-side and keep the API backwards-compatible for at least one previous app version.
