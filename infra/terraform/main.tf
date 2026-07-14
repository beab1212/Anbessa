terraform {
  required_version = ">= 1.8"
  backend "s3" {
    # Remote state with a lock table — never commit local .tfstate for a
    # production system multiple people deploy to.
    bucket         = "ride-app-tfstate"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ride-app-tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region
}

module "eks" {
  source       = "./modules/eks"
  cluster_name = "ride-app-${var.environment}"
}

module "rds_postgres" {
  source         = "./modules/rds"
  identifier     = "ride-app-${var.environment}"
  engine_version = "16"
}

module "elasticache_redis" {
  source = "./modules/elasticache"
}

module "msk_kafka" {
  source = "./modules/msk"
}
