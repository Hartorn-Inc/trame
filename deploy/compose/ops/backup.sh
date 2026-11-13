#!/bin/sh
# ============================================================================
# NIGHTLY POSTGRESQL BACKUP (backup.sh)
# ============================================================================
#
# PURPOSE:
# --------
# Without it a dead disk or a bad deploy loses every campaign (SEC18, D21).
# Writes a `pg_dump` custom-format archive of the TRAME database, keeps
# `BACKUP_RETENTION_DAYS` (14) days of them in `BACKUP_DIR`, copies each
# dump to an S3-compatible bucket (Cloudflare R2 or a separate Silo bucket)
# when `BACKUP_S3_*` is set, and mirrors the S3 asset bucket (`S3_BUCKET`)
# into `<BACKUP_S3_BUCKET>/<BACKUP_S3_ASSETS_PREFIX>` when both stores are
# configured and distinct.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `No Half-Written Dumps`:
#      - The dump is written to a hidden `.partial` file, its table of
#        contents is read back with `pg_restore --list`, and only then is it
#        renamed to `trame-{db}-{UTC stamp}.dump`. Retention and `restore.sh`
#        only ever see complete archives.
#   2. `Bounded Disk Use`:
#      - Local dumps older than `BACKUP_RETENTION_DAYS` days are deleted after
#        each successful run; the same age limit prunes the dump prefix.
#   3. `Visible Failures`:
#      - A failed run creates `/tmp/backup-failed`, which turns the container
#        healthcheck unhealthy until the next successful run. The schedule
#        loop keeps running.
#   4. `Append-Only Asset Mirroring`:
#      - When both `S3_*` and `BACKUP_S3_*` point to distinct `(endpoint, bucket)`
#        pairs, `mc mirror --overwrite --quiet` copies objects from
#        `store/$S3_BUCKET/` to `backup/$BACKUP_S3_BUCKET/$BACKUP_S3_ASSETS_PREFIX/`
#        without `--remove`, preserving immutable content-addressed blobs
#        referenced by older dumps. Skipped cleanly when `S3_*` or `BACKUP_S3_*`
#        is unset (Postgres-only Compose, `make e2e` local backup, or the Cloud
#        Run job where assets already live in R2) or when both point to the
#        same bucket. Never calls `mc mb` on `BACKUP_S3_BUCKET` so bucket-scoped
#        R2 Object Read & Write tokens succeed.
#   5. `Zero Secrets On Process Argv`:
#      - `ops-common.sh` parses `DATABASE_URL` into exported `PG*` variables
#        (then unsets `DATABASE_URL`) and writes `$MC_CONFIG_DIR/config.json`
#        (`0600` on tmpfs) so neither database passwords nor S3 secret keys
#        appear in `/proc/<pid>/cmdline`.
#
# EXECUTION LIFECYCLE:
# --------------------
#   `backup.sh schedule` (container default)
#     └── loop: sleep until `BACKUP_TIME` (UTC) -> `backup.sh now`
#   `backup.sh now`
#     ├── 1. `pg_dump --format=custom` -> `.partial` -> `pg_restore --list`.
#     ├── 2. Rename into place, prune local dumps past retention.
#     ├── 3. With `BACKUP_S3_*`: `mc cp` dump to the bucket, prune dump prefix.
#     └── 4. With distinct `S3_*` + `BACKUP_S3_*`: `mc mirror` assets to the bucket.
#
# ENVIRONMENT:
# ------------
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   libpq connection (set by Compose).
#   DATABASE_URL            `postgresql://user:password@host[:port]/db[?params]`;
#                           when set it is parsed into `PG*` variables and unset
#                           (Cloud Run job against Neon, which only receives the
#                           server's URL).
#   BACKUP_DIR              Dump directory (default `/backups`).
#   BACKUP_TIME             Daily run time, `HH:MM` UTC (default `03:00`).
#   BACKUP_RETENTION_DAYS   Days to keep dumps, locally and in the bucket (default 14).
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID,
#   BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_PREFIX (default `trame/postgres`)
#                           Off-machine dump copy; disabled while endpoint or bucket is empty.
#   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
#   BACKUP_S3_ASSETS_PREFIX (default `trame/assets`)
#                           Optional S3 asset mirror into `<BACKUP_S3_BUCKET>/<BACKUP_S3_ASSETS_PREFIX>`
#                           when both `S3_*` and `BACKUP_S3_*` are set and distinct.
# ============================================================================
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_TIME=${BACKUP_TIME:-03:00}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX:-trame/postgres}
BACKUP_S3_ASSETS_PREFIX=${BACKUP_S3_ASSETS_PREFIX:-trame/assets}
FAILED_MARKER=/tmp/backup-failed

