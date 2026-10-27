# CI/CD

Two GitHub Actions workflows, a turbo task pipeline, and one multi-stage Dockerfile per service.
The release process around them is in [docs/production/README.md](../../docs/production/README.md).

> `.gitignore` contains `.github/`, and `git ls-files .github` lists nothing: both workflow files
> exist only on disk and never reach GitHub. Remove that line to enable them.

## 1. `.github/workflows/ci.yml` (CI)

Triggers: every `pull_request`, and `push` to `main`.

| Job | Runner | Steps |
|-----|--------|-------|
| `node-services` | `ubuntu-latest` | `actions/checkout@v7` → `pnpm/action-setup@v6` (version from `packageManager`, `pnpm@11.13.0`) → `actions/setup-node@v7` (`node-version-file: .nvmrc` = `24`, pnpm cache) → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` |
| `flutter-apps` | `ubuntu-latest` | `actions/checkout@v7` → `subosito/flutter-action@v2` (stable, `3.44.x`, cache) → `dart pub get` → `dart run melos run analyze` → `dart run melos run test` |

`pnpm lint|typecheck|test|build` are root scripts that run `turbo run <task>` (section 3). `pnpm test`
runs each package's `test` script; the services' `test` scripts exclude `tests/integration/**`, and
no job runs `test:integration` or starts Postgres/Redis/Kafka. No Docker build, Kong config check,
`kustomize build`, or `terraform validate` runs in CI.

## 2. `.github/workflows/deploy.yml` (Deploy)

Trigger: `push` to `main`. No `pull_request`, no `workflow_dispatch`.

| Job | Needs | Environment | Steps |
|-----|-------|-------------|-------|
| `build-and-push` (matrix) | | | `actions/checkout@v7` → `docker/setup-buildx-action@v4` → `docker/login-action@v4` to `registry.example.com` with `secrets.REGISTRY_USER` / `secrets.REGISTRY_TOKEN` → `docker/build-push-action@v7` (context `.`, file `services/<svc>/Dockerfile`, `push: true`) |
| `deploy-staging` | `build-and-push` | `staging` | checkout → `kubectl apply -k infra/k8s/overlays/staging` |
| `deploy-production` | `deploy-staging` | `production` (comment: protected, manual approval) | checkout → `kubectl apply -k infra/k8s/overlays/production` |

Images built: one per matrix entry, tagged only
`registry.example.com/ride-app/<service>:${{ github.sha }}`. The matrix is auth-service,
trip-service, location-service, pricing-service, payment-service, notification-service,
mapping-service, realtime-gateway. **fleet-service, platform-service and audit-service are not
built**, and the web app is not built or deployed by any workflow.

Gaps in the deploy jobs as written:

- No step configures cluster access (no cloud credentials, no kubeconfig), so `kubectl` has no
  cluster to talk to.
- No step sets the image tag: the manifests reference `:latest` ([kubernetes.md](kubernetes.md)).
- No migration step runs before rollout (see [data-stores.md](data-stores.md)).
- `kubectl apply` does not wait for the rollout; nothing checks `kubectl rollout status`.
- No build cache settings are passed to `build-push-action`, so the Dockerfile's
  `--mount=type=cache` only helps within one runner.

GitHub secrets referenced: `REGISTRY_USER`, `REGISTRY_TOKEN`. GitHub environments referenced:
`staging`, `production`.

## 3. Turbo pipeline (`turbo.json`)

Workspace packages come from `pnpm-workspace.yaml`: `services/*`, `libs/*`, `apps/web`.

| Task | `dependsOn` | Inputs / outputs | Other |
|------|-------------|------------------|-------|
| `generate` | | inputs `prisma/schema.prisma`; outputs `src/generated/**` | runs `prisma generate` in the 7 Prisma services |
| `build` | `^build` (dependencies' build first), `generate` | outputs `dist/**` | |
| `test` | `^build`, `generate` | outputs `coverage/**` | |
| `lint` | `generate` | | |
| `typecheck` | `generate` | | |
| `dev` | `^build`, `generate` | | `cache: false`, `persistent: true` |

Root scripts (`package.json`): `build`, `dev` (`turbo run dev --parallel`), `lint`, `test`,
`typecheck`, `format` / `format:check` (Prettier). Engines: Node `>=24`. `make dev-services` adds
`--concurrency=32`, because turbo's default of 10 would leave some of the 12 persistent dev tasks
unstarted (comment in `Makefile`).

Other workspace settings in `pnpm-workspace.yaml`: `allowBuilds` for `@prisma/engines`, `argon2`,
`esbuild`, `prisma`; `minimumReleaseAgeExclude` for listed `better-auth` and `maplibre` versions;
`patchedDependencies: kafkajs@2.2.4: patches/kafkajs@2.2.4.patch`.

## 4. Service Dockerfiles

All 11 `services/*/Dockerfile` files are the same apart from the service name and port. Build from
the repo root so `libs/*` are in the context:

```bash
docker build -f services/trip-service/Dockerfile -t ride-app/trip-service .
```

| Stage | Base | What it does |
|-------|------|--------------|
| `base` | `node:24-alpine` | `PNPM_HOME=/pnpm`, `CI=true`, `corepack enable`, `WORKDIR /repo` |
| `build` | `base` | copy `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json` → `pnpm fetch` (cache mount `/pnpm/store`) → `COPY . .` → `pnpm install --frozen-lockfile --offline --filter @ride-app/<svc>...` → `pnpm --filter @ride-app/<svc>... build` → `pnpm --filter @ride-app/<svc> deploy --prod --legacy /out` |
| `runtime` | `node:24-alpine` | `WORKDIR /app`, `NODE_ENV=production`, non-root user `app`; copies `/out/node_modules`, `/out/dist`, `/out/package.json` (auth-service and notification-service also `/out/prisma`); `EXPOSE <port>`; `HEALTHCHECK` `wget -qO- http://localhost:<port>/health` every 15 s, timeout 3 s; `CMD ["node", "dist/server.js"]` |

Details:

- The Prisma client is generated by each Prisma service's `postinstall: prisma generate` during
  `pnpm install`; `src/generated` is excluded from the context by `.dockerignore`.
- The root `.dockerignore` excludes `node_modules`, `dist`, `coverage`, `.turbo`, `.dev-data`, logs,
  `.env` files, `src/generated`, `tests`, `.git`, `apps/phone-app`, `packages`, `infra`, `docs`,
  `secrets`, `learned`.
- `services/auth-service/.dockerignore` also exists. Docker reads `.dockerignore` from the context
  root (the repo root here), so this file has no effect on these builds.
- The runtime image has no Prisma CLI (`prisma` is a devDependency), so it can't run
  `prisma migrate deploy` ([docs/production/README.md](../../docs/production/README.md) section 6).
- Image ports: realtime-gateway 3000, auth 3001, trip 3002, location 3003, pricing 3004, payment
  3005, notification 3006, mapping 3007, fleet 3008, audit 3010, platform 3011.
