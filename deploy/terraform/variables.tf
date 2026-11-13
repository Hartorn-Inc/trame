# ============================================================================
# OPERATOR INPUTS (variables.tf)
# ============================================================================
#
# Every value an operator sets in `terraform.tfvars` (see
# `terraform.tfvars.example`). No secret value is a Terraform variable: secret
# payloads are added with `gcloud secrets versions add` so they never reach the
# Terraform state or plan files (see `secrets.tf`).
# ============================================================================

# --- Google Cloud ---------------------------------------------------------------

variable "project_id" {
  type        = string
  description = "Google Cloud project ID that hosts TRAME. It must already exist and be linked to `billing_account_id`."
}

variable "region" {
  type        = string
  description = "Region of Cloud Run, Artifact Registry and Secret Manager replicas. `europe-west9` (Paris) is a Tier 1 Cloud Run region, so the free tier applies."
  default     = "europe-west9"
}

variable "scheduler_region" {
  type        = string
  description = "Region of the Cloud Scheduler job that starts the nightly backup. It does not need to match `region`; `europe-west1` is a long-standing Cloud Scheduler location."
  default     = "europe-west1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name. It is part of the public URL `https://<service_name>-<project number>.<region>.run.app`."
  default     = "trame-server"
}

variable "server_image_tag" {
  type        = string
  description = "Tag of `trame-server` in the Artifact Registry repository (for example a git commit SHA). Use a new tag per release: reusing one does not roll out a new revision."
}

variable "ops_image_tag" {
  type        = string
  description = "Tag of `trame-ops` (built from `deploy/compose/ops`) used by the backup job."
}

variable "artifact_keep_versions" {
  type        = number
  description = "Image versions kept per image name by the Artifact Registry cleanup policy (older ones are deleted, about once a day). The free tier stores 0.5 GB."
  default     = 3

  validation {
    condition     = var.artifact_keep_versions >= 2
    error_message = "Keep at least 2 versions so the running revision and one rollback target survive cleanup."
  }
}

# --- trame-server ---------------------------------------------------------------

variable "public_origin" {
  type        = string
  description = "Browser origin players open (`TRAME_PUBLIC_ORIGIN`), without a trailing slash. Null uses the deterministic Cloud Run URL `https://<service_name>-<project number>.<region>.run.app`."
  default     = null

  validation {
    condition     = var.public_origin == null || can(regex("^https://[^/]+$", var.public_origin))
    error_message = "public_origin must look like https://host[:port] (no path, no trailing slash)."
  }
}

variable "trusted_proxy_hops" {
  type        = number
  description = "`TRAME_TRUSTED_PROXY_HOPS`: proxies that append to X-Forwarded-For before the server. 1 for the Cloud Run front end alone; 2 with one more proxy you control in front (for example a load balancer)."
  default     = 1

  validation {
    condition     = var.trusted_proxy_hops >= 0 && var.trusted_proxy_hops <= 8
    error_message = "trusted_proxy_hops must be between 0 and 8 (the server's maximum)."
  }
}

variable "bootstrap_owner_email" {
  type        = string
  description = "`TRAME_BOOTSTRAP_OWNER_EMAIL`: the only email allowed to claim the instance with the logged setup URL. Empty lets whoever opens the URL first claim it."
  default     = ""
}

variable "rust_log" {
  type        = string
  description = "`RUST_LOG` tracing filter of `trame-server`."
  default     = "info"
}

variable "secret_versions" {
  type        = map(string)
  description = "Secret Manager version per environment variable name (for example `{ TRAME_JWT_SECRET = \"2\" }`). Unlisted variables read `latest`. Pinning a new number rolls out a new revision; see the README rotation steps."
  default     = {}
}

# --- Cloudflare R2 --------------------------------------------------------------

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the R2 buckets (32 hex characters, shown in the R2 dashboard)."

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be 32 lowercase hex characters."
  }
}

variable "r2_location" {
  type        = string
  description = "R2 location hint for new buckets (`weur` = Western Europe). Only honored when a bucket is first created."
  default     = "weur"
}

variable "assets_bucket_name" {
  type        = string
  description = "R2 bucket for map images and portraits (`S3_BUCKET`). It never gets an expiration rule."
  default     = "trame-assets"
}

variable "s3_access_key_id" {
  type        = string
  description = "Access Key ID of the R2 API token used by `trame-server` (Object Read & Write on the assets bucket only). It is not secret: every presigned URL carries it. The matching secret goes to Secret Manager. Null is only accepted until the buckets exist (bootstrap step 1); the service refuses to deploy without it."
  default     = null
}

variable "backups_bucket_name" {
  type        = string
  description = "R2 bucket for the nightly `pg_dump` archives, separate from the assets so a compromised server token cannot delete backups."
  default     = "trame-backups"
}

variable "backup_s3_access_key_id" {
  type        = string
  description = "Access Key ID of the R2 API token used by the backup job (Object Read & Write on the backups bucket only). Null is only accepted until the buckets exist; the backup job refuses to deploy without it."
  default     = null
}

variable "backup_s3_prefix" {
  type        = string
  description = "Object key prefix of the dumps in the backups bucket (`BACKUP_S3_PREFIX`), without leading or trailing slash."
  default     = "trame/postgres"
}

variable "backup_retention_days" {
  type        = number
  description = "Days a dump is kept in the backups bucket (`BACKUP_RETENTION_DAYS` plus an R2 lifecycle rule as a backstop)."
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 1
    error_message = "backup_retention_days must be at least 1."
  }
}

variable "backup_schedule" {
  type        = string
  description = "Cron schedule (unix-cron, in `backup_time_zone`) of the nightly backup."
  default     = "0 3 * * *"
}

variable "backup_time_zone" {
  type        = string
  description = "IANA time zone of `backup_schedule`."
  default     = "Etc/UTC"
}

# --- Billing --------------------------------------------------------------------

variable "billing_account_id" {
  type        = string
  description = "Billing account ID (`XXXXXX-XXXXXX-XXXXXX`) that pays for the project and receives the budget."

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must look like 012345-6789AB-CDEF01."
  }
}

variable "budget_amount" {
  type        = number
  description = "Monthly budget in whole units of `budget_currency`. Alerts fire at 50 % and 100 % of actual spend and at 100 % of forecast spend; nothing is capped."
  default     = 1

  validation {
    condition     = var.budget_amount >= 1 && floor(var.budget_amount) == var.budget_amount
    error_message = "budget_amount must be a whole number of at least 1."
  }
}

variable "budget_currency" {
  type        = string
  description = "ISO 4217 currency of `budget_amount`. It must be the billing account's currency or the budget is rejected."
  default     = "EUR"
}

variable "budget_alert_email" {
  type        = string
  description = "Email address notified by the budget alerts (Cloud Monitoring email channel)."
}
