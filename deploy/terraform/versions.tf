# ============================================================================
# TERRAFORM & PROVIDER PINS (versions.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Pins Terraform and every provider to exact releases so `terraform init`
# resolves the same plugins on every machine and in CI (`make lint-terraform`
# checks `.terraform.lock.hcl` read-only). Bump them together with the lock
# file: `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 ...`.
#
# State is local by default; the README ("Remote state") shows the optional
# GCS backend.
# ============================================================================

terraform {
  required_version = "1.17.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.10.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }
}

# Budgets (`google_billing_budget`) return 403 with user credentials unless calls are
# billed to a quota project, so every call is attributed to the deployment project.
provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

# Reads `CLOUDFLARE_API_TOKEN` (permission: Workers R2 Storage Write) from the environment.
provider "cloudflare" {}
