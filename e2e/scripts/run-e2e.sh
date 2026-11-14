#!/bin/sh
# ============================================================================
# BROWSER E2E HARNESS (run-e2e.sh), behind `make e2e`
# ============================================================================
#
# PURPOSE:
# --------
# Runs the GM + three players Playwright journey against the production image
# on the production Compose file (postgres, Silo + storage-init, backup,
# trame-server), and performs the stack operations the journey asks for while
# its browsers stay open: SIGKILL, graceful restart, `pg_dump`, and a restore
# onto a wiped database volume (spec track I-C).
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Throwaway Stack`:
#      - Its own Compose project (`E2E_PROJECT`), test-only secrets
#        (`e2e/e2e.env`), no published host port. An EXIT trap saves the
#        server and database logs, then runs `down -v --remove-orphans`.
#   2. `Closed Action List`:
#      - The journey writes `artifacts/harness/{seq}-{action}.request`
#        (`support/harness.ts`); only `sigkill`, `restart`, `backup` and
#        `restore` run, anything else is answered `failed`. Each answer is
#        written to a temporary file and renamed, so the spec never reads a
#        half-written `.done`.
#   3. `Browsers Outlive The Server`:
#      - Playwright runs in its own container on the `edge` network and
#        reaches the server through `support/forward.ts`, so killing or
#        stopping `trame-server` drops sockets, not the browsers.
#   4. `Restore Is A Real Disaster Drill`:
#      - `restore` stops the server, deletes the PostgreSQL container and its
#        volume, starts an empty PostgreSQL, runs `restore.sh` from the
#        `backup` image, and starts the same server container again.
#
# EXECUTION LIFECYCLE:
# --------------------
#   1. `up --build --wait` postgres, silo, storage-init, trame-server.
#   2. Owner setup URL from the `owner_bootstrap_url` log line.
#   3. Request loop in the background; `run --rm playwright` in the foreground.
#   4. Stop the loop, save logs, tear down, check the server logs are JSON.
# ============================================================================
set -u

REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
E2E_PROJECT=${E2E_PROJECT:-trame-e2e}
ARTIFACTS="$REPO_DIR/e2e/artifacts"
HARNESS="$ARTIFACTS/harness"
WAIT_TIMEOUT=${E2E_WAIT_TIMEOUT:-240}
export E2E_UID="${E2E_UID:-$(id -u)}" E2E_GID="${E2E_GID:-$(id -g)}"

dc() {
	docker compose --project-name "$E2E_PROJECT" --project-directory "$REPO_DIR" \
		--env-file "$REPO_DIR/e2e/e2e.env" --profile silo --profile e2e \
		-f "$REPO_DIR/deploy/compose/docker-compose.prod.yml" -f "$REPO_DIR/e2e/docker-compose.e2e.yml" "$@"
}

action_sigkill() {
	docker kill -s KILL "$(dc ps -q trame-server)" &&
		dc up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" trame-server
}

action_restart() {
	dc restart trame-server &&
		dc up -d --no-deps --wait --wait-timeout "$WAIT_TIMEOUT" trame-server
}

action_backup() {
	dc up -d --no-deps backup &&
		dc exec -T backup backup.sh now &&
		dc exec -T backup sh -c 'cd /backups && ls -1t -- trame-*.dump | head -n 1' >"$HARNESS/dump-name" &&
		test -s "$HARNESS/dump-name" &&
		echo "dump $(cat "$HARNESS/dump-name")"
}

action_restore() {
	dump=$(cat "$HARNESS/dump-name") &&
		dc stop trame-server &&
		dc rm -f -s postgres &&
		docker volume rm "${E2E_PROJECT}_postgres_prod_data" &&
		dc up -d --wait --wait-timeout "$WAIT_TIMEOUT" postgres &&
		dc exec -T backup restore.sh "$dump" &&
		dc up -d --no-deps --no-recreate --wait --wait-timeout "$WAIT_TIMEOUT" trame-server
}

harness_loop() {
	while :; do
		for request in "$HARNESS"/*.request; do
			[ -e "$request" ] || continue
			name=${request##*/}
			name=${name%.request}
			action=${name#*-}
			echo "e2e harness: $action" >&2
			case "$action" in
			sigkill | restart | backup | restore)
				if "action_$action" >"$HARNESS/$name.log" 2>&1; then status=ok; else status=failed; fi
				;;
			*)
				echo "unknown action '$action'" >"$HARNESS/$name.log"
				status=failed
				;;
			esac
			echo "e2e harness: $action $status" >&2
			echo "$status" >"$HARNESS/.$name.tmp" && mv "$HARNESS/.$name.tmp" "$HARNESS/$name.done"
			rm -f "$request"
		done
		sleep 1
	done
}

loop_pid=
cleanup() {
	rc=$?
	[ -n "$loop_pid" ] && kill "$loop_pid" 2>/dev/null
	dc logs --no-color --no-log-prefix trame-server >"$ARTIFACTS/server.log" 2>&1
	dc logs --no-color --no-log-prefix postgres >"$ARTIFACTS/postgres.log" 2>&1
	dc down -v --remove-orphans >/dev/null 2>&1
	sh "$REPO_DIR/e2e/scripts/check-json-logs.sh" "$ARTIFACTS" || rc=1
	exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$ARTIFACTS"
rm -rf "$HARNESS"
mkdir -p "$HARNESS"

dc up -d --build --wait --wait-timeout "$WAIT_TIMEOUT" postgres silo storage-init trame-server || exit 1
setup_url=$(dc logs --no-color --no-log-prefix trame-server |
	sed -n 's/.*"event":"owner_bootstrap_url".*"setup_url":"\([^"]*\)".*/\1/p' | tail -n 1)
[ -n "$setup_url" ] || {
	echo "e2e: no owner_bootstrap_url setup_url in the trame-server log" >&2
	exit 1
}

harness_loop &
loop_pid=$!
dc run --rm -e E2E_SETUP_URL="$setup_url" playwright
