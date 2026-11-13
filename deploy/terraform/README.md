# TRAME on Cloud Run + Neon + R2 (near-free)

This directory deploys TRAME on Google Cloud Run in Paris (`europe-west9`), with PostgreSQL on Neon's free plan and assets on Cloudflare R2. An idle table costs nothing and a weekly game night usually stays inside the free tiers. A card is required on the Google Cloud billing account, and a budget alert emails you at 1 EUR. For a setup with no card, use the Compose stack in [`deploy/compose`](../compose/README.md).

| Resource | File | Notes |
| :--- | :--- | :--- |
| Cloud Run service `trame-server` | `cloud_run.tf` | Public, 0 to 1 instance, 1 vCPU / 512 MiB, timeout 3600 s, session affinity |
| Artifact Registry repository `trame` | `artifact_registry.tf` | Keeps the 3 newest versions of each image |
| 6 Secret Manager secrets | `secrets.tf` | Values added with `gcloud`, never stored in Terraform state |
| Service accounts `trame-server`, `trame-backup`, `trame-backup-scheduler` | `cloud_run.tf`, `backup.tf` | Each one reads only its own secrets |
| Cloud Run job `trame-backup` + Cloud Scheduler job | `backup.tf` | Nightly `pg_dump` of Neon to R2, kept 14 days |
| R2 buckets `trame-assets` (CORS) and `trame-backups` (expiry) | `r2.tf` | Protected by `prevent_destroy` |
| Monthly budget + email channel | `budget.tf` | Alerts at 50 %, 100 % and forecast 100 % of 1 EUR |
| Neon project | (manual) | Free plan, Frankfurt |

## Before you start

- A Google Cloud project linked to a billing account. You need Owner on the project, and Billing Account Administrator or Billing Account Costs Manager on the billing account for the budget.
- The `gcloud` CLI, logged in twice: `gcloud auth login` and `gcloud auth application-default login`. Then `gcloud config set project <project>` and `gcloud auth application-default set-quota-project <project>`.
- Terraform 1.17.1 (pinned in `versions.tf`). Docker with `buildx` to build the images.
- A Neon account, and a Cloudflare account with R2 enabled.
- If your organization enforces "Domain restricted sharing", the public invoker (`allUsers`) is refused. Ask for an exception for this project.

## One-time bootstrap

1. **Neon.** Create a project in AWS Europe Central 1 (Frankfurt) with the newest PostgreSQL version offered. In the compute settings, cap autoscaling at 0.25 or 0.5 CU: the free plan has 100 CU-hours a month. Copy the **direct** connection string (connection pooling turned off, host without `-pooler`), for example `postgresql://neondb_owner:...@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`. The pooled endpoint does not work: `trame-server` sets `statement_timeout` at connect time, which PgBouncer rejects.
2. **Cloudflare token for Terraform.** Create an API token with the permission *Account > Workers R2 Storage > Edit*, then `export CLOUDFLARE_API_TOKEN=...`.
3. **Settings.** In this directory: `cp terraform.tfvars.example terraform.tfvars` and fill it in. Choose the image tag now (for example `git rev-parse --short HEAD`) and leave the two `*_access_key_id` lines commented.
4. **APIs, repository, secrets and buckets.**
   ```sh
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com
   terraform init
   terraform apply \
     -target=google_project_service.enabled \
     -target=google_artifact_registry_repository.trame \
     -target=google_secret_manager_secret.trame \
     -target=cloudflare_r2_bucket.assets \
     -target=cloudflare_r2_bucket.backups
   ```
5. **R2 tokens.** In R2 > Manage API tokens, create two tokens with *Object Read & Write*, one limited to `trame-assets` and one limited to `trame-backups`. Put their Access Key IDs in `terraform.tfvars` (`s3_access_key_id`, `backup_s3_access_key_id`). Separate tokens mean a compromised server cannot delete the backups.
6. **Secret values.** Each command reads the value from your terminal (paste, Enter, Ctrl-D) or from `openssl`, so it never lands in your shell history:
   ```sh
   gcloud secrets versions add trame-database-url --data-file=-                 # Neon direct URL
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add trame-master-encryption-key --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add trame-jwt-secret --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add trame-invite-jwt-secret --data-file=-
   gcloud secrets versions add trame-s3-secret-access-key --data-file=-         # assets token secret
   gcloud secrets versions add trame-backup-s3-secret-access-key --data-file=-  # backups token secret
   ```
   When pasting, end the value with Ctrl-D twice instead of Enter so no newline is stored.
