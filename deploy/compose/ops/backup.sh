#!/bin/sh
# ============================================================================
# NIGHTLY POSTGRESQL BACKUP (backup.sh)
# ============================================================================
#
# PURPOSE:
# --------
# Without it a dead disk or a bad deploy loses every campaign (SEC18, D21).
# Writes a `pg_dump` custom-format archive of the TRAME database, keeps
# `BACKUP_RETENTION_DAYS` (14) days of them in `BACKUP_DIR`, and copies each
# one to an S3-compatible bucket (Cloudflare R2) when `BACKUP_S3_*` is set.
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
#        each successful run; the same age limit prunes the bucket prefix.
#   3. `Visible Failures`:
#      - A failed run creates `/tmp/backup-failed`, which turns the container
#        healthcheck unhealthy until the next successful run. The schedule
#        loop keeps running.
#   4. `Database Only`:
#      - Asset blobs in the object store are NOT dumped; the asset bucket needs
#        its own versioning or replication (see the deployment README).
#
# EXECUTION LIFECYCLE:
# --------------------
#   `backup.sh schedule` (container default)
#     └── loop: sleep until `BACKUP_TIME` (UTC) -> `backup.sh now`
#   `backup.sh now`
#     ├── 1. `pg_dump --format=custom` -> `.partial` -> `pg_restore --list`.
#     ├── 2. Rename into place, prune local dumps past retention.
#     └── 3. With `BACKUP_S3_*`: `mc cp` to the bucket, prune the prefix.
#
# ENVIRONMENT:
# ------------
#   PGHOST, PGUSER, PGPASSWORD, PGDATABASE   libpq connection (set by Compose).
#   DATABASE_URL            `postgresql://user:password@host[:port]/db[?params]`;
#                           when set it replaces the PG* variables (Cloud Run job
#                           against Neon, which only receives the server's URL).
#   BACKUP_DIR              Dump directory (default `/backups`).
#   BACKUP_TIME             Daily run time, `HH:MM` UTC (default `03:00`).
#   BACKUP_RETENTION_DAYS   Days to keep, locally and in the bucket (default 14).
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID,
#   BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_PREFIX (default `trame/postgres`)
#                           Off-machine copy; disabled while endpoint or bucket is empty.
# ============================================================================
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_TIME=${BACKUP_TIME:-03:00}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX:-trame/postgres}
FAILED_MARKER=/tmp/backup-failed

log() {
	printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# The URL's database name labels the dump files (libpq takes the rest from the URL).
# Without a `/dbname` path the label would be the user:password@host part.
if [ -n "${DATABASE_URL:-}" ]; then
	url_without_params=${DATABASE_URL%%\?*}
	case "$url_without_params" in
	*://*/?*) PGDATABASE=${url_without_params##*/} ;;
	*)
		log "DATABASE_URL must end with /<database>"
		exit 2
		;;
	esac
fi

remote_enabled() {
	[ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]
}

# Registers the `backup` mc alias (config lives in the tmpfs MC_CONFIG_DIR).
remote_login() {
	mc alias set backup "$BACKUP_S3_ENDPOINT" "${BACKUP_S3_ACCESS_KEY_ID:-}" \
		"${BACKUP_S3_SECRET_ACCESS_KEY:-}" --api S3v4 >/dev/null
}

remote_prefix() {
	prefix=${BACKUP_S3_PREFIX#/}
	printf 'backup/%s/%s' "$BACKUP_S3_BUCKET" "${prefix%/}"
}

backup_now() {
	name="trame-${PGDATABASE}-$(date -u +%Y%m%dT%H%M%SZ).dump"
	partial="$BACKUP_DIR/.$name.partial"
	if ! pg_dump --format=custom --file="$partial" ${DATABASE_URL:+"--dbname=$DATABASE_URL"}; then
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
		if ! remote_login || ! mc cp --quiet "$BACKUP_DIR/$name" "$(remote_prefix)/$name" >/dev/null; then
			log "upload of $name to the bucket failed"
			return 1
		fi
		log "uploaded $name to $(remote_prefix | cut -d/ -f2-)"
		mc rm --recursive --force --older-than "${BACKUP_RETENTION_DAYS}d" "$(remote_prefix)/" >/dev/null 2>&1 ||
			log "warning: pruning old dumps in the bucket failed"
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
	log "daily backups at $BACKUP_TIME UTC, kept $BACKUP_RETENTION_DAYS days$(remote_enabled && echo ', copied to the bucket' || true)"
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
