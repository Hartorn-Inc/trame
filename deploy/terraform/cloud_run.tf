terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP Project ID"
  default     = "trame-project"
}

variable "region" {
  type        = string
  description = "GCP Region for Cloud Run deployment"
  default     = "europe-west1"
}

variable "service_name" {
  type        = string
  description = "Name of the Cloud Run v2 service"
  default     = "trame-server"
}

variable "container_image" {
  type        = string
  description = "Container image URI for trame-server"
  default     = "gcr.io/trame-project/trame-server:latest"
}

variable "public_origin" {
  type        = string
  description = "Public browser origin served by Cloud Run (TRAME_PUBLIC_ORIGIN), e.g. https://trame.example.com"
}

variable "rust_log" {
  type        = string
  description = "tracing-subscriber filter (RUST_LOG)"
  default     = "info"
}

locals {
  # Plain environment variables. Any TRAME_ENV other than `dev` makes
  # trame-server refuse to start unless every secret in `secret_env` is set.
  plain_env = {
    TRAME_ENV           = "production"
    TRAME_PUBLIC_ORIGIN = var.public_origin
    TRAME_COOKIE_SECURE = "true"
    TRAME_STATIC_DIR    = "/app/static" # SPA directory baked into the image by the Dockerfile
    RUST_LOG            = var.rust_log
  }

  # Environment variable => Secret Manager secret id (latest version). The
  # runtime service account needs roles/secretmanager.secretAccessor on each.
  #   DATABASE_URL             postgresql://user:password@host:5432/db
  #   MASTER_ENCRYPTION_KEY    64 hex chars (32 bytes), AES-256-GCM key for stored TOTP secrets
  #   TRAME_JWT_SECRET         >= 32 chars, HMAC-SHA256 key for presigned asset download URLs
  #   TRAME_INVITE_JWT_SECRET  >= 32 chars, HMAC-SHA256 key for campaign invite (magic link) tokens
  secret_env = {
    DATABASE_URL            = "trame-database-url"
    MASTER_ENCRYPTION_KEY   = "trame-master-encryption-key"
    TRAME_JWT_SECRET        = "trame-jwt-secret"
    TRAME_INVITE_JWT_SECRET = "trame-invite-jwt-secret"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_cloud_run_v2_service" "trame_server" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.container_image

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 3
        failure_threshold     = 3
      }
    }
  }
}
