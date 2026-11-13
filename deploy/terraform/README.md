# TRAME on Cloud Run + Neon + R2 (near-free)

This directory deploys TRAME on Google Cloud Run in Paris (`europe-west9`), with PostgreSQL on Neon's free plan and assets on Cloudflare R2. An idle table costs nothing and a weekly game night usually stays inside the free tiers. A card is required on the Google Cloud billing account. A monthly budget emails you at 1 EUR and 5 EUR and, at 10 EUR, unlinks the project from billing, which stops it (see [Spending cap](#spending-cap)). Pushes to `main` that pass CI are deployed by GitHub Actions without any stored key. For a setup with no card, use the Compose stack in [`deploy/compose`](../compose/README.md).

| Resource | File | Notes |
| :--- | :--- | :--- |
| Cloud Run service `trame-server` | `cloud_run.tf` | Public, 0 to 1 instance, 1 vCPU / 512 MiB, timeout 3600 s, session affinity |
| Artifact Registry repository `trame` | `artifact_registry.tf` | Keeps the 3 newest versions of each image |
| 6 Secret Manager secrets | `secrets.tf` | Values added with `gcloud`, never stored in Terraform state |
| Service accounts `trame-server`, `trame-backup`, `trame-backup-scheduler` | `cloud_run.tf`, `backup.tf` | Each one reads only its own secrets |
| Cloud Run job `trame-backup` + Cloud Scheduler job | `backup.tf` | Nightly `pg_dump` of Neon to R2, kept 14 days |
| R2 buckets `trame-assets` (CORS) and `trame-backups` (expiry) | `r2.tf` | Protected by `prevent_destroy` |
| Monthly budget, email channel, Pub/Sub topic `budget-alerts` | `budget.tf` | Emails at 1, 5 and 10 EUR of actual spend; publishes every update to the topic |
| Cloud Run function `trame-budget-cap` + source bucket | `budget_cap.tf`, `budget-cap/` | Unlinks billing when spend reaches 10 EUR |
| Workload Identity pool `trame-github` + service account `trame-deployer` | `github_deploy.tf` | Lets `.github/workflows/deploy.yml` deploy without a key |
| Neon project | (manual) | Free plan, Frankfurt |

## Before you start

