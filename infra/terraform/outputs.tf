output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "rds_connection_string" {
  value     = module.rds_postgres.connection_string
  sensitive = true
}
