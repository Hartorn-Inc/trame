# ============================================================================
# KEYLESS GITHUB ACTIONS DEPLOYMENT (github_deploy.tf)
# ============================================================================
#
# PURPOSE:
# --------
# `.github/workflows/deploy.yml` builds the images of a green `main` commit,
# pushes them to Artifact Registry and rolls them out to Cloud Run. It signs
# in with Workload Identity Federation: GitHub's OIDC token is exchanged for
# short-lived credentials of the `trame-deployer` service account, so no
# service account key exists anywhere.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `One Repository, One Branch`:
#      - The provider's attribute condition rejects every token whose
#        `repository` is not `var.github_repository` or whose `ref` is not
#        `var.github_deploy_ref`. Tokens from forks, other branches, tags and
#        pull requests never get credentials.
#      - The workflow additionally requires a successful CI run of a `push`
#        in this repository: `workflow_run` jobs always carry the default
#        branch ref, whatever triggered CI.
#   2. `Deployer Scoped To Its Targets`:
#      - `roles/run.admin` on the `trame-server` service and the
#        `trame-backup` job only, `roles/artifactregistry.writer` on the
#        `trame` repository only, and `roles/iam.serviceAccountUser` on the
#        two runtime service accounts only (needed to roll out a revision
#        that runs as them). No project-level grant.
#   3. `Terraform Owns Everything But The Image`:
#      - The service and the job ignore image changes (`cloud_run.tf`,
#        `backup.tf`), so a workflow deploy and a later `terraform apply` do
#        not undo each other.
#   4. `Pool IDs Are Sticky`:
#      - A deleted pool or provider stays soft-deleted for 30 days and its ID
#        cannot be reused meanwhile; `terraform destroy` then `apply` within
#        that window fails until the IDs are undeleted or renamed.
# ============================================================================

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "trame-github"
  display_name              = "TRAME GitHub Actions"
  description               = "GitHub Actions OIDC tokens of ${var.github_repository}."

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"
  description                        = "Accepts only ${var.github_repository} on ${var.github_deploy_ref}."

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == '${var.github_deploy_ref}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "trame-deployer"
  display_name = "TRAME deployer (GitHub Actions)"
  description  = "Used by deploy.yml through Workload Identity Federation: pushes images and updates trame-server and trame-backup."

  depends_on = [google_project_service.enabled]
}

resource "google_service_account_iam_member" "deployer_workload_identity" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.trame.location
  repository = google_artifact_registry_repository.trame.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deployer.member
}

resource "google_cloud_run_v2_service_iam_member" "deployer_admin" {
  project  = var.project_id
  location = google_cloud_run_v2_service.trame.location
  name     = google_cloud_run_v2_service.trame.name
  role     = "roles/run.admin"
  member   = google_service_account.deployer.member
}

resource "google_cloud_run_v2_job_iam_member" "deployer_admin" {
  project  = var.project_id
  location = google_cloud_run_v2_job.backup.location
  name     = google_cloud_run_v2_job.backup.name
  role     = "roles/run.admin"
  member   = google_service_account.deployer.member
}

resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  for_each = {
    server = google_service_account.server.name
    backup = google_service_account.backup.name
  }

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}