log() {
	printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

OPS_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=ops-common.sh
. "$OPS_DIR/ops-common.sh"

# Parses `DATABASE_URL` (when set) into exported `PG*` variables and unsets it
# so `pg_dump` runs with zero connection URIs or passwords on argv.
parse_database_url
: "${PGDATABASE:?set PGDATABASE or DATABASE_URL}"

backup_now() {
	name="trame-${PGDATABASE}-$(date -u +%Y%m%dT%H%M%SZ).dump"
	partial="$BACKUP_DIR/.$name.partial"
	if ! pg_dump --format=custom --file="$partial" --dbname="$PGDATABASE"; then
		rm -f "$partial"
		log "pg_dump failed"
		return 1
	fi
	if ! pg_restore --list "$partial" >/dev/null; then
		rm -f "$partial"
		log "dump archive is unreadable"
		return 1
	fi
	mv "$partial" "$BACKUP_DIR/$name"
	log "wrote $name ($(wc -c <"$BACKUP_DIR/$name") bytes)"

	find "$BACKUP_DIR" -maxdepth 1 -name 'trame-*.dump' \
		-mmin +$((BACKUP_RETENTION_DAYS * 1440)) -print -delete |
		while read -r old; do log "pruned $old"; done

	if remote_enabled; then
		if ! write_mc_config || ! mc cp --quiet "$BACKUP_DIR/$name" "$(remote_prefix)/$name" >/dev/null; then
			log "upload of $name to the bucket failed"
			return 1
		fi
		log "uploaded $name to $(remote_prefix | cut -d/ -f2-)"
		mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" "$(remote_prefix)/" >/dev/null 2>&1 ||
			log "warning: pruning old dumps in the bucket failed"

		if assets_mirror_enabled; then
			if ! asset_entries=$(mc ls "store/$S3_BUCKET/"); then
				log "listing asset bucket $S3_BUCKET failed"
				return 1
			fi
			if [ -n "$asset_entries" ]; then
				if ! mc mirror --overwrite --quiet "store/$S3_BUCKET/" "$(remote_assets_prefix)/" >/dev/null; then
					log "mirroring assets from $S3_BUCKET to $(remote_assets_prefix | cut -d/ -f2-) failed"
					return 1
				fi
				log "mirrored assets from $S3_BUCKET to $(remote_assets_prefix | cut -d/ -f2-)"
			else
				log "asset bucket $S3_BUCKET is empty; nothing to mirror"
			fi
		fi
	fi
}

run_once() {
	if backup_now; then
		rm -f "$FAILED_MARKER"
	else
		touch "$FAILED_MARKER"
		return 1
	fi
}

# Seconds from now until the next BACKUP_TIME (UTC).
seconds_until_next_run() {
	now=$(date -u +%s)
	target=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_TIME" +%s)
	if [ "$target" -le "$now" ]; then
		target=$((target + 86400))
	fi
	echo $((target - now))
}

case "$BACKUP_TIME" in
[0-1][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
*)
	log "BACKUP_TIME must be HH:MM (UTC), got '$BACKUP_TIME'"
	exit 2
	;;
esac

case "${1:-schedule}" in
now)
	run_once
	;;
schedule)
	log "daily backups at $BACKUP_TIME UTC, kept $BACKUP_RETENTION_DAYS days$(remote_enabled && echo ', copied to the bucket' || true)$(assets_mirror_enabled && echo ', mirroring assets' || true)"
	while :; do
		wait_s=$(seconds_until_next_run)
		log "next backup in ${wait_s}s"
		sleep "$wait_s"
		run_once || log "backup failed; retrying at the next scheduled time"
	done
	;;
*)
	echo "usage: backup.sh [schedule|now]" >&2
	exit 2
	;;
esac
