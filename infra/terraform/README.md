# terraform

Infra-as-code for the cloud resources Kubernetes itself doesn't manage: the
EKS cluster, RDS Postgres (with PostGIS enabled via a bootstrap script), an
ElastiCache Redis cluster, and an MSK (managed Kafka) cluster. `modules/`
holds the actual resource definitions per concern — kept empty here since the
specifics depend on which cloud you're on (this assumes AWS; swap for GKE/Azure
equivalents if needed).

## Versions

- Terraform `>= 1.8`; AWS provider pinned to `hashicorp/aws ~> 6.0` in `main.tf`.
- **RDS is still on Postgres 16** (`engine_version = "16"`), while local dev runs
  Postgres 18. Moving production to 18 is a major-version upgrade that needs a
  maintenance window, so it's a deliberate infra decision and wasn't bumped.
- The S3 backend still locks with `dynamodb_table`. Terraform ≥ 1.11 also
  supports native S3 locking (`use_lockfile = true`); switching requires
  a state migration.
