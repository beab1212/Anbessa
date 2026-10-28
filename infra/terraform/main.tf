terraform {
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    # Remote state with a lock table — never commit local .tfstate for a
    # production system multiple people deploy to.
    bucket         = "ride-app-tfstate"
    key            = "production/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ride-app-tfstate-lock"
    # The state holds database passwords and other secrets: always encrypted at rest.
    encrypt = true
    # Customer-managed KMS key for the state objects. A backend block can't read
    # variables, so the key is passed at init (partial configuration):
    #   terraform init -backend-config="kms_key_id=arn:aws:kms:us-east-1:<account>:key/<id>"
    # Without it S3 uses SSE with the AWS-managed key (still encrypted).
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
