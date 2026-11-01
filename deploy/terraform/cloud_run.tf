terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.9.0"
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
