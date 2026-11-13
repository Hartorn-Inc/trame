# ============================================================================
# OPERATOR OUTPUTS (outputs.tf)
# ============================================================================
#
# URLs to share and ready-to-paste commands for the README procedures
# (`terraform output -raw <name>`). None of them contains a secret.
# ============================================================================

output "public_origin" {
  description = "URL players open (`TRAME_PUBLIC_ORIGIN`, also the R2 CORS origin). Share this one: other run.app URLs of the service fail the WebSocket Origin check."
  value       = local.public_origin
}

output "service_uri" {
  description = "Main URI Cloud Run reports for the service (may be the older hash-style run.app URL)."
  value       = google_cloud_run_v2_service.trame.uri
}

output "image_repository" {
  description = "Artifact Registry path to tag and push `trame-server` and `trame-ops` images to."
  value       = local.image_repository
}

output "secret_ids" {
  description = "Secret Manager secret ids, each needing one version (`gcloud secrets versions add <id> --data-file=-`)."
  value       = sort(tolist(local.secret_ids))
}

output "owner_bootstrap_url_command" {
  description = "Prints the newest one-hour owner setup URL from Cloud Logging (logged at each start while no Owner exists)."
  value = join(" ", [
    "gcloud logging read",
    "'resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.trame.name}\" AND jsonPayload.fields.event=\"owner_bootstrap_url\"'",
    "--project=${var.project_id} --freshness=1h --limit=1",
    "--format='value(jsonPayload.fields.setup_url)'",
  ])
}

output "backup_now_command" {
  description = "Runs the backup job once and waits for it."
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.backup.name} --project=${var.project_id} --region=${var.region} --wait"
}

output "restore_list_command" {
  description = "Lists the dumps in the backups bucket (read the execution logs for the list)."
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.backup.name} --project=${var.project_id} --region=${var.region} --args=restore.sh,list --wait"
}
