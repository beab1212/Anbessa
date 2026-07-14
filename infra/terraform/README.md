# terraform

Infra-as-code for the cloud resources Kubernetes itself doesn't manage: the
EKS cluster, RDS Postgres (with PostGIS enabled via a bootstrap script), an
ElastiCache Redis cluster, and an MSK (managed Kafka) cluster. `modules/`
holds the actual resource definitions per concern — kept empty here since the
specifics depend on which cloud you're on (this assumes AWS; swap for GKE/Azure
equivalents if needed).
