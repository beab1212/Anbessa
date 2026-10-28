# Kubernetes

Kustomize manifests in `infra/k8s/`. Applied by `.github/workflows/deploy.yml`
(`kubectl apply -k infra/k8s/overlays/staging`, then `.../production`) or by hand with the same
commands. **trip-service** (the template files) and **pricing-service** (`pricing-service.*.yaml`,
copied from it) have manifests today; `infra/k8s/base/README.md` says the base is a template to copy
per service.

```
infra/k8s/
├── base/
│   ├── kustomization.yaml   resources: the six files below
│   ├── deployment.yaml      trip-service Deployment
│   ├── service.yaml         trip-service Service
│   ├── hpa.yaml             trip-service HorizontalPodAutoscaler
│   ├── pricing-service.deployment.yaml   pricing-service Deployment (port 3004)
│   ├── pricing-service.service.yaml      pricing-service Service
│   ├── pricing-service.hpa.yaml          pricing-service HPA (2–6 at 70 % CPU)
│   └── README.md
└── overlays/
    ├── staging/kustomization.yaml
    └── production/kustomization.yaml
```

No Namespace, Ingress, NetworkPolicy, PodDisruptionBudget, ServiceAccount, ConfigMap, Secret, Job
(migrations), Kong or realtime-gateway manifest was found in repo.

## 1. Base manifests

### `deployment.yaml` (trip-service)

| Field | Value |
|-------|-------|
| `metadata.name`, labels, selector | `trip-service`, `app: trip-service` |
| `replicas` | 2 |
| `image` | `registry.example.com/ride-app/trip-service:latest` |
| `containerPort` | 3002 |
| `envFrom` | ConfigMap `trip-service-config`, Secret `trip-service-secrets` |
| `resources.requests` | cpu `100m`, memory `128Mi` |
| `resources.limits` | cpu `500m`, memory `256Mi` |
| `readinessProbe` | `GET /health` on 3002, `initialDelaySeconds: 5`, `periodSeconds: 10` |
| `livenessProbe` | `GET /health` on 3002, `initialDelaySeconds: 15`, `periodSeconds: 20` |

The image tag is `:latest`, while CI pushes `:<git sha>` and nothing in the overlays or the workflow
sets the image (no `images:` block, no `kustomize edit set image`). See [ci-cd.md](ci-cd.md).

### `pricing-service.*.yaml`

Same shape as trip-service's: `pricing-service`, image `registry.example.com/ride-app/pricing-service:latest`,
port 3004, `envFrom` ConfigMap `pricing-service-config` and Secret `pricing-service-secrets` (see §3:
`KAFKA_BROKERS` in the ConfigMap, `DATABASE_URL` in the Secret), same requests / limits and `/health`
probes. HPA 2–6 replicas at 70 % CPU. The overlays don't patch it (2 replicas everywhere, HPA
permitting). Its database (`pricing_service`, workflow 15: zones, fare rules, promos, outbox) must
be migrated (`prisma migrate deploy`) before a rollout, like every Prisma service; no Job does it.

### `service.yaml`

ClusterIP (default type) `trip-service`, port 3002 → targetPort 3002, selector `app: trip-service`.

### `hpa.yaml`

`autoscaling/v2`, target Deployment `trip-service`, `minReplicas: 2`, `maxReplicas: 10`, CPU
utilization target 70 %.

### Pod hardening (`deployment.yaml`, `pricing-service.deployment.yaml`)

- Pod `securityContext`: `runAsNonRoot`, `runAsUser`/`runAsGroup`/`fsGroup` `10001` (the image's
  `app` user has no fixed UID, and `runAsNonRoot` can only verify a numeric one; the image files
  are root-owned and world-readable), `seccompProfile: RuntimeDefault`,
  `automountServiceAccountToken: false`.
