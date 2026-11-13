# ============================================================================
# ARTIFACT REGISTRY REPOSITORY (artifact_registry.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Holds the `trame-server` and `trame-ops` images Cloud Run pulls. The repository
# lives in `var.region`, so pulls stay in-region (no egress charge).
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Bounded Storage`:
#      - Every version is a deletion candidate, except the
#        `var.artifact_keep_versions` most recent per image name (KEEP wins
#        over DELETE). The free tier stores 0.5 GB.
#   2. `Running Image Survives`:
#      - With min-instances 0 every cold start pulls the image again, so the
#        deployed tag must stay among the kept versions: deploy what you push,
#        and push single-platform images without attestations (README) so one
#        release is one version.
# ============================================================================

resource "google_artifact_registry_repository" "trame" {
  project       = var.project_id
  location      = var.region
  repository_id = "trame"
  description   = "TRAME container images (trame-server, trame-ops)."
  format        = "DOCKER"

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-old-versions"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }

  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_keep_versions
    }
  }

  depends_on = [google_project_service.enabled]
}
