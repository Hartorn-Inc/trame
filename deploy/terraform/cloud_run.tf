# ============================================================================
# TRAME-SERVER CLOUD RUN SERVICE (cloud_run.tf)
# ============================================================================
#
# PURPOSE:
# --------
# Runs the production image (root `Dockerfile`: API, WebSockets and the SPA on
# port 8080) as a public Cloud Run service that scales to zero between game
# sessions, with Neon for PostgreSQL and R2 for assets.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Exactly One Instance (max-instances = 1)`:
#      - Each table's `TableRoomActor` (authoritative state, undo ring, WAL
#        writer) lives in the memory of one process. A second instance would
#        run a second actor for the same table: players split between them
#        see diverging state and both write the WAL. The cap is set on the
#        revision AND the service (summed over revisions receiving traffic).
#      - A deploy does not end open WebSockets on the previous revision; they
#        last up to the 3600 s request timeout next to the new instance.
#        Deploy between sessions (README, "Updates").
#   2. `Long-Lived WebSockets`:
#      - Request timeout 3600 s (Cloud Run's maximum) bounds each socket; the
#        client reconnects after it. Session affinity sends a browser back to
#        the same instance. Each open socket holds one of the
#        `max_instance_request_concurrency` slots.
#   3. `Scale To Zero`:
#      - min-instances 0 and request-based billing (`cpu_idle`): the instance
#        is billed only while a request or socket is open, and stops about 15
#        minutes after the last one. The next visitor waits for a cold start
#        (image pull, Neon wake-up, migrations), covered by the startup probe.
#   4. `Client IP Behind The Front End`:
#      - Cloud Run's front end APPENDS the address it received the connection
#        from to `X-Forwarded-For`; anything left of it comes from the client.
#        The socket peer seen by the container is internal, so
#        `TRAME_TRUSTED_PROXY_HOPS = 1` (rightmost entry) keys rate limits on
#        the real browser address, and spoofed entries are ignored.
#   5. `Probes On /healthz`:
#      - `/healthz` answers 200 only when PostgreSQL replies within 2 s. The
#        startup probe allows 120 s for a cold Neon and migrations; the
#        liveness probe restarts the container after 90 s of failures.
# ============================================================================

resource "google_service_account" "server" {
  project      = var.project_id
  account_id   = "trame-server"
  display_name = "TRAME server (Cloud Run runtime)"
  description  = "Runtime identity of trame-server: reads its own secrets only."

  depends_on = [google_project_service.enabled]
}

locals {
  # Empty values are dropped (the server treats them as unset anyway).
  server_plain_env = { for name, value in {
    TRAME_ENV                   = "production"
    TRAME_PUBLIC_ORIGIN         = local.public_origin
    TRAME_COOKIE_SECURE         = "true"
    TRAME_TRUSTED_PROXY_HOPS    = tostring(var.trusted_proxy_hops)
    TRAME_BOOTSTRAP_OWNER_EMAIL = var.bootstrap_owner_email
    TRAME_STATIC_DIR            = "/app/static"
    RUST_LOG                    = var.rust_log
    S3_ENDPOINT                 = local.r2_endpoint
    S3_BUCKET                   = cloudflare_r2_bucket.assets.name
    S3_REGION                   = "auto"
    S3_ACCESS_KEY_ID            = var.s3_access_key_id
  } : name => value if value != "" }
}

resource "google_cloud_run_v2_service" "trame" {
  project             = var.project_id
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  scaling {
    max_instance_count = 1
  }

  template {
    service_account                  = google_service_account.server.email
    timeout                          = "3600s"
    session_affinity                 = true
    max_instance_request_concurrency = 200

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = local.server_image

      ports {
        container_port = 8080
      }

      # 1 vCPU is the floor for concurrency > 1; 512 MiB leaves headroom for
      # archive imports. The request-based free tier (180,000 vCPU-s) is about
      # 50 hours of open sockets a month at this size.
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.server_plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.server_secret_env
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

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 3
        timeout_seconds   = 3
        failure_threshold = 40
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.server,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.trame.location
  name     = google_cloud_run_v2_service.trame.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