- Container `securityContext`: `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `capabilities.drop: [ALL]`, with an `emptyDir` (64 Mi) on `/tmp` for anything that needs scratch
  space. fleet-service with `STORAGE=local` (development only) would need a writable volume.
- Pods carry `tier: backend`, which the NetworkPolicies select on. Copy all of this into every new
  service's manifests.

### `networkpolicy.yaml`

Default deny (ingress and egress) for every pod in the namespace, then: DNS to kube-dns; ingress
from Kong (namespace `kong`, label `app.kubernetes.io/name: kong`) to `tier: backend` on the
service ports 3000–3011; backend ↔ backend on those ports (internal calls); egress to the data
subnets (placeholder `10.0.32.0/20`: replace with the Terraform data-subnet CIDRs) on 5432
(Postgres), 6379 (Redis), 9094/9096 (MSK TLS / SASL-SCRAM; plaintext 9092 is not allowed); and
HTTPS to the internet only for pods labelled `egress: internet` (notification-service for
Twilio/FCM/Telegram, payment-service for the payment providers). The CNI must enforce
NetworkPolicy (VPC CNI with network policy enabled, Calico or Cilium). Validated as YAML only;
nothing was applied.

## 2. Overlays

| Overlay | `namePrefix` | Patches (JSON 6902, target Deployment `trip-service`) |
|---------|--------------|------------------------------------------------------|
| `overlays/staging` | `staging-` | `/spec/replicas` → 1 |
| `overlays/production` | `prod-` | `/spec/replicas` → 4; `/spec/template/spec/containers/0/resources/limits/cpu` → `1000m` |

Effects worth knowing:

- `namePrefix` renames the Deployment, Service and HPA (`staging-trip-service`, `prod-trip-service`)
  and the HPA's `scaleTargetRef`. It does not rename `trip-service-config` / `trip-service-secrets`,
  because those objects are not part of the kustomization, so the pods look for the unprefixed
  names in whatever namespace they are applied to.
- The Service becomes `staging-trip-service` / `prod-trip-service`, while every service's default
  in-cluster URLs (`*_INTERNAL_URL`, Kong upstreams `http://trip-service:3002`) use unprefixed names.
  The ConfigMaps must set the prefixed names, or the prefix has to go.
- Neither overlay sets a namespace, so staging and production land in the current kubeconfig
  context's namespace, presumably separate clusters. Not stated in repo.
- The HPA's `minReplicas: 2` overrides the staging patch (`replicas: 1`): the HPA scales the
  Deployment up to 2. In production the HPA can scale the patched 4 down to 2.
- Memory limit stays 256Mi in both environments.

## 3. Config and secrets each service expects

Each Deployment is expected to load `<svc>-config` (ConfigMap) and `<svc>-secrets` (Secret) through
`envFrom`, following the base template. Neither exists in repo. The variables below come from each
service's `src/config/index.ts` (realtime-gateway: `src/config/index.ts` `config`). Production
refusals are listed in [production-checklist.md](production-checklist.md).

| Service | Port | ConfigMap `<svc>-config` (non-secret) | Secret `<svc>-secrets` |
|---------|------|----------------------------------------|------------------------|
| auth-service | 3001 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `AUTH_BASE_URL` (https), `AUTH_ISSUER`, `AUTH_INTERNAL_URL`, `APP_TRUSTED_ORIGINS`, `ADMIN_TRUSTED_ORIGINS`, `REDIS_URL`, `KAFKA_BROKERS`, `OTP_DELIVERY=notification`, `NOTIFICATION_INTERNAL_URL` | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `INTERNAL_SERVICE_TOKEN` |
| trip-service | 3002 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL` (same Redis as realtime-gateway), `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `LOCATION_INTERNAL_URL`, `MAPPING_INTERNAL_URL`, `FLEET_INTERNAL_URL`, `PRICING=service`, `PRICING_INTERNAL_URL`, `PLATFORM_INTERNAL_URL`, `SHARE_BASE_URL` (**required in production**: the public web app URL; a `http://localhost` or `http://127.` value is refused), `MATCH_TIMEOUT_SECONDS`, `OFFER_SECONDS`, `MATCH_RADII_METERS`, `TRIP_PIN_REQUIRED` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| location-service | 3003 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `MAPPING_INTERNAL_URL`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `SWEEP_INTERVAL_MS` | `INTERNAL_SERVICE_TOKEN` |
| pricing-service | 3004 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS` (**required in production**: promo redemptions in, `pricing.*` / `promo.*` / `audit.recorded` out), `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `MAPPING_INTERNAL_URL`, `LOCATION_INTERNAL_URL` (ETA on quotes), `PLATFORM_INTERNAL_URL`, `PROMO_APPROVAL_THRESHOLD_MINOR` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| payment-service | 3005 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `PLATFORM_INTERNAL_URL`, `PUBLIC_URL`, `PAYMENT_PROVIDERS`, `GATEWAY_MODE`, `PAYMENT_RETRY_SECONDS`, `RECONCILE_AFTER_SECONDS`, `SETTLEMENT_SCHEDULE`, `SIM_*` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `TELEBIRR_WEBHOOK_SECRET`, `CBEBIRR_WEBHOOK_SECRET`, `CHAPA_WEBHOOK_SECRET` |
| notification-service | 3006 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `PLATFORM_INTERNAL_URL`, `OTP_CHANNELS`, `OTP_FALLBACK_SECONDS`, `TELEGRAM_GATEWAY_URL`, `TELEGRAM_SENDER_USERNAME`, `TELEGRAM_CALLBACK_URL`, `TELEGRAM_BALANCE_ALERT_USD`, `SMS_PROVIDER`, `TWILIO_FROM`, `PUSH_PROVIDER`, `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `PHONE_HASH_KEY`, `OTP_ENCRYPTION_KEY`, `TELEGRAM_GATEWAY_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `FCM_PRIVATE_KEY` |
| mapping-service | 3007 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `OSRM_URL`, `NOMINATIM_URL`, `ENGINE_TIMEOUT_MS`, `AUTH_ISSUER`, `AUTH_JWKS_URL` | `INTERNAL_SERVICE_TOKEN` |
| fleet-service | 3008 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `PAYMENT_INTERNAL_URL`, `PLATFORM_INTERNAL_URL`, `STORAGE=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `EXPIRY_WARNING_DAYS` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY`, `UPLOAD_SIGNING_KEY` (S3 credentials come from the AWS SDK default chain; no key variables are read) |
| support-service | 3009 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `TRIP_INTERNAL_URL` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| audit-service | 3010 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| platform-service | 3011 | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL`, `SERVICE_URLS` (in-cluster URL of every service), `CONSUMER_GROUPS` | `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` |
| realtime-gateway | 3000 | `NODE_ENV`, `PORT`, `REDIS_URL`, `KAFKA_BROKERS`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_INTERNAL_URL` | `INTERNAL_SERVICE_TOKEN` |

