# infra

Everything the DevOps / platform team owns.

## Folders

| Folder | What it is |
|--------|-----------|
| `docker/` | `docker-compose.yml` — the full local dev stack |
| `kong/` | Declarative Kong gateway config (DB-less, version-controlled) |
| `mapping-stack/` | Self-hosted free mapping: OSM tiles + Nominatim + OSRM |
| `k8s/` | Kustomize base manifests + staging/production overlays |
| `terraform/` | Cloud infra: EKS, RDS Postgres+PostGIS, ElastiCache, MSK |

## Quick start (local)

```bash
# From repo root
make infra-up          # starts postgres, redis, redpanda
make stack-up          # full containerized stack: every service image + kong on :8000

# Or the mapping stack separately (heavy — needs a regional OSM data import)
docker compose -f mapping-stack/docker-compose.mapping.yml up -d
```

### Local image versions

| Service | Image |
|---------|-------|
| Postgres + PostGIS | `postgis/postgis:18-3.6-alpine` |
| Redis | `redis:8-alpine` |
| Kafka API | `redpandadata/redpanda:v26.2.6` |
| Gateway | `kong:3.9` (Kong no longer publishes alpine tags) |
| Mapping stack | `maptiler/tileserver-gl:v5.7.0`, `mediagis/nominatim:5.3`, `osrm/osrm-backend:v5.25.0` |

> **Upgrading from the old Postgres 16 volume?** Postgres 18 images keep data
> under `/var/lib/postgresql` (not `.../data`), and a 16 data directory won't
> start on 18. Run `make infra-reset` (wipes local volumes, re-migrates and
> re-seeds), or delete `services/*/.dev-data/postgres` for the per-service stacks.

Service images build from the **repo root** (`docker build -f services/<svc>/Dockerfile .`)
so the pnpm workspace libs are in the build context. `docker/docker-compose.yml` and
`.github/workflows/deploy.yml` are already set up that way.

## Deploying to staging

```bash
# Staging deploys automatically from the main branch via GitHub Actions.
# To trigger manually:
kubectl apply -k k8s/overlays/staging
```

## Deploying to production

Production deploys require a manual approval gate in GitHub Actions.
After the staging deploy succeeds, approve the `deploy-production` job
in the GitHub Actions UI.

```bash
# Or deploy directly (requires cluster credentials):
kubectl apply -k k8s/overlays/production
```

## Terraform

Pins the AWS provider to `~> 6.0`. See [`terraform/README.md`](terraform/README.md)
for open version decisions (RDS major version, state locking).

```bash
cd terraform
terraform init
terraform plan -var="environment=production"
terraform apply -var="environment=production"
```

## Secrets management

Never commit secrets. The pattern used here:
- Local dev: `.env` files per service (gitignored)
- Staging/production: Kubernetes Secrets, populated from a secrets manager
  (AWS Secrets Manager / GCP Secret Manager depending on cloud)
- GitHub Actions: `secrets.*` context in workflow files

## Documentation

Detailed reference for everything in this folder (compose files, Makefile targets, Kong routes,
Kubernetes, Terraform, mapping stack, CI/CD, data stores, production checklist):
[docs/README.md](docs/README.md).
