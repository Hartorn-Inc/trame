# ============================================================================
# SECRET MANAGER SECRETS & LEAST-PRIVILEGE ACCESS (secrets.tf)
# ============================================================================
#
# PURPOSE:
# --------
# `trame-server` refuses to start outside dev without its secrets (fail-closed
# `ServerConfig`). This file creates the six Secret Manager secrets and lets
# each runtime service account read only the ones it uses. Cloud Run injects
# them as environment variables from a secret version at instance start.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Values Never In Terraform State`:
#      - Terraform creates the secrets (containers) only. Operators add each
#        value once with `gcloud secrets versions add <id> --data-file=-`
#        (README, "One-time bootstrap"), so `terraform.tfstate`, plans and
#        CI logs never hold a secret.
#   2. `Six Active Versions (Free Tier)`:
#      - Secret Manager bills active versions (enabled AND disabled) above 6
#        per billing account. Six secrets with one version each fit exactly;
#        rotation adds a version, rolls out a revision pinned to it
#        (`var.secret_versions`), then DESTROYS the old one (README).
#      - The R2 Access Key IDs are not secrets (every presigned URL carries
#        one), so they are plain variables and keep two slots free for the
#        Secret Access Keys of two separately scoped R2 tokens.
#   3. `Least Privilege`:
#      - `trame-server` reads its 5 secrets; the backup job reads only
#        `trame-database-url` and `trame-backup-s3-secret-access-key`.
#        Grants are per secret (`roles/secretmanager.secretAccessor`), never
#        project-wide.
#   4. `Regional Residency`:
#      - Payloads are replicated only to `var.region` (billed as one location).
# ============================================================================

locals {
  # Environment variable => secret id, per consumer.
  #   DATABASE_URL                 Neon DIRECT (non-pooler) URL, ...?sslmode=verify-full
  #   MASTER_ENCRYPTION_KEY        64 hex chars (AES-256-GCM key for TOTP secrets)
  #   TRAME_JWT_SECRET             >= 32 chars (HMAC key of signed asset URLs)
  #   TRAME_INVITE_JWT_SECRET      >= 32 chars (reserved HMAC key, still validated)
  #   S3_SECRET_ACCESS_KEY         R2 token secret, assets bucket
  #   BACKUP_S3_SECRET_ACCESS_KEY  R2 token secret, backups bucket
  server_secret_env = {
    DATABASE_URL            = "trame-database-url"
    MASTER_ENCRYPTION_KEY   = "trame-master-encryption-key"
    TRAME_JWT_SECRET        = "trame-jwt-secret"
    TRAME_INVITE_JWT_SECRET = "trame-invite-jwt-secret"
    S3_SECRET_ACCESS_KEY    = "trame-s3-secret-access-key"
  }
  backup_secret_env = {
    DATABASE_URL                = "trame-database-url"
    BACKUP_S3_SECRET_ACCESS_KEY = "trame-backup-s3-secret-access-key"
  }
  secret_ids = toset(concat(values(local.server_secret_env), values(local.backup_secret_env)))
}

resource "google_secret_manager_secret" "trame" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "server" {
  for_each = local.server_secret_env

  project   = var.project_id
  secret_id = google_secret_manager_secret.trame[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.server.member
}

resource "google_secret_manager_secret_iam_member" "backup" {
  for_each = local.backup_secret_env

  project   = var.project_id
  secret_id = google_secret_manager_secret.trame[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.backup.member
}