Notes:

- `INTERNAL_SERVICE_TOKEN` must be the same value in every service (`scripts/dev-secrets.sh`
  copies auth-service's value locally).
- `REDIS_URL` and `KAFKA_BROKERS` may carry credentials in production (ElastiCache AUTH, MSK SASL).
  In that case put them in the Secret instead of the ConfigMap.
- realtime-gateway does not read `LOG_LEVEL`; its logger level comes from `NODE_ENV` only
  (`libs/shared-utils/src/logger.ts`).
- Every service reads an empty value (`KEY=`) as unset (`loadConfig` in each config file).

## 4. Probes

Every service answers three health endpoints (`src/app.ts`, or `src/server.ts` for realtime-gateway):

| Path | Behaviour |
|------|-----------|
| `/health` | always `200 {"status":"ok"}` |
| `/health/live` | always `200` |
| `/health/ready` | services with a database (auth, trip, payment, notification, fleet, audit, platform, support): `SELECT 1`, `503` on failure. location-service and realtime-gateway: Redis `PING`. pricing-service: its `ready()` check from the container. mapping-service: always `200`, with engine status in the body |

The base Deployment uses `/health` for both readiness and liveness, so readiness does not reflect
database or Redis outages. `/health/ready` is what platform-service's system page polls
(`services/platform-service/src/system/health.ts`). The Docker `HEALTHCHECK` in each Dockerfile also
uses `/health`.

## 5. Resources and scaling

| | Base | Staging | Production |
|-|------|---------|------------|
| replicas | 2 | 1 (HPA raises it to 2) | 4 (HPA may lower to 2) |
| cpu request / limit | 100m / 500m | 100m / 500m | 100m / 1000m |
| memory request / limit | 128Mi / 256Mi | same | same |
| HPA | 2–10 at 70 % CPU | same | same |

Scaling notes from the code:

- realtime-gateway uses the Socket.io Redis adapter, so any pod can reach any socket
  (`services/realtime-gateway/src/server.ts`). The load balancer must support WebSockets.
- trip-service's matcher takes a per-trip Redis lease (`match:lease:<tripId>`), and
  location-service's sweeper takes a per-city lock (`lock:sweep:{city}`), so several replicas can run
  the background loops.
- Kong's `rate-limiting` uses `policy: local`: limits are per Kong replica (see [kong.md](kong.md)).

## 6. Adding a service

Following `infra/k8s/base/README.md`: copy the three base files with the service's name, image,
port and probes, add them to `base/kustomization.yaml`, add patches to the overlays if needed, and
create the `<svc>-config` / `<svc>-secrets` objects in the cluster. pricing-service was added this
way (`pricing-service.{deployment,service,hpa}.yaml`). Also add the service to the
`build-and-push` matrix in `.github/workflows/deploy.yml`.
