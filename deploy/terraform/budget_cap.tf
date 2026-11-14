# ============================================================================
# BUDGET HARD CAP: CLOUD RUN FUNCTION THAT UNLINKS BILLING (budget_cap.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Budgets only notify. This gen2 Cloud Run function (source in `budget-cap/`)
# receives every message the monthly budget (`budget.tf`) publishes to the
# `budget-alerts` topic and, once actual spend reaches `var.budget_amount`,
# unlinks the project from its billing account. That stops every service in
# the project (TRAME goes offline) instead of letting a runaway cost grow.
# Neon and R2 are billed elsewhere and keep the data.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Stop At The Cap`:
#      - The function acts when `costAmount >= budgetAmount` (`cap.js`). Billing
#        data lags by hours, so the month can still end a little above the cap.
#   2. `Least Privilege`:
#      - Runtime identity `trame-budget-cap`: `roles/billing.projectManager` on
#        this project only (enough to unlink it, nothing on the billing
#        account) and `roles/run.invoker` on the function itself, so Eventarc
#        can deliver the Pub/Sub messages with it.
#      - Build identity `trame-budget-cap-build`: `roles/cloudbuild.builds.builder`.
#        A dedicated build account avoids depending on the Compute Engine
#        default account, which recent projects create without permissions.
#   3. `Reproducible Source`:
#      - `archive_file` zips an explicit file list (tests and `node_modules`
#        stay out); dependencies are pinned exactly in `package.json` and
#        `package-lock.json` (`npm ci` at build time). The object name carries
#        the zip's SHA-256, so any source change rebuilds the function and an
#        unchanged source causes no diff.
#   4. `No Retry Storm`:
#      - The trigger does not retry failed deliveries; the budget publishes
#        again within hours, which retries the decision with fresher data.
#   5. `Internal Only`:
#      - Ingress accepts internal traffic only (Eventarc and Pub/Sub); the
#        function has no public URL.
#
# EXECUTION LIFECYCLE:
# --------------------
#   terraform apply
#   ├── 1. archive_file: budget-cap/{cap.js,index.js,package*.json} -> .build/budget-cap.zip
#   ├── 2. Upload to gs://<project>-budget-cap-source/budget-cap-<sha256>.zip
#   └── 3. Cloud Build (nodejs24, `npm ci`) -> function `trame-budget-cap`
#   Runtime: budget -> Pub/Sub `budget-alerts` -> Eventarc -> `stopBilling`
#            -> getProjectBillingInfo -> updateProjectBillingInfo(billingAccountName = "")
# ============================================================================

data "archive_file" "budget_cap" {
  type             = "zip"
  output_path      = "${path.module}/.build/budget-cap.zip"
  output_file_mode = "0644"

  dynamic "source" {
    for_each = toset(["cap.js", "index.js", "package.json", "package-lock.json"])
    content {
      filename = source.value
      content  = file("${path.module}/budget-cap/${source.value}")
    }
  }
}

resource "google_storage_bucket" "budget_cap_source" {
  project                     = var.project_id
  name                        = "${var.project_id}-budget-cap-source"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Holds only the function's zipped source, rebuilt from git on every apply.
  force_destroy = true

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_object" "budget_cap_source" {
  bucket = google_storage_bucket.budget_cap_source.name
  name   = "budget-cap-${data.archive_file.budget_cap.output_sha256}.zip"
  source = data.archive_file.budget_cap.output_path
}

resource "google_service_account" "budget_cap" {
  project      = var.project_id
  account_id   = "trame-budget-cap"
  display_name = "TRAME budget cap (Cloud Run function runtime)"
  description  = "Unlinks this project from its billing account when the monthly budget reaches its cap."

  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "budget_cap_build" {
  project      = var.project_id
  account_id   = "trame-budget-cap-build"
  display_name = "TRAME budget cap (function build)"
  description  = "Cloud Build identity that builds the trame-budget-cap function image."

  depends_on = [google_project_service.enabled]
}

resource "google_project_iam_member" "budget_cap_billing" {
  project = var.project_id
  role    = "roles/billing.projectManager"
  member  = google_service_account.budget_cap.member
}

resource "google_project_iam_member" "budget_cap_build" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = google_service_account.budget_cap_build.member
}

resource "google_cloudfunctions2_function" "budget_cap" {
  project     = var.project_id
  name        = "trame-budget-cap"
  location    = var.region
  description = "Unlinks the project from billing when the monthly budget reaches its cap."

  build_config {
    runtime         = "nodejs24"
    entry_point     = "stopBilling"
    service_account = google_service_account.budget_cap_build.id

    source {
      storage_source {
        bucket = google_storage_bucket.budget_cap_source.name
        object = google_storage_bucket_object.budget_cap_source.name
      }
    }
  }

  service_config {
    min_instance_count             = 0
    max_instance_count             = 1
    available_memory               = "256M"
    timeout_seconds                = 60
    ingress_settings               = "ALLOW_INTERNAL_ONLY"
    all_traffic_on_latest_revision = true
    service_account_email          = google_service_account.budget_cap.email
    environment_variables = {
      TARGET_PROJECT_ID = var.project_id
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.budget_alerts.id
    retry_policy          = "RETRY_POLICY_DO_NOT_RETRY"
    service_account_email = google_service_account.budget_cap.email
  }

  depends_on = [
    google_project_service.enabled,
    google_project_iam_member.budget_cap_build,
  ]
}

# Eventarc pushes each Pub/Sub message to the function's Cloud Run service with
# an identity token of the trigger's service account.
resource "google_cloud_run_v2_service_iam_member" "budget_cap_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloudfunctions2_function.budget_cap.service_config[0].service
  role     = "roles/run.invoker"
  member   = google_service_account.budget_cap.member
}
