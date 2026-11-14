#!/bin/sh
# ============================================================================
# PRODUCTION COMPOSE SMOKE TEST (run-smoke.sh), behind `make deploy-compose-smoke`
# ============================================================================
#
# PURPOSE:
# --------
# Proves on one machine that the production Compose stack works end to end
# (track I-A): Caddy edge (internal CA on `localhost`), WebSocket with the
# deflate subprotocol, Silo presigned downloads with CORS, and a backup that
# survives losing the database volume. CI can run the same target.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Throwaway Stack`:
#      - Its own Compose project (`SMOKE_PROJECT`), test-only secrets
#        (`smoke.env`), Caddy bound to 127.0.0.1 on high ports. An EXIT trap
#        always runs `down -v --remove-orphans`, so no container, volume or
#        network survives a pass or a failure.
#   2. `Production Image`:
#      - Uses `TRAME_IMAGE` (default `trame-server:e2e`, from `make e2e-image`)
#        and refuses to start when it is missing instead of building it.
#   3. `Real Disaster Drill`:
#      - The restore runs after the PostgreSQL volume, the local dump file, AND
#        every object in the `trame-assets` bucket were deleted, so both the
#        database dump and the map asset must come back from `trame-backups`.
#   4. `No Argv Credentials`:
#      - Samples `/proc/[0-9]*/cmdline` during `backup.sh now` and `restore.sh`
#        and asserts that neither `POSTGRES_PASSWORD` nor S3 secret keys appear
#        on any process command line.
#
# EXECUTION LIFECYCLE:
# --------------------
#   1. `docker compose config` (base, tunnel override) + `caddy validate` (both Caddyfiles).
#   2. `up --build --wait` with `--profile silo`; create `trame-backups` on Silo.
#   3. `smoke.py seed` (owner setup URL from the logs, Caddy root CA copied out;
#      asserts HSTS and the private download headers through Caddy).
#   4. `backup.sh now`; dump + mirrored asset present in `trame-backups`, zero argv secrets.
#   5. Stop the server, delete the database volume, local dump, and `trame-assets` objects.
#   6. `restore.sh <dump>` (downloads dump + restores mirrored assets), start the server.
#   7. `smoke.py verify` (campaign/session + presigned WebP download); no new setup URL logged.
# ============================================================================
set -eu

COMPOSE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
SMOKE_PROJECT=${SMOKE_PROJECT:-trame-deploy-smoke}
TRAME_IMAGE=${TRAME_IMAGE:-trame-server:e2e}
SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-300}
PYTHON_IMAGE=python:3.15-alpine@sha256:a0f2e268f2ce8f3709611a90054ec6a8ae31f6251f5896b8648b9bb99835e30a
ENV_FILE="$COMPOSE_DIR/smoke/smoke.env"
export TRAME_IMAGE

dc() {
	docker compose --project-name "$SMOKE_PROJECT" --project-directory "$COMPOSE_DIR" \
		--env-file "$ENV_FILE" --profile silo -f "$COMPOSE_DIR/docker-compose.prod.yml" "$@"
}

step() {
	printf '\n==> %s\n' "$*"
}

# `assert NAME COMMAND...`: prints PASS, or FAIL and exits.
assert() {
	name=$1
	shift
	if "$@"; then
		echo "PASS $name"
	else
		echo "FAIL $name" >&2
		exit 1
	fi
}

origin=$(sed -n 's/^TRAME_PUBLIC_ORIGIN=//p' "$ENV_FILE")
work=$(mktemp -d)
chmod 0777 "$work"

cleanup() {
	rc=$?
	if [ "$rc" -ne 0 ]; then
		dc logs --no-color --tail 80 >&2 || true
	fi
	dc down -v --remove-orphans >/dev/null 2>&1 || true
	rm -rf "$work"
	if [ "$rc" -eq 0 ]; then echo "deploy-compose-smoke: PASS"; else echo "deploy-compose-smoke: FAIL" >&2; fi
	exit "$rc"
}
trap cleanup EXIT INT TERM

smoke_client() {
	docker run --rm --network host --memory 256m --read-only \
		-v "$COMPOSE_DIR/smoke:/smoke:ro" -v "$work:/work" \
		-e SMOKE_ORIGIN="$origin" -e SMOKE_SETUP_URL="${setup_url:-}" \
		"$PYTHON_IMAGE" python /smoke/smoke.py "$1"
}

setup_urls() {
	dc logs --no-color --no-log-prefix trame-server |
		sed -n 's/.*"event":"owner_bootstrap_url".*"setup_url":"\([^"]*\)".*/\1/p'
}

