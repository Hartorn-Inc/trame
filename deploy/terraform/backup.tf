# ============================================================================
# NIGHTLY NEON BACKUP: CLOUD RUN JOB + CLOUD SCHEDULER (backup.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Neon's free plan only keeps 6 hours of history, so a bad migration noticed
# the next day would lose every campaign (SEC18, D21). Each night a Cloud Run
# job runs the Compose `backup` image (`deploy/compose/ops`, `backup.sh now`):
# `pg_dump` of Neon through `DATABASE_URL`, checked with `pg_restore --list`,
# copied to the R2 backups bucket, and dumps older than the retention pruned.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Same Scripts As Compose`:
#      - No Cloud Run specific code: `backup.sh` and `restore.sh` read
#        `DATABASE_URL` when it is set. A restore is the same job with
#        overridden arguments (`restore.sh <dump>`, README).
#   2. `Failures Are Visible`:
#      - `backup.sh now` exits non-zero when the dump, its check or the upload
#        fails; the execution is retried once, then marked failed in Cloud Run.
#   3. `Retention Even If Pruning Fails`:
#      - The bucket's lifecycle rule (`r2.tf`) deletes dumps after the same
#        number of days as `BACKUP_RETENTION_DAYS`.
#   4. `Least Privilege`:
#      - The job identity reads 2 secrets; the scheduler identity may only
#        run this job (`roles/run.invoker` on the job, not the project).
#
# EXECUTION LIFECYCLE:
# --------------------
#   Cloud Scheduler (`var.backup_schedule`)
#     └── POST run.googleapis.com/v2/.../jobs/trame-backup:run (OAuth, scheduler SA)
#           └── task: `backup.sh now` -> pg_dump -> /backups (in-memory)
#                 -> mc cp to r2/<backups bucket>/<prefix>/ -> prune old dumps
# ============================================================================

resource "google_service_account" "backup" {
  project      = var.project_id
  account_id   = "trame-backup"
  display_name = "TRAME backup job (Cloud Run runtime)"
  description  = "Runtime identity of the nightly pg_dump job: reads the database URL and the backup bucket key."

  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "backup_scheduler" {
  project      = var.project_id
  account_id   = "trame-backup-scheduler"
  display_name = "TRAME backup scheduler"
  description  = "Cloud Scheduler identity allowed to start the trame-backup job only."

  depends_on = [google_project_service.enabled]
}

locals {
  backup_plain_env = {
    BACKUP_RETENTION_DAYS   = tostring(var.backup_retention_days)
    BACKUP_S3_ENDPOINT      = local.r2_endpoint
    BACKUP_S3_BUCKET        = cloudflare_r2_bucket.backups.name
    BACKUP_S3_PREFIX        = var.backup_s3_prefix
    BACKUP_S3_ACCESS_KEY_ID = var.backup_s3_access_key_id
  }
}

resource "google_cloud_run_v2_job" "backup" {
  project             = var.project_id
  name                = "trame-backup"
  location            = var.region
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.backup.email
      timeout         = "1800s"
      max_retries     = 1

      containers {
        image = local.ops_image
        args  = ["backup.sh", "now"]

        # The dump is written to the in-memory filesystem before upload, so
        # memory bounds the largest dump (Neon free storage is 1 GB).
        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        dynamic "env" {
          for_each = local.backup_plain_env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = local.backup_secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.trame[env.value].secret_id
                version = lookup(var.secret_versions, env.key, "latest")
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = try(length(var.backup_s3_access_key_id) > 0, false)
      error_message = "Set backup_s3_access_key_id (R2 token of the backups bucket) before deploying the backup job."
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.backup,
  ]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.backup.location
  name     = google_cloud_run_v2_job.backup.name
  role     = "roles/run.invoker"
  member   = google_service_account.backup_scheduler.member
}

resource "google_cloud_scheduler_job" "backup" {
  project     = var.project_id
  region      = var.scheduler_region
  name        = "trame-backup-nightly"
  description = "Starts the trame-backup Cloud Run job (pg_dump of Neon to R2)."
  schedule    = var.backup_schedule
  time_zone   = var.backup_time_zone

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.backup.name}:run"

    oauth_token {
      service_account_email = google_service_account.backup_scheduler.email
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
  ]
}
