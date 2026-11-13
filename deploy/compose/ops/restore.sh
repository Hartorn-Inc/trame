#!/bin/sh
# ============================================================================
# POSTGRESQL RESTORE FROM A BACKUP DUMP (restore.sh)
# ============================================================================
#
# PURPOSE:
# --------
# Turns a `backup.sh` archive back into the live TRAME database: after a dead
# disk (fresh volume) or a bad deploy (existing database). Run inside the
# `backup` service so it shares the PostgreSQL client and network:
#   docker compose stop trame-server
#   docker compose exec backup restore.sh trame-trame-20261107T030000Z.dump
#   docker compose start trame-server
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Server Must Be Stopped`:
#      - Refuses while any other session is connected to the target database,
#        so a running `trame-server` cannot write into a half-restored schema.
#   2. `Fresh Database`:
#      - The target database is dropped and recreated before `pg_restore`, so
#        no row from the broken state survives next to restored data.
#   3. `All Or Nothing`:
#      - `pg_restore --single-transaction --exit-on-error`: a failing archive
#        leaves an empty database and a non-zero exit, never a partial one.
#      - `--no-owner --no-privileges` assigns every object to `PGUSER`, so a
#        dump restores on a new host whose role names differ.
#   4. `Plain File Names Only`:
#      - The argument is a file name in `BACKUP_DIR` (no `/`). When it is not
#        there and `BACKUP_S3_*` is set, it is first downloaded from the bucket.
#   5. `Connection From PG* Or DATABASE_URL`:
#      - Compose sets the libpq `PG*` variables. The Cloud Run job only has
#        `DATABASE_URL` (Neon): its `/dbname` path is the target database and
#        the same URL on `/postgres` is the maintenance connection.
#
# EXECUTION LIFECYCLE:
# --------------------
#   `restore.sh list`         Local dumps, then the bucket listing.
#   `restore.sh <dump-file>`
#     ├── 1. Locate (or download) the dump; check it with `pg_restore --list`.
#     ├── 2. Refuse if other sessions use `PGDATABASE`.
#     ├── 3. `dropdb` + `createdb` (through the `postgres` maintenance DB).
#     └── 4. `pg_restore --single-transaction --exit-on-error`.
# ============================================================================
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX:-trame/postgres}

log() {
	printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# `target` is the database to restore into, `maintenance` the connection used to drop
# and recreate it: plain database names for PG*, URIs for DATABASE_URL.
if [ -n "${DATABASE_URL:-}" ]; then
	url_without_params=${DATABASE_URL%%\?*}
	case "$url_without_params" in
	*://*/?*) ;;
	*)
		log "DATABASE_URL must end with /<database>"
		exit 2
		;;
	esac
	PGDATABASE=${url_without_params##*/}
	target=$DATABASE_URL
	maintenance="${url_without_params%/*}/postgres${DATABASE_URL#"$url_without_params"}"
else
	target=$PGDATABASE
	maintenance=postgres
fi

remote_enabled() {
	[ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]
}

remote_prefix() {
	mc alias set backup "$BACKUP_S3_ENDPOINT" "${BACKUP_S3_ACCESS_KEY_ID:-}" \
		"${BACKUP_S3_SECRET_ACCESS_KEY:-}" --api S3v4 >/dev/null
	prefix=${BACKUP_S3_PREFIX#/}
	printf 'backup/%s/%s' "$BACKUP_S3_BUCKET" "${prefix%/}"
}

usage() {
	echo "usage: restore.sh list | restore.sh <dump-file-name>" >&2
	exit 2
}

[ $# -eq 1 ] || usage

if [ "$1" = list ]; then
	echo "Local dumps in $BACKUP_DIR:"
	found=false
	for file in "$BACKUP_DIR"/trame-*.dump; do
		[ -e "$file" ] || continue
		echo "  ${file##*/}"
		found=true
	done
	"$found" || echo "  (none)"
	if remote_enabled; then
		echo "Dumps in the bucket:"
		mc ls "$(remote_prefix)/"
	fi
	exit 0
fi

name=$1
case "$name" in
*/* | "" | .*) usage ;;
esac
dump="$BACKUP_DIR/$name"

if [ ! -f "$dump" ]; then
	remote_enabled || {
		log "$dump not found and no BACKUP_S3_* bucket is configured"
		exit 1
	}
	log "downloading $name from the bucket"
	mc cp --quiet "$(remote_prefix)/$name" "$dump" >/dev/null
fi

pg_restore --list "$dump" >/dev/null || {
	log "$name is not a readable pg_dump custom-format archive"
	exit 1
}

others=$(printf "SELECT count(*) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid();\n" |
	psql --no-psqlrc -At -v db="$PGDATABASE" -d "$maintenance")
if [ "$others" != 0 ]; then
	log "$others other session(s) use database $PGDATABASE; stop trame-server first (Compose: docker compose stop trame-server; Cloud Run: --scaling=0)"
	exit 1
fi

log "recreating database $PGDATABASE"
dropdb --if-exists --maintenance-db="$maintenance" "$PGDATABASE"
createdb --maintenance-db="$maintenance" "$PGDATABASE"

log "restoring $name"
pg_restore --single-transaction --exit-on-error --no-owner --no-privileges \
	--dbname="$target" "$dump"
log "restored $name into $PGDATABASE; start trame-server again"