7. **Images.** Cloud Run runs `linux/amd64`. Build without attestations so each release is one version in the repository:
   ```sh
   REPO=europe-west9-docker.pkg.dev/<project>/trame
   TAG=<server_image_tag from terraform.tfvars>
   gcloud auth configure-docker europe-west9-docker.pkg.dev
   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
     -t "$REPO/trame-server:$TAG" --push ../..
   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
     -t "$REPO/trame-ops:$TAG" --push ../compose/ops
   ```
   The server image compiles Rust and WebAssembly and needs several GB of RAM.

## First start

```sh
terraform apply
terraform output -raw public_origin
```

Deploying starts one instance to check it, and while no Owner exists every start logs a single-use setup URL valid for 1 hour. Print it with:

```sh
eval "$(terraform output -raw owner_bootstrap_url_command)"
```

If nothing is printed, or the link expired, open the public URL once to start a new instance and run the command again. Open the link and create the Owner account. Share only `public_origin` with players: the service's other `run.app` address fails the WebSocket origin check.

Then run a backup once to check the job and the R2 token: `eval "$(terraform output -raw backup_now_command)"`.

## Updates

Deploy between game sessions. An open WebSocket keeps the previous instance alive for up to an hour next to the new one, and two instances would serve the same table with diverging state.

1. Back up first: `eval "$(terraform output -raw backup_now_command)"`.
2. Build and push the images with a new tag (bootstrap step 7), then set `server_image_tag` (and `ops_image_tag` if `deploy/compose/ops` changed) in `terraform.tfvars`.
3. `terraform apply`. Database migrations run when the new instance starts.

To roll back, set the previous tag and apply. If the new version migrated the database, also restore the backup from step 1. The cleanup policy keeps the 3 newest versions of each image (`artifact_keep_versions`).

## Secret rotation

Secret Manager bills every active version (enabled or disabled) above 6 per billing account, and this setup uses 6. Rotate one secret at a time and destroy the old version right away:

1. Add the new value: `gcloud secrets versions add <secret> --data-file=-`. Note the version number it prints.
2. Pin it in `terraform.tfvars`, for example `secret_versions = { TRAME_JWT_SECRET = "2" }`, and run `terraform apply`. This rolls out a new revision that reads it. Keys are environment variable names; `DATABASE_URL` is shared by the server and the backup job.
3. Destroy the previous version: `gcloud secrets versions destroy 1 --secret=<secret>`. Disabling is not enough to stop the billing.

What each rotation does:

- `trame-database-url`: reset the role password in Neon first. The server cannot reach the database until step 2, so rotate between sessions.
- `trame-master-encryption-key`: do not rotate. It encrypts stored TOTP secrets, and every enrolled user would have to enrol again.
- `trame-jwt-secret`: asset links signed in the last 5 minutes stop working.
- `trame-invite-jwt-secret`: no visible effect.
- R2 token secrets: create a new token, set its Access Key ID variable and pin its secret in the same apply, then delete the old token in the dashboard.

## Backups and restore

- `trame-backup` runs every night at 03:00 UTC (`backup_schedule`). It dumps Neon with `pg_dump`, checks the archive, uploads `trame-<database>-<UTC time>.dump` to `trame-backups/trame/postgres/`, and deletes dumps older than 14 days. An R2 lifecycle rule deletes them too, in case pruning fails.
- It runs the same image and scripts as the Compose `backup` service ([`deploy/compose/ops`](../compose/ops)), reading `DATABASE_URL` instead of the `PG*` variables.
- Check recent runs: `gcloud run jobs executions list --job=trame-backup --region=europe-west9 --limit=5`. A failed run is retried once, then shows as failed.
- Neon keeps 6 hours of history on the free plan. For a mistake made in the last few hours, Neon's instant restore (console, Restore) is faster than a dump.
- **Assets are not in the dumps.** The assets bucket only gets new, content-addressed keys and has no expiry rule. Copy it elsewhere yourself if you need a second copy.

Restore a dump into Neon. The restore drops and recreates the database, and refuses while another session uses it:

```sh
# 1. List the dumps (they appear in the job's logs).
eval "$(terraform output -raw restore_list_command)"
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="trame-backup"' \
  --freshness=10m --format='value(textPayload)'
# 2. Stop the server. Open WebSockets finish first, so do this when nobody is playing.
gcloud run services update trame-server --region=europe-west9 --scaling=0
# 3. Restore.
gcloud run jobs execute trame-backup --region=europe-west9 --wait \
  --args=restore.sh,trame-neondb-20261107T030000Z.dump
# 4. Start the server again, then check that Terraform sees no difference.
gcloud run services update trame-server --region=europe-west9 --scaling=auto
terraform plan
```

If step 3 reports other sessions, a player is still connected: wait (at most an hour) and run it again. The Neon role must own the database (the default `neondb_owner` owns `neondb`).

