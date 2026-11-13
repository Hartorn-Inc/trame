#!/bin/sh
# ============================================================================
# POSTGRESQL RESTORE FROM A BACKUP DUMP (restore.sh)
# ============================================================================
#
# PURPOSE:
# --------
# Turns a `backup.sh` archive back into the live TRAME database — and, when
# distinct `S3_*` and `BACKUP_S3_*` buckets are configured, mirrors backed-up
# asset objects back into `S3_BUCKET` — after a dead disk (fresh volumes) or a
# bad deploy (existing database). Run inside the `backup` service so it shares
# the PostgreSQL client and network:
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
#   5. `Zero Secrets On Process Argv`:
#      - Compose sets the libpq `PG*` variables directly. The Cloud Run job
#        passes `DATABASE_URL` (Neon): `ops-common.sh` parses it into exported
#        `PG*` variables and unsets `DATABASE_URL`, so `psql`, `dropdb`,
#        `createdb`, and `pg_restore` always connect via `PG*` (`maintenance=postgres`,
#        `target=$PGDATABASE`) with zero URIs or passwords on argv. `mc` reads
#        `$MC_CONFIG_DIR/config.json` (`0600` on tmpfs).
#   6. `Mirrored Asset Recovery`:
#      - When both `S3_*` and `BACKUP_S3_*` are configured and distinct, and
#        objects exist under `backup/$BACKUP_S3_BUCKET/$BACKUP_S3_ASSETS_PREFIX/`,
#        `mc mirror --overwrite --quiet` restores them into `store/$S3_BUCKET/`
#        without `--remove`. Never runs `mc mb` against `BACKUP_S3_BUCKET`.
#
# EXECUTION LIFECYCLE:
# --------------------
#   `restore.sh list`         Local dumps, then the bucket listing.
#   `restore.sh <dump-file>`
#     ├── 1. Locate (or download) the dump; check it with `pg_restore --list`.
#     ├── 2. Refuse if other sessions use `PGDATABASE`.
#     ├── 3. `dropdb` + `createdb` (through the `postgres` maintenance DB).
#     ├── 4. `pg_restore --single-transaction --exit-on-error`.
#     └── 5. With distinct `S3_*` + `BACKUP_S3_*` and mirrored objects: `mc mirror` back into `S3_BUCKET`.
# ============================================================================
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_S3_PREFIX=${BACKUP_S3_PREFIX:-trame/postgres}
BACKUP_S3_ASSETS_PREFIX=${BACKUP_S3_ASSETS_PREFIX:-trame/assets}

log() {
	printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

OPS_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=ops-common.sh
. "$OPS_DIR/ops-common.sh"

# Parses `DATABASE_URL` (when set) into exported `PG*` variables and unsets it,
# so `target` and `maintenance` are always plain database names (zero URIs on argv).
parse_database_url
: "${PGDATABASE:?set PGDATABASE or DATABASE_URL}"
target=$PGDATABASE
maintenance=postgres

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
		write_mc_config
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
	write_mc_config
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

if assets_mirror_enabled; then
	write_mc_config
	if ! mirrored_entries=$(mc ls "$(remote_assets_prefix)/"); then
		log "checking mirrored assets in $(remote_assets_prefix | cut -d/ -f2-) failed"
		exit 1
	fi
	if [ -n "$mirrored_entries" ]; then
		log "restoring mirrored assets into $S3_BUCKET"
		mc mirror --overwrite --quiet "$(remote_assets_prefix)/" "store/$S3_BUCKET/" >/dev/null
	fi
fi

log "restored $name into $PGDATABASE; start trame-server again"
