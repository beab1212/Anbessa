# Terraform

Cloud infrastructure for what Kubernetes doesn't manage, on AWS. Files: `infra/terraform/main.tf`,
`variables.tf`, `outputs.tf`, `README.md`. Version notes are in
[infra/terraform/README.md](../terraform/README.md).

**Status:** `main.tf` calls four local modules under `./modules/`, and `infra/terraform/modules/` is
an empty directory. No resource is defined anywhere, so `terraform init` (and `make setup-infra`)
fails until the modules are written. Everything below describes what the root module declares.

## 1. Versions and provider

| Setting | Value |
|---------|-------|
| `required_version` | `>= 1.8` |
| Provider | `hashicorp/aws ~> 6.0` |
| Provider region | `var.aws_region` |

## 2. State backend

```hcl
backend "s3" {
  bucket         = "ride-app-tfstate"
  key            = "production/terraform.tfstate"
  region         = "us-east-1"
  dynamodb_table = "ride-app-tfstate-lock"
  encrypt        = true
}
```

- `encrypt = true`: the state (which contains RDS passwords and other secrets) is encrypted at rest.
  To use a customer-managed KMS key, pass it at init; a backend block cannot read Terraform
  variables, so there is no `kms_key_id` variable:
  `terraform init -backend-config="kms_key_id=arn:aws:kms:us-east-1:<account>:key/<id>"`.
  The key policy must let every deployer role `kms:Encrypt`, `kms:Decrypt` and `kms:GenerateDataKey`.

- The bucket and the DynamoDB lock table must exist before `terraform init`; nothing in repo creates them.
- The state `key` is fixed to `production/terraform.tfstate`, while `var.environment` selects the
  environment. Running with `-var="environment=staging"` against the same backend uses the same state
  file. There are no workspaces or per-environment backend files in repo.
- `infra/terraform/README.md` notes that Terraform ≥ 1.11 supports `use_lockfile = true`; switching
  needs a state migration.
- `.gitignore` excludes `infra/terraform/.terraform/`, `*.tfstate`, `*.tfstate.backup` and
  `.terraform.lock.hcl` (so provider versions are not locked in git).

## 3. Variables (`variables.tf`)

| Variable | Type | Default | Used for |
|----------|------|---------|----------|
| `aws_region` | string | `us-east-1` | provider region |
| `environment` | string | none (required) | name suffix: `ride-app-${var.environment}` |

## 4. Modules (`main.tf`)

| Module block | Source | Arguments | Intended resource (from `infra/terraform/README.md` / `infra/README.md`) |
|--------------|--------|-----------|---------------------------------------------|
| `eks` | `./modules/eks` | `cluster_name = "ride-app-${var.environment}"` | EKS cluster |
| `rds_postgres` | `./modules/rds` | `identifier = "ride-app-${var.environment}"`, `engine_version = "16"` | RDS Postgres with PostGIS ("enabled via a bootstrap script", not found in repo) |
| `elasticache_redis` | `./modules/elasticache` | none | ElastiCache Redis |
| `msk_kafka` | `./modules/msk` | none | MSK (managed Kafka) |

Not declared: VPC/networking, S3 bucket for fleet-service documents, IAM roles for service accounts,
container registry, DNS, certificates, load balancers, Secrets Manager entries, the tile and mapping
servers.

RDS is pinned to Postgres 16; local development runs Postgres 18 (`postgis/postgis:18-3.6-alpine`).
The README calls this a deliberate decision pending a maintenance window.

## 5. Outputs (`outputs.tf`)

| Output | Value | Sensitive |
|--------|-------|-----------|
| `eks_cluster_endpoint` | `module.eks.cluster_endpoint` | no |
| `rds_connection_string` | `module.rds_postgres.connection_string` | yes |

Both reference module outputs that don't exist yet. The services need one database per service
(see [data-stores.md](data-stores.md)); a single connection string output does not cover that.
Nothing outputs the Redis or Kafka endpoints.

## 6. How to apply

From `infra/README.md`:

```bash
cd infra/terraform
terraform init
terraform plan  -var="environment=production"
terraform apply -var="environment=production"
```

`make setup-infra` runs only `terraform init` (after checking `terraform` and `kubectl` are
installed). No CI workflow runs Terraform.