## Remote state (optional)

State is local (`terraform.tfstate`, git-ignored). It holds no secret values, but losing it means importing every resource again. To keep it in Cloud Storage:

```sh
gcloud storage buckets create gs://<project>-tfstate --location=europe-west9 --uniform-bucket-level-access
gcloud storage buckets update gs://<project>-tfstate --versioning
cat > backend.tf <<'EOF'
terraform {
  backend "gcs" {
    bucket = "<project>-tfstate"
    prefix = "trame"
  }
}
EOF
terraform init -migrate-state
```

A few kilobytes of state cost a fraction of a cent a month. `make lint-terraform` ignores the backend (`-backend=false`).

## Costs and free-tier limits

Free tiers are per billing account and reset every month (checked 2026-11-07).

| Service | Free each month | What uses it |
| :--- | :--- | :--- |
| Cloud Run (request-based billing) | 180,000 vCPU-s, 360,000 GiB-s, 2 million requests | Billed only while a request or WebSocket is open: about 50 hours at 1 vCPU. Then about 0.09 USD per hour. |
| Cloud Run jobs | 240,000 vCPU-s, 450,000 GiB-s | The nightly dump takes seconds. |
| Network egress (Europe) | None | About 0.105 USD/GiB from the first byte: the web client, API responses and WebSocket frames (compressed). Map images come from R2, not Cloud Run. |
| Secret Manager | 6 active versions, 10,000 accesses | 6 secrets; each instance start reads 5. |
| Artifact Registry | 0.5 GB storage | 3 versions of each image. |
| Cloud Scheduler | 3 jobs | 1 job. |
| Neon (free plan) | 100 CU-hours, 1 GB storage, 5 GB transfer per project | Active while the server holds connections, plus 5 minutes. The nightly dump counts against transfer. |
| R2 | 10 GB-month, 1 million writes, 10 million reads, free egress | Assets and 14 dumps. |

Example: four 4-hour sessions a month with 5 players use about 16 hours of Cloud Run time, inside the free tier. What remains is egress, usually a few hundred MB, so a few cents. The budget alert only notifies, it never stops anything. To stop all costs at once, run `gcloud run services update trame-server --region=europe-west9 --scaling=0`.

## Risks and limits

- **Cold starts.** After about 15 idle minutes the instance stops. The next visitor waits for the image pull, Neon waking up (Neon suspends after 5 idle minutes and this cannot be turned off on the free plan) and migrations, typically a few seconds. The startup probe allows 120 seconds.
- **WebSockets end after 60 minutes.** That is the request timeout, Cloud Run's maximum. The client reconnects on its own. A restart (deploy, crash, Cloud Run maintenance) also drops sockets and loses the in-memory undo history.
- **One instance only (`max-instances = 1`).** Each table's room actor, with its live state and WAL writer, lives in one process. A second instance would run a second actor for the same table, so the cap is part of correctness, not just cost. Capacity is one 1-vCPU instance and 200 simultaneous requests or sockets.
- **CPU only during requests.** With request-based billing, work outside requests is throttled, for example the background copy of old PostgreSQL assets to R2. It resumes during the next session.
- **Neon quotas.** When a project runs out of CU-hours or transfer, Neon suspends it until next month: `/healthz` fails and TRAME is down. Watch usage in the Neon console.
- **Custom domains.** Cloud Run domain mapping is not offered in `europe-west9`, and a global load balancer costs far more than this target's budget, so this setup uses the `run.app` URL. If you put another proxy in front, set `public_origin` and add one to `trusted_proxy_hops`.
- **Client IP.** Cloud Run's front end appends the address it received the connection from to `X-Forwarded-For`, after anything the client sent. The container itself only sees an internal peer address. `TRAME_TRUSTED_PROXY_HOPS = 1` therefore keys rate limits on the rightmost entry, which a client cannot forge. Cloud Run's documentation does not describe the header; this behavior comes from public reports and has not been checked on a live deployment of this configuration.
- **Not tested against real accounts.** `make lint-terraform` checks formatting, schema validity and lint rules. Nothing here has been applied to a real project; review the first `terraform plan` carefully.

## Tear down

The R2 buckets carry `prevent_destroy`, so `terraform destroy` stops before deleting data. To delete everything, first export what you need, then remove the `prevent_destroy` lines in `r2.tf` (buckets must also be empty), and run `terraform destroy`. Delete the Neon project in its console.

## Checks

From the repository root, `make lint-terraform` runs `terraform fmt -check`, `terraform init -backend=false` with the committed lock file, `terraform validate` and `tflint` (Google ruleset) in digest-pinned containers. `make lint` and CI include it.