# Executes an ops command inside `backup` while sampling `/proc/[0-9]*/cmdline`
# and asserting that `POSTGRES_PASSWORD` (`PGPASSWORD`), `S3_SECRET_ACCESS_KEY`,
# and `BACKUP_S3_SECRET_ACCESS_KEY` never appear on any process command line.
exec_backup_checked() {
	dc exec -T backup sh -c '
		samples=/tmp/smoke-cmdlines.$$
		(umask 077 && : >"$samples")
		"$@" &
		cmd_pid=$!
		while kill -0 "$cmd_pid" 2>/dev/null; do
			cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\000" "\n" >>"$samples" || true
			sleep 0.01
		done
		rc=0
		wait "$cmd_pid" || rc=$?
		cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\000" "\n" >>"$samples" || true
		chk=0
		awk '\''
			BEGIN {
				if (ENVIRON["PGPASSWORD"] == "" || ENVIRON["S3_SECRET_ACCESS_KEY"] == "" || ENVIRON["BACKUP_S3_SECRET_ACCESS_KEY"] == "") {
					print "expected secret env vars missing in backup container" > "/dev/stderr"
					exit 2
				}
				secrets[1] = ENVIRON["PGPASSWORD"]
				secrets[2] = ENVIRON["S3_SECRET_ACCESS_KEY"]
				secrets[3] = ENVIRON["BACKUP_S3_SECRET_ACCESS_KEY"]
			}
			{
				lines++
				for (i = 1; i <= 3; i++) {
					if (index($0, secrets[i]) > 0) {
						print "secret #" i " leaked in /proc/*/cmdline" > "/dev/stderr"
						exit 1
					}
				}
			}
			END {
				if (lines == 0) {
					print "no /proc/*/cmdline entries sampled" > "/dev/stderr"
					exit 2
				}
			}
		'\'' "$samples" || chk=$?
		rm -f "$samples"
		[ "$rc" -eq 0 ] && [ "$chk" -eq 0 ]
	' sh "$@"
}

docker image inspect "$TRAME_IMAGE" >/dev/null 2>&1 || {
	echo "deploy-compose-smoke: image $TRAME_IMAGE not found; run 'make e2e-image' first" >&2
	exit 1
}

step "static checks: compose config and Caddyfiles"
dc config -q
CLOUDFLARE_TUNNEL_TOKEN=smoke-placeholder dc -f "$COMPOSE_DIR/docker-compose.tunnel.yml" config -q
for caddyfile in Caddyfile Caddyfile.tunnel; do
	assert "caddy validate $caddyfile" dc run --rm --no-deps caddy \
		caddy validate --config "/etc/caddy/$caddyfile" --adapter caddyfile
done

step "starting the stack (caddy, trame-server, postgres, silo, storage-init, backup)"
dc up -d --build --wait --wait-timeout "$SMOKE_TIMEOUT"
dc exec -T backup sh -c '. /usr/local/bin/ops-common.sh && write_mc_config && mc mb --ignore-existing "backup/$BACKUP_S3_BUCKET"' >/dev/null
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/caddy-root.crt"
setup_url=$(setup_urls | tail -n 1)
assert "owner setup URL logged at first start" test -n "$setup_url"

step "seed: health, compression, owner, campaign, asset, WebSocket"
smoke_client seed

step "backup now"
assert "backup.sh now runs without secrets in /proc/*/cmdline" exec_backup_checked backup.sh now
dump=$(dc exec -T backup sh -c 'cd /backups && ls -1t -- trame-*.dump | head -n 1')
assert "dump written to /backups" test -n "$dump"
listed=$(dc exec -T backup restore.sh list | grep -c "$dump" || true)
assert "dump $dump listed locally and in the bucket" test "$listed" -eq 2
mirrored_assets=$(dc exec -T backup sh -c '. /usr/local/bin/ops-common.sh && write_mc_config && mc ls --recursive "$(remote_assets_prefix)/" | wc -l')
assert "asset bucket mirrored to trame-backups" test "$mirrored_assets" -ge 1

step "disaster: delete the database volume, local dump, and asset bucket objects"
dc stop trame-server
dc rm -f -s postgres
docker volume rm "${SMOKE_PROJECT}_postgres_prod_data" >/dev/null
dc exec -T backup rm "/backups/$dump"
dc exec -T backup sh -c '. /usr/local/bin/ops-common.sh && write_mc_config && mc rm --recursive --force "store/$S3_BUCKET/"' >/dev/null
remaining_assets=$(dc exec -T backup sh -c '. /usr/local/bin/ops-common.sh && write_mc_config && mc ls --recursive "store/$S3_BUCKET/" | wc -l')
assert "asset bucket wiped on Silo" test "$remaining_assets" -eq 0
dc up -d --wait --wait-timeout "$SMOKE_TIMEOUT" postgres

step "restore $dump and mirrored assets from the bucket"
assert "restore.sh runs without secrets in /proc/*/cmdline" exec_backup_checked restore.sh "$dump"
# `--no-recreate` restarts the same container, so its log still holds the first boot.
dc up -d --no-deps --no-recreate --wait --wait-timeout "$SMOKE_TIMEOUT" trame-server

step "verify: restored state served through caddy"
smoke_client verify
assert "restored instance keeps its Owner (no new setup URL logged)" test "$(setup_urls | wc -l)" -eq 1
