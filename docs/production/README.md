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
| `<svc>-config` (ConfigMap) | non-secret env: `PORT`, `NODE_ENV=production`, `LOG_LEVEL`, `KAFKA_BROKERS`, `REDIS_URL`, mapping URLs, `AUTH_ISSUER`, `AUTH_JWKS_URL` | Kustomize `configMapGenerator` per overlay |
| `<svc>-secrets` (Secret) | `DATABASE_URL`, `STRIPE_*`, `FCM_SERVER_KEY`, `TWILIO_*`. auth-service also: `BETTER_AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN` | Cloud secrets manager → External Secrets / CSI driver |

**Auth secrets.** With Better Auth ([Auth.md](../design/Auth.md)), JWT signing keys live **encrypted in the identity database** (`jwks` table) and rotate automatically, so there are no key files to mount. The signing secret is `BETTER_AUTH_SECRET` (32+ random bytes, different per environment), and only auth-service gets it. `INTERNAL_SERVICE_TOKEN` (32+ random bytes) authenticates service-to-service calls to `/internal/*` until mTLS replaces it; auth-service and the services that call it (notification-service, onboarding) share it. Every other service only needs `AUTH_ISSUER` and `AUTH_JWKS_URL` to verify tokens.

**First super admins.** After the first deploy, run the bootstrap once from a trusted machine with the production `DATABASE_URL`: `pnpm --filter @ride-app/auth-service bootstrap:super-admin -- --email … --name …`, twice, for two different people. It refuses once two super admins exist. Hand over each temporary password in person or through the password manager, never by chat.

---

## 5. Configuration reference

The full variable list, with dev defaults, is in the root `.env.example` and each `services/*/.env.example`.
Production values that differ from dev:

| Variable | Production value |
|----------|------------------|
| `NODE_ENV` | `production` |
| `BETTER_AUTH_SECRET` | auth-service only. From Secrets Manager, unique per environment. Never rotate it without a key-migration plan |
| `AUTH_BASE_URL` | auth-service: public URL, must be `https://` (e.g. `https://api.anbessa.et`). Also the default JWT issuer |
| `AUTH_ISSUER` / `AUTH_JWKS_URL` | verifiers: the issuer above / in-cluster JWKS URL (`http://auth-service:3001/api/auth/jwks`) |
| `APP_TRUSTED_ORIGINS` / `ADMIN_TRUSTED_ORIGINS` | auth-service: the exact web origins (comma separated). The web app's origin (e.g. `https://web.anbessa.et`) goes in **both**: its fleet and corporate portals use the app surface, its staff dashboard the admin surface. Nothing else goes in `ADMIN_TRUSTED_ORIGINS` |
| `OTP_DELIVERY` / `NOTIFICATION_INTERNAL_URL` | auth-service: `notification` / in-cluster notification-service URL. `console` is refused in production |
| `INTERNAL_SERVICE_TOKEN` | auth-service and its internal callers. Required in production |
| `AUTH_RATE_LIMIT` | leave unset (`on`). `off` is refused in production |
| `PLATFORM_INTERNAL_URL` | trip, fleet and notification services: in-cluster platform-service URL. Live settings come from there. If it's unreachable at start, a service runs on its env values (the env values are only defaults) |
| `AUTH_INTERNAL_URL` (+ `INTERNAL_SERVICE_TOKEN` for realtime-gateway) | every service: the live permission matrix (`/internal/authz/snapshot`). Unreachable at start = the built-in matrix, logged |
| `SERVICE_URLS` / `CONSUMER_GROUPS` | platform-service: in-cluster base URL of every service (`name=url,…`) and the Kafka groups whose lag the system page shows |
| `DEV_LOGIN` | leave unset (`off`). `on` is refused in production. Never run `seed:dev` against a real database: it refuses unless `NODE_ENV=development` |
| `PHONE_HASH_KEY` / `OTP_ENCRYPTION_KEY` | notification-service only, 32 random bytes as hex each, from Secrets Manager. Rotating `PHONE_HASH_KEY` only breaks the resend lookup for codes in flight; rotating `OTP_ENCRYPTION_KEY` drops codes in flight (users request a new one) |
| `OTP_CHANNELS` / `OTP_FALLBACK_SECONDS` | notification-service: `telegram,sms` / `20` |
| `STORAGE` / `S3_BUCKET` / `S3_REGION` | fleet-service: `s3` (`local` is refused in production) and the private documents bucket. Give the service role `s3:PutObject`/`GetObject` on it only; block public access; CORS on the bucket must allow `PUT` from the web origin (browsers upload straight to S3) |
| `PII_ENCRYPTION_KEY` / `PII_BLIND_INDEX_KEY` / `UPLOAD_SIGNING_KEY` | fleet-service, 32 random bytes as hex each, all different, from Secrets Manager. Losing `PII_ENCRYPTION_KEY` makes stored licence numbers unreadable; changing `PII_BLIND_INDEX_KEY` breaks duplicate-licence detection |
| `TELEGRAM_CALLBACK_URL` | notification-service: `https://api.anbessa.et/api/webhooks/telegram-gateway` (required, https) |
| `SMS_PROVIDER` + `TWILIO_*` | notification-service: `twilio` (console is refused in production) |
| `PUSH_PROVIDER` + `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | notification-service: `fcm`, a Firebase service account with the *Firebase Cloud Messaging API* role only (console is refused) |
| `OSRM_URL` / `NOMINATIM_URL` | mapping-service only: the in-cluster engine URLs. Nothing else may reach the engines (network policy) |
| `MAPPING_INTERNAL_URL` | location-service and trip-service: in-cluster mapping-service URL |
| `LOCATION_INTERNAL_URL` | trip-service: in-cluster location-service URL |
| `PRICING` / `PRICING_INTERNAL_URL` | trip-service: `service` / in-cluster pricing-service URL. `builtin` (the dev quote stand-in) is refused in production |
| `REDIS_URL` (trip-service) | must be the **same** Redis as realtime-gateway: trip-service pushes offers and status through Socket.io's Redis emitter |
| `TELEGRAM_GATEWAY_TOKEN` | notification-service only. Telegram Gateway API token for login codes. Its SHA256 also verifies delivery-report signatures. The Gateway account is **prepaid**: finance tops it up, and an alert fires when the balance drops below 7 days of spend |
| `DATABASE_URL` | RDS endpoint, one database per service (`auth_service`, `trip_service`, …), TLS on |
| `REDIS_URL` | ElastiCache endpoint (`rediss://` for TLS) |
| `KAFKA_BROKERS` | MSK bootstrap brokers, comma-separated |
| `STRIPE_SECRET_KEY` | live key `sk_live_…`, never the test key |

