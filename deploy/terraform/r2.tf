# ============================================================================
# CLOUDFLARE R2 BUCKETS: ASSETS (CORS) & BACKUPS (LIFECYCLE) (r2.tf)
# ============================================================================
#
# PURPOSE:
# --------
# With `S3_*` set, `trame-server` stores map images and portraits in R2 and
# answers downloads with a 5-minute presigned redirect, so asset bytes never
# leave Cloud Run (Europe egress is billed from the first byte; R2 egress is
# free) (ADR-0041). A second bucket holds the nightly database dumps.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Read-Only, Single-Origin CORS`:
#      - The battlemap is a WebGL texture loaded with `crossOrigin =
#        "anonymous"`; without `Access-Control-Allow-Origin` for the public
#        origin the map stays blank. Only GET/HEAD from `local.public_origin`
#        are allowed, the same rule as `deploy/compose/r2-cors.example.json`
#        and `ops/apply-bucket-cors.sh`: uploads always go through the server.
#   2. `Assets Never Expire`:
#      - The assets bucket has no lifecycle rule: keys are content addresses
#        referenced from PostgreSQL, and a deleted object is a lost map.
#   3. `Backups Expire`:
#      - Dumps under `var.backup_s3_prefix/` are deleted after
#        `var.backup_retention_days` days, even if `backup.sh` pruning fails.
#   4. `No Accidental Deletion`:
#      - Both buckets carry `prevent_destroy`; `terraform destroy` stops
#        before deleting data (README, "Tear down").
#
# The R2 API tokens the server and the backup job use are created by hand in the
# dashboard (one per bucket, Object Read & Write): the Cloudflare token
# Terraform runs with only needs "Workers R2 Storage Write".
# ============================================================================

resource "cloudflare_r2_bucket" "assets" {
  account_id = var.cloudflare_account_id
  name       = var.assets_bucket_name
  location   = var.r2_location

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_cors" "assets" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.assets.name

  rules = [{
    id = "trame-public-origin-read"
    allowed = {
      methods = ["GET", "HEAD"]
      origins = [local.public_origin]
      headers = ["*"]
    }
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = var.backups_bucket_name
  location   = var.r2_location

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name

  rules = [{
    id      = "expire-old-dumps"
    enabled = true
    conditions = {
      prefix = "${var.backup_s3_prefix}/"
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.backup_retention_days * 86400
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        type    = "Age"
        max_age = 86400
      }
    }
  }]
}
