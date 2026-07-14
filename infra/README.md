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
make infra-up          # starts postgres, redis, redpanda, kong

# Or the mapping stack separately (heavy — needs a regional OSM data import)
docker compose -f mapping-stack/docker-compose.mapping.yml up -d
```

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