- A Google Cloud project linked to a billing account. You need Owner on the project, and Billing Account Administrator or Billing Account Costs Manager on the billing account for the budget. The project must not be [locked to its billing account](https://cloud.google.com/billing/docs/how-to/secure-project-billing-account-link), or the spending cap cannot unlink it.
- The billing account's currency. Budget amounts are in that currency and must match `budget_currency` (default `EUR`); `terraform plan` stops with an error if they differ. Check it with `gcloud billing accounts describe <billing account id> --format='value(currencyCode)'`. If it is not EUR, set `budget_currency` and pick amounts in that currency.
- The `gcloud` CLI, logged in twice: `gcloud auth login` and `gcloud auth application-default login`. Then `gcloud config set project <project>` and `gcloud auth application-default set-quota-project <project>`.
- Terraform 1.17.1 (pinned in `versions.tf`). Docker with `buildx` to build the first images.
- A Neon account, and a Cloudflare account with R2 enabled.
- For continuous deployment: the `gh` CLI, logged in with admin rights on the GitHub repository.
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
7. **First images.** Terraform creates the service and the backup job with these tags; later releases are built and deployed by GitHub Actions ([Continuous deployment](#continuous-deployment)). Cloud Run runs `linux/amd64`. Build without attestations so each release is one version in the repository:
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

This is the second pass of the first apply: step 4 above created only what the secrets, tokens and images need, and this one creates everything else, including the budget, the spending cap function (its build takes a few minutes) and the GitHub deployer identity.

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

## Account recovery

- **A player forgot their password.** The Owner opens **Accounts** in the lobby and selects **Create reset link** on that account, then sends the link privately. It works once, for 24 hours, and signs the account out on every device. Creating a new link cancels the previous one.
- **Changing a password.** Any signed-in user can change their password under **Account** (current password, plus a two-factor code when it is on). Their other devices are signed out.
- **The Owner is locked out.** Cloud Run cannot run a command inside the service, so run the deployed image once on your machine against the same database. `trame-server owner-reset-link` mints the Owner's reset link, logs it, and exits without opening a port. It needs Docker, `gcloud` signed in as a project Owner, and read access to the images (`gcloud auth configure-docker europe-west9-docker.pkg.dev` once):
  ```sh
  IMAGE="$(gcloud run services describe trame-server --region=europe-west9 --format='value(spec.template.spec.containers[0].image)')"
  secret() { gcloud secrets versions access latest --secret="$1"; }
  docker run --rm \
    -e TRAME_ENV=production \
    -e TRAME_PUBLIC_ORIGIN="$(terraform output -raw public_origin)" \
    -e DATABASE_URL="$(secret trame-database-url)" \
    -e MASTER_ENCRYPTION_KEY="$(secret trame-master-encryption-key)" \
    -e TRAME_JWT_SECRET="$(secret trame-jwt-secret)" \
    -e TRAME_INVITE_JWT_SECRET="$(secret trame-invite-jwt-secret)" \
    "$IMAGE" owner-reset-link | grep owner_password_reset_url
  ```
  Open the `reset_url` value and choose a new password: one use, 24 hours, every session signed out. Two-factor authentication stays on. The `S3_*` variables are left out on purpose: the command never touches assets, and an empty set is valid.

## Continuous deployment

`.github/workflows/deploy.yml` runs after each CI run on `main`. It deploys only when CI succeeded for a push to this repository, and it builds the exact commit CI tested:

1. Build `trame-server` (root `Dockerfile`) and `trame-ops` (`deploy/compose/ops`) with the bootstrap step 7 recipe, tagged with the full commit SHA.
2. Sign in to Google Cloud as `trame-deployer` through Workload Identity Federation. No key exists: the provider only accepts GitHub tokens of `github_repository` on `github_deploy_ref` (`Hartorn-Inc/trame`, `refs/heads/main`).
3. Push both images to Artifact Registry.
4. Run the backup job and wait for it. The new server migrates the database when it starts, so this dump is the rollback point.
5. `gcloud run jobs update --image` for `trame-backup`, then `gcloud run services update --image` for `trame-server`. The second command returns once the new revision passed its startup probe and receives the traffic.
6. Check `/healthz` on the service URL, retrying for up to 3 minutes.

Deploys never run in parallel, and a new one waits for the running one instead of cancelling it.

**Why `gcloud ... update --image` and not Terraform or the `deploy-cloudrun` action.** Terraform keeps owning every setting of the service and the job; the workflow changes only the image. Both resources ignore the image and the fields `gcloud` writes next to it (`client`, `client_version`, template annotations), so a deploy and a later `terraform apply` do not undo each other, and `server_image_tag` / `ops_image_tag` only matter when the resources are first created. The `deploy-cloudrun` action would also add labels to the service, which Terraform would then try to remove at every apply.

One-time setup, after [First start](#first-start):

```sh
# 1. Create the `production` environment. Then add yourself as a required
#    reviewer (repository Settings > Environments > production): every green
#    push to main deploys, and the approval keeps deploys out of game nights.
gh api --method PUT repos/Hartorn-Inc/trame/environments/production
# 2. Set its variables: GCP_PROJECT_ID, GCP_REGION, GCP_WIF_PROVIDER (provider name),
#    GCP_DEPLOYER_SA (deployer email), GCP_IMAGE_REPOSITORY, CLOUD_RUN_SERVICE and
#    CLOUD_RUN_BACKUP_JOB. None of them is secret.
terraform output -raw github_variables_command    # review, then:
eval "$(terraform output -raw github_variables_command)"
```

The two values the identity federation needs are also outputs on their own: `terraform output -raw workload_identity_provider` and `terraform output -raw deployer_service_account_email`. A single variable can be set by hand, for example `gh variable set GCP_WIF_PROVIDER --env production --repo Hartorn-Inc/trame --body "$(terraform output -raw workload_identity_provider)"`.

The deployer can push to the `trame` repository, update and run `trame-server` and `trame-backup`, and act as their two runtime service accounts. It has no project-wide role.

## Updates

A push to `main` that passes CI deploys itself ([Continuous deployment](#continuous-deployment)). Merge between game sessions: an open WebSocket keeps the previous instance alive for up to an hour next to the new one, and two instances would serve the same table with diverging state. Required reviewers on the `production` environment let you choose when a merged commit goes out.

To deploy by hand (for example a hotfix while GitHub Actions is down):

1. Back up first: `eval "$(terraform output -raw backup_now_command)"`.
2. Build and push the images with a new tag (bootstrap step 7).
3. `gcloud run jobs update trame-backup --region=europe-west9 --image=<repository>/trame-ops:<tag>` (only if `deploy/compose/ops` changed), then `gcloud run services update trame-server --region=europe-west9 --image=<repository>/trame-server:<tag>`. Database migrations run when the new instance starts.

Changing `server_image_tag` or `ops_image_tag` and running `terraform apply` does nothing once the resources exist: Terraform ignores the image.

To roll back, run the same `gcloud run services update --image` with the previous tag (the commit SHA of the previous deploy). If the new version migrated the database, also restore the dump taken before the deploy. The cleanup policy keeps the 3 newest versions of each image (`artifact_keep_versions`), so only the last two releases can be rolled back to without a rebuild.

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

The full procedure, including the Neon restore commands, restore drills and asset bucket protection, is in the [backup and restore runbook](../backup-and-restore.md). In short:

- `trame-backup` runs every night at 03:00 UTC (`backup_schedule`). It dumps Neon with `pg_dump`, checks the archive, uploads `trame-<database>-<UTC time>.dump` to `trame-backups/trame/postgres/`, and deletes dumps older than 14 days. An R2 lifecycle rule deletes them too, in case pruning fails.
- It runs the same image and scripts as the Compose `backup` service ([`deploy/compose/ops`](../compose/ops)), reading `DATABASE_URL` instead of the `PG*` variables.
- Check recent runs: `gcloud run jobs executions list --job=trame-backup --region=europe-west9 --limit=5`. A failed run is retried once, then shows as failed.
- Neon keeps 6 hours of history on the free plan. For a mistake made in the last few hours, Neon's instant restore (console, Restore) is faster than a dump.
- **Assets are not in the dumps.** The `trame-assets` bucket has no expiry rule and no second copy. Protect it separately.

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

Example: four 4-hour sessions a month with 5 players use about 16 hours of Cloud Run time, inside the free tier. What remains is egress, usually a few hundred MB, so a few cents. To stop the server's costs without waiting for the cap, run `gcloud run services update trame-server --region=europe-west9 --scaling=0`.

The spending cap and the deploy workflow add little: deploys build the images on GitHub's runners, not Cloud Build; the budget-cap function runs a few times a day for well under a second (Cloud Run functions free tier); Cloud Build builds the function only when `budget-cap/` changes; its image goes to the `gcf-artifacts` repository and counts toward the 0.5 GB Artifact Registry free storage; Pub/Sub and the few-kilobyte source zip cost a fraction of a cent.

## Spending cap

One monthly budget covers this project's costs after credits (free-tier usage does not count):

| Actual spend this month | What happens |
| :--- | :--- |
| 1 EUR (`budget_warning_amounts[0]`) | Email to `budget_alert_email` and the billing account administrators |
| 5 EUR (`budget_warning_amounts[1]`) | Email |
| 10 EUR (`budget_amount`) | Email, and `trame-budget-cap` unlinks the project from its billing account |

The budget also publishes its current spend to the `budget-alerts` Pub/Sub topic several times a day. For every message, the function compares `costAmount` with `budgetAmount` and unlinks billing when the cost is equal or higher. It ignores malformed messages and does nothing if billing is already off.

- **The cap is late, not exact.** Google reports costs to budgets hours after the usage, so the month can end a little above 10 EUR. What is spent between the real crossing and the next notification is still billed.
- **Unlinking billing stops the whole project.** Cloud Run, the backup job, Cloud Scheduler, Secret Manager and Artifact Registry stop: TRAME is offline and nightly backups stop. GitHub deploys fail. A Terraform state bucket in this project (see [Remote state](#remote-state-optional)) cannot be read until billing is back.
- **The data is safe.** Campaigns are in Neon and assets and dumps in R2, both billed by their own providers, so they are untouched. Google warns that resources of a project left without billing can eventually be deleted; re-link within days, not weeks.

To bring the project back:

1. Find out what spent the money (Billing > Reports, grouped by service and SKU) and fix it.
2. Raise the cap first, or wait for the next month. The spend so far still counts toward this month's budget: re-linking with spend above the cap gets the project unlinked again by the next notification. For example set `budget_amount = 20` in `terraform.tfvars` and apply only the budget (the rest of the project is not reachable yet): `terraform apply -target=google_billing_budget.trame`. If that call is refused because the project has no billing, change the amount in the console (Billing > Budgets & alerts) to the same value instead.
3. Re-link: `gcloud billing projects link <project> --billing-account=<billing account id>` (or Billing > My projects > Change billing in the console).
4. Run `terraform plan` to check that nothing went missing, apply if needed, then open `public_origin`. A cold start brings TRAME back.

To change the amounts, set `budget_amount` and `budget_warning_amounts` (each warning below the cap) and apply. Google stores thresholds as percentages of the budget; Terraform recomputes them, so the warnings stay at 1 and 5 EUR when only the cap changes.

## Risks and limits

- **Cold starts.** After about 15 idle minutes the instance stops. The next visitor waits for the image pull, Neon waking up (Neon suspends after 5 idle minutes and this cannot be turned off on the free plan) and migrations, typically a few seconds. The startup probe allows 120 seconds.
- **WebSockets end after 60 minutes.** That is the request timeout, Cloud Run's maximum. The client reconnects on its own. A restart (deploy, crash, Cloud Run maintenance) also drops sockets and loses the in-memory undo history.
- **One instance only (`max-instances = 1`).** Each table's room actor, with its live state and WAL writer, lives in one process. A second instance would run a second actor for the same table, so the cap is part of correctness, not just cost. Capacity is one 1-vCPU instance and 200 simultaneous requests or sockets.
- **CPU only during requests.** With request-based billing, work outside requests is throttled, for example the background copy of old PostgreSQL assets to R2. It resumes during the next session.
- **Neon quotas.** When a project runs out of CU-hours or transfer, Neon suspends it until next month: `/healthz` fails and TRAME is down. Watch usage in the Neon console.
- **Custom domains.** Cloud Run domain mapping is not offered in `europe-west9`, and a global load balancer costs far more than this target's budget, so this setup uses the `run.app` URL. If you put another proxy in front, set `public_origin` and add one to `trusted_proxy_hops`.
- **Client IP.** Cloud Run's front end appends the address it received the connection from to `X-Forwarded-For`, after anything the client sent. The container itself only sees an internal peer address. `TRAME_TRUSTED_PROXY_HOPS = 1` therefore keys rate limits on the rightmost entry, which a client cannot forge. Cloud Run's documentation does not describe the header; this behavior comes from public reports and has not been checked on a live deployment of this configuration.
- **Every green push to `main` deploys.** A merge during a game night restarts the server and drops the sockets. Add required reviewers to the `production` environment (recommended) so each deploy waits for an approval.
- **First function deploy.** In a project that never used Eventarc or Cloud Build, the first apply can fail on `google_cloudfunctions2_function.budget_cap` while Google creates their service agents; run `terraform apply` again after a few minutes. In projects created before 8 April 2021, also grant `roles/iam.serviceAccountTokenCreator` on the project to the Pub/Sub service agent (`service-<project number>@gcp-sa-pubsub.iam.gserviceaccount.com`), or Eventarc cannot deliver the budget messages.
- **Not tested against real accounts.** `make lint-terraform` checks formatting, schema validity and lint rules, and `make test-budget-cap` tests the cap function's decision. Nothing here, including the spending cap and the deploy workflow, has been applied to a real project or run against Google Cloud; review the first `terraform plan` carefully, and watch the first deploy. If `gcloud` reports a missing permission there, the deployer's per-resource roles were not enough for that call: grant the named role on the resource, or `roles/run.developer` on the project.

## Tear down

The R2 buckets carry `prevent_destroy`, so `terraform destroy` stops before deleting data. To delete everything, first export what you need, then remove the `prevent_destroy` lines in `r2.tf` (buckets must also be empty), and run `terraform destroy`. Delete the Neon project in its console. A destroyed Workload Identity pool and provider stay reserved for 30 days: applying again within that window fails until you undelete them (`gcloud iam workload-identity-pools undelete trame-github --location=global`, then the same for the provider) and import them.

## Checks

From the repository root, `make lint-terraform` runs `terraform fmt -check`, `terraform init -backend=false` with the committed lock file, `terraform validate` and `tflint` (Google ruleset) in digest-pinned containers. `make test-budget-cap` runs the cap function's tests in a pinned Node 24 container with no network. `make lint`, `make test` and CI include them; CI also audits `deploy.yml` with zizmor.