Config is validated with Zod at process start, so a missing or invalid variable crash-loops the pod immediately. auth-service also refuses to start in production without `REDIS_URL` (shared sessions cache, rate limits and the suspension denylist), `KAFKA_BROKERS` (outbox relay) and `INTERNAL_SERVICE_TOKEN`. Token lifetimes are fixed in code (app 15 min / 30-day session, admin 10 min / 12 h), not env vars.

---

## 6. Database migrations

- Production applies **committed** migrations only: `prisma migrate deploy`. Never `migrate dev`, which can reset data.
- Run it **before** rolling out the new image, as a Kubernetes Job or a deploy-workflow step, with the production `DATABASE_URL`.
- Make migrations backwards-compatible with the version still running (expand → deploy → contract), because pods roll gradually.
- The runtime image doesn't contain the Prisma CLI or `prisma.config.ts` (`prisma` is a devDependency). Run `migrate deploy` from the repo checkout in CI, or build a separate migration image from the `build` stage.

---

## 7. Edge: Kong and realtime-gateway

- Kong runs DB-less from `infra/kong/kong.yml`. It does routing (`/api/auth`, `/api/admin-auth` and `/api/identity` with `strip_path: false`), rate limits and request-size limits. JWTs are verified by the services against Better Auth's JWKS, not by Kong ([Auth.md AU5](../design/Auth.md#3-decisions)). `/internal/*` must never get a Kong route.
- **Telegram Gateway delivery reports** arrive at `POST /api/webhooks/telegram-gateway` (a Kong route without auth plugins: notification-service verifies the `X-Request-Signature` HMAC and the timestamp). It must be reachable over public HTTPS ([Auth.md §9.7](../design/Auth.md#97-otp-delivery-telegram-gateway-first-sms-fallback)).
- realtime-gateway (Socket.io) verifies the JWT once at handshake and uses the Redis adapter, so it scales horizontally. The load balancer needs WebSocket support. Sticky sessions are only needed if long-polling is enabled (the mobile app uses websocket-only transport).

---

## 8. Client releases

### Mobile (`apps/phone-app`, rider + driver in one app)

```bash
cd apps/phone-app
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://api.example.com \
  --dart-define=WS_URL=wss://ws.example.com
flutter build ipa --release --dart-define=...   # macOS only
```

- Android application ID / iOS bundle: `com.anbessa.phone_app`. Display name: "Ride".
- Bump `version:` in `pubspec.yaml` (`1.0.0+1` → name + build number) for every store upload.
- Android release builds are still signed with the **debug key** (`android/app/build.gradle.kts`). Create an upload keystore and a `key.properties` (keep both out of git) before the first store release.
- Store listings must explain the location permission (driver mode). The iOS usage string is in `ios/Runner/Info.plist`.

### Web app (staff dashboard, fleet and corporate portals)

Serve the app and the API on **one origin**: the web app calls relative `/api/*` URLs, and the auth cookies (`anb.*`, `anb-admin.*`, `SameSite`) are first-party. For example, the CDN serves `dist/` and routes `/api/*` to Kong. Put that origin in auth-service's `APP_TRUSTED_ORIGINS` and `ADMIN_TRUSTED_ORIGINS`.


```bash
pnpm --filter @ride-app/web build     # → apps/web/dist
```

API URLs are relative. The one build-time value is `VITE_MAP_STYLE_URL`, the MapLibre style for the maps: point it at the self-hosted TileServer GL (`infra/mapping-stack`, e.g. `https://tiles.anbessa.et/styles/<id>/style.json`) or a licensed tile provider. Don't use the public OpenFreeMap default for production traffic. If the tile host is the same in every environment, one build serves them all.

Serve `dist/` with a fallback to `index.html` for client-side routes, and a strict `Content-Security-Policy`:

- `default-src 'self'`
- `style-src` and `font-src`: Google Fonts
- `connect-src` and `img-src`: the tile host (style, tiles, sprites, glyphs)
- `connect-src`, `img-src` and `frame-src`: the documents bucket (`https://<bucket>.s3.<region>.amazonaws.com`): uploads go straight to it, and reviewers view files (images, PDFs) from it
- `worker-src 'self' blob:` (MapLibre's worker)

Keep the OpenStreetMap attribution in the map corner visible; it is a licence condition.

---

## 9. Production readiness checklist

These are known gaps in the current scaffold. Each one blocks or weakens a real production deploy.

- [ ] **Image tags:** CI pushes `:<git sha>`, but `base/deployment.yaml` references `:latest`, so deploys never pick up new images. Add `kustomize edit set image ...=<registry>/<svc>:${{ github.sha }}` (or an `images:` block) to the deploy jobs.
- [ ] **Cluster access:** the deploy jobs run `kubectl` with no credentials step. Add AWS OIDC (`aws-actions/configure-aws-credentials`) and `aws eks update-kubeconfig`.
- [ ] **Manifests for all 8 services:** only trip-service exists in `infra/k8s/base`.
- [ ] **ConfigMaps / Secrets** per service (section 4).
- [ ] **Migration step** before rollout (section 6).
- [ ] **Terraform modules** in `infra/terraform/modules/` (section 3), and the RDS 16-vs-18 decision.
- [x] **Authentication on Better Auth** ([Auth.md §17](../design/Auth.md#17-implementation-notes-v1)): phone OTP, staff password + TOTP, JWKS, Kong `jwt` plugin removed, error handler fixed.
- [x] **notification-service OTP delivery** (Telegram Gateway + SMS fallback, signed delivery reports).
- [ ] **Provider accounts:** a funded Telegram Gateway account and verified sender channel, an SMS provider for Ethiopian numbers ([Auth.md Q3](../design/Auth.md#16-open-questions); Twilio is wired), and a Firebase project for push. Alert on the `telegram gateway balance is low` log line.
- [ ] **Bootstrap two super admins** after the first deploy (section 4).
- [ ] **Verify tokens in every service** with `libs/shared-authz` as each one gets real routes (only realtime-gateway does today).
- [ ] **`.github/` is gitignored** (section 1).
- [ ] **Android release signing** (section 8).
- [ ] **Observability:** no metrics, tracing or alerting yet. Logs are JSON on stdout; ship them with the cluster's log agent.
- [ ] **Seed script** (`scripts/seed-db.ts`) is a TODO. Never run it against production anyway.

---

## 10. Rollback

- **Services:** `kubectl rollout undo deployment/prod-<svc>`, or redeploy the previous git SHA. Images are immutable, so rollback is a redeploy.
- **Database:** Prisma has no down-migrations. Roll forward with a new migration. This is why migrations must stay backwards-compatible (section 6).
- **Mobile:** you can't recall store builds. Gate risky features server-side and keep the API backwards-compatible for at least one previous app version.

### Administration in production

- **Who controls what:**
  - The permission matrix and live settings are changed from the admin dashboard, always by two super admins for sensitive changes.
  - Keep at least two active super admins (auth-service refuses to go below two).
  - Review the access-review flags on Staff and roles regularly.
- **Live reload needs Redis:** auth-service and platform-service publish `authz:changed` / `settings:changed`. Without Redis, services still converge within 30 s by polling.
- **The audit log is write-once:**
  - Grant the audit-service database role INSERT/SELECT only.
  - Export monthly `audit_entry_YYYY_MM` partitions to S3 Object Lock and detach them after the hot retention (Database.md).
- **Kong:**
  - `/api/platform/client-config` is public and cacheable (15 s).
  - `/api/audit` is GET only.
  - `/internal/*` is never routed.
