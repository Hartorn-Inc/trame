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
#      - The restore runs after the PostgreSQL volume AND the local dump file
#        were deleted, so the dump must come back from the bucket copy.
#
# EXECUTION LIFECYCLE:
# --------------------
#   1. `docker compose config` (base, tunnel override) + `caddy validate` (both Caddyfiles).
#   2. `up --build --wait` with `--profile silo`.
#   3. `smoke.py seed` (owner setup URL from the logs, Caddy root CA copied out).
#   4. `backup.sh now`; dump present locally and in the bucket.
#   5. Stop the server, delete the database volume and the local dump.
#   6. `restore.sh <dump>` (downloads from the bucket), start the server.
#   7. `smoke.py verify`; no new owner setup URL was logged.
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
dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/caddy-root.crt"
setup_url=$(setup_urls | tail -n 1)
assert "owner setup URL logged at first start" test -n "$setup_url"

step "seed: health, compression, owner, campaign, asset, WebSocket"
smoke_client seed

step "backup now"
dc exec -T backup backup.sh now
dump=$(dc exec -T backup sh -c 'cd /backups && ls -1t -- trame-*.dump | head -n 1')
assert "dump written to /backups" test -n "$dump"
listed=$(dc exec -T backup restore.sh list | grep -c "$dump" || true)
assert "dump $dump listed locally and in the bucket" test "$listed" -eq 2

step "disaster: delete the database volume and the local dump"
dc stop trame-server
dc rm -f -s postgres
docker volume rm "${SMOKE_PROJECT}_postgres_prod_data" >/dev/null
dc exec -T backup rm "/backups/$dump"
dc up -d --wait --wait-timeout "$SMOKE_TIMEOUT" postgres

step "restore $dump from the bucket"
dc exec -T backup restore.sh "$dump"
# `--no-recreate` restarts the same container, so its log still holds the first boot.
dc up -d --no-deps --no-recreate --wait --wait-timeout "$SMOKE_TIMEOUT" trame-server

step "verify: restored state served through caddy"
smoke_client verify
assert "restored instance keeps its Owner (no new setup URL logged)" test "$(setup_urls | wc -l)" -eq 1
