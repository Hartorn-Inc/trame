# Backup and restore runbook

This runbook covers both hosting targets: the Compose stack in [`deploy/compose`](./compose/README.md) and the Cloud Run deployment in [`deploy/terraform`](./terraform/README.md). Both use the same scripts, [`backup.sh`](./compose/ops/backup.sh) and [`restore.sh`](./compose/ops/restore.sh), from the `trame-ops` image.

## What a backup contains

- **In the dump:** the whole PostgreSQL database: accounts, campaigns, actors, maps and scenes, notes, invites, the WAL, and asset metadata. When assets are stored in PostgreSQL (no `S3_*` set), the asset bytes are in the dump too.
- **Not in the dump:**
  - Asset bytes in an object store (Silo or R2). The database only holds their keys. See [Asset buckets](#asset-buckets).
  - The GM undo history. It lives in memory and is lost at every restart.
  - Secrets. Keep a copy of `MASTER_ENCRYPTION_KEY` and the other secrets in a password manager. A dump restored with a different `MASTER_ENCRYPTION_KEY` loses every stored TOTP enrolment, and those users must enrol again.

Each dump is a `pg_dump` custom-format archive named `trame-<database>-<UTC time>.dump`, for example `trame-trame-20261107T030000Z.dump`. The script writes it to a hidden partial file, reads it back with `pg_restore --list`, and only then gives it its final name, so a listed dump is always complete.

## Schedule, retention and location

| | Compose (`backup` service) | Cloud Run (`trame-backup` job) |
| :--- | :--- | :--- |
| When | Every day at `BACKUP_TIME` (default `03:00` UTC) | Every day at 03:00 UTC (`backup_schedule`, Cloud Scheduler) |
| Kept for | `BACKUP_RETENTION_DAYS` (default 14) days, on disk and in the bucket | `backup_retention_days` (default 14) days; an R2 lifecycle rule also deletes older dumps |
| Where | The `backups` volume (`/backups` in the container). With `BACKUP_S3_*` set, also `<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>/` (default prefix `trame/postgres`) | R2 bucket `trame-backups`, under `trame/postgres/` (`backup_s3_prefix`) |
| A failed run | Marks the container unhealthy (`docker compose ps`) until the next successful run | Retried once, then the execution shows as failed |
| Back up now | `docker compose exec backup backup.sh now` | `eval "$(terraform output -raw backup_now_command)"` |
| List dumps | `docker compose exec backup restore.sh list` | `eval "$(terraform output -raw restore_list_command)"`, then read the job's logs (see below) |

Run the Compose commands from `deploy/compose` and the Terraform commands from `deploy/terraform`.

**Keep a copy off the machine.** On the Compose target, a dump on the VM's disk does not survive losing the VM. Set `BACKUP_S3_*` to a bucket separate from the assets (an R2 bucket with its own token), or copy a dump out yourself with `docker compose cp backup:/backups/<file> .`. On Cloud Run, dumps go to R2, which is billed by Cloudflare and keeps working if the Google Cloud project is unlinked from billing.

Back up by hand before every update: the new server migrates the database when it starts, so the dump taken just before is the rollback point. The Cloud Run deploy workflow does this automatically.

## Restore on the Compose target

The restore drops and recreates the database, then restores the dump in one transaction (a failing archive leaves an empty database, never a partial one). It refuses while another session is connected, so stop the server first. When the dump is not in `/backups` and `BACKUP_S3_*` is set, the script downloads it from the bucket.

```sh
cd deploy/compose
docker compose exec backup restore.sh list
docker compose stop trame-server
docker compose exec backup restore.sh trame-trame-20261107T030000Z.dump
docker compose up -d --wait trame-server
```

After a lost VM, start from a new host: follow the guide's [First start](./compose/README.md#first-start) with the same `.env` (same secrets), wait for the stack to be healthy, then run the commands above. Then [verify the restore](#verify-a-restore).

## Restore on the Cloud Run target

For a mistake made in the last few hours, Neon's instant restore (Neon console, Restore) is faster than a dump: the free plan keeps 6 hours of history.

Otherwise, restore a dump into Neon. The restore drops and recreates the database and refuses while another session uses it. Run the commands from `deploy/terraform`:

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

If step 3 reports other sessions, a player is still connected: wait (at most an hour, the request timeout) and run it again. The Neon role must own the database (the default `neondb_owner` owns `neondb`).

## Verify a restore

After a real restore:

1. The server reports healthy: `docker compose ps` shows `trame-server` healthy, or `curl -fsS <public origin>/healthz` succeeds. `/healthz` checks the database connection.
2. Log in as the Owner and open a campaign: the maps, tokens, sheets and notes from the dump time are there, and map images load.
3. If the server logs a WAL quarantine, the GM sees a banner in that campaign: the room opened at its last good state.

A backup is only proven once it has been restored. Run a drill now and then, for example once a month, on a scratch database so the live one is not touched.

**Compose drill.** `restore.sh` restores into whatever `PGDATABASE` names, so point it at a scratch database next to the live one, count a few rows, and drop it:

```sh
cd deploy/compose
docker compose exec -e PGDATABASE=trame_restore_check backup restore.sh trame-trame-20261107T030000Z.dump
docker compose exec -e PGDATABASE=trame_restore_check backup \
  psql -c 'SELECT count(*) AS users FROM users' -c 'SELECT count(*) AS campaigns FROM campaigns'
docker compose exec backup dropdb trame_restore_check
```

**Drill on any machine with Docker** (for example with a dump downloaded from the R2 dashboard, bucket `trame-backups`, folder `trame/postgres/`). It restores into a throwaway PostgreSQL container, then removes it:

```sh
docker run -d --name trame-restore-check --memory 512m -e POSTGRES_PASSWORD=check postgres:18-alpine
docker cp trame-neondb-20261107T030000Z.dump trame-restore-check:/tmp/check.dump
docker exec trame-restore-check sh -c 'until pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done'
docker exec trame-restore-check pg_restore -U postgres -d postgres --no-owner --no-privileges --exit-on-error /tmp/check.dump
docker exec trame-restore-check psql -U postgres -c 'SELECT count(*) AS campaigns FROM campaigns'
docker rm -f trame-restore-check
```

The PostgreSQL version of the container must be at least the version of the server that produced the dump.

## Asset buckets

When assets live in Silo or R2, losing the bucket loses every map image and portrait, even with a perfect database dump. Give the asset bucket its own protection:

- **Never expire current objects in the asset bucket.** Its keys are content addresses referenced from PostgreSQL, and a deleted object is a lost map. Only the backup bucket expires dumps.
- **Keep a second copy.** Asset objects are never overwritten or deleted by the server, so a plain scheduled copy is enough, for example `mc mirror` to a second bucket on another provider or machine. This works with every backend.
- **Silo (Compose target):** the bucket is the `silo_data` volume. Back up that volume or mirror the bucket off the machine. Silo also supports bucket versioning (`mc version enable`): a deleted object then stays recoverable as a noncurrent version. Pair it with a lifecycle rule that expires only noncurrent versions (for example after 30 days), never current objects.
- **R2 (Cloud Run target, or Compose with R2):** R2 has no object versioning (checked 2026-11-08). Its bucket locks can forbid deletes and overwrites for a period or indefinitely; an indefinite lock on `trame-assets` fits TRAME, whose server never overwrites or deletes an asset object, but it also blocks emptying the bucket until the lock is removed. The `prevent_destroy` flag in Terraform only guards against `terraform destroy`, not against a deleted object or a lost Cloudflare account.

Restoring a dump older than the bucket's newest objects is safe: the extra objects are simply unused. Restoring a bucket older than the dump is not: maps uploaded in between have no image.
