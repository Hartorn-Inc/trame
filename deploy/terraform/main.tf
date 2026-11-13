# ============================================================================
# NEAR-FREE CLOUD RUN TARGET: SHARED VALUES & PROJECT APIS (main.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Track I-B of `docs/specs/spec-internet-ready-playable-trame.md` (D5, D18,
# D19, D21; ADR-0041): TRAME on Cloud Run `europe-west9` with Neon PostgreSQL
# and Cloudflare R2, for a few cents a month. This file holds the values every
# other file shares and enables the Google APIs they need.
#
# LAYOUT:
# -------
#   main.tf               Project data, shared locals, API enablement.
#   artifact_registry.tf  Docker repository + cleanup policy.
#   secrets.tf            Secret Manager secrets, service accounts, IAM.
#   cloud_run.tf          The `trame-server` service and its public invoker.
#   backup.tf             Nightly `pg_dump` Cloud Run job + Cloud Scheduler.
#   r2.tf                 R2 asset and backup buckets, CORS, lifecycle.
#   budget.tf             Monthly budget (warn 1 / 5 EUR, cap 10 EUR), email
#                         channel and the `budget-alerts` Pub/Sub topic.
#   budget_cap.tf         Cloud Run function that unlinks billing at the cap.
#   github_deploy.tf      Workload Identity Federation + deployer identity for
#                         `.github/workflows/deploy.yml`.
#   outputs.tf            URLs, image paths, operator commands.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `One Origin Everywhere`:
#      - `local.public_origin` feeds `TRAME_PUBLIC_ORIGIN` (WebSocket Origin
#        allow-list, setup and invite links) and the R2 CORS rule. Both must
#        name the exact URL players open, or WebSockets are refused and the
#        battlemap stays blank.
#   2. `Deterministic Default URL`:
#      - Without `public_origin`, the origin is Cloud Run's deterministic URL
#        `https://<service>-<project number>.<region>.run.app`, known before
#        the service exists, so no second apply is needed.
# ============================================================================

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  public_origin = coalesce(
    var.public_origin,
    "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app",
  )

  image_repository = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.trame.repository_id}"
  server_image     = "${local.image_repository}/trame-server:${var.server_image_tag}"
  ops_image        = "${local.image_repository}/trame-ops:${var.ops_image_tag}"

  r2_endpoint = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

# `serviceusage` and `cloudresourcemanager` must be enabled by hand once (README,
# "One-time bootstrap"): Terraform needs them to enable everything below.
# `sts` and `iamcredentials` turn a GitHub OIDC token into deployer credentials;
# `cloudbuild`, `cloudfunctions`, `eventarc`, `pubsub`, `storage` and
# `cloudbilling` build, trigger and run the budget-cap function.
resource "google_project_service" "enabled" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudscheduler.googleapis.com",
    "eventarc.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
