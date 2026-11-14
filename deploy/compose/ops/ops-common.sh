#!/bin/sh
# ============================================================================
# SHARED CREDENTIAL-SAFE OPS HELPERS (ops-common.sh)
# ============================================================================
#
# PURPOSE:
# --------
# Shared POSIX `sh` primitives sourced by `backup.sh`, `restore.sh`, and
# `apply-bucket-cors.sh` so S3 and PostgreSQL credentials never appear on any
# process command line (`/proc/<pid>/cmdline`) and S3 asset mirroring rules
# stay identical between backup and restore.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Zero Secrets On Process Argv`:
#      - Never invokes `mc alias set <name> <url> <key> <secret>` or passes
#        `--dbname=$DATABASE_URL` on a child command line.
#      - Never uses `MC_HOST_<alias>` URLs: `pgsty/mc` does not URL-unescape
#        `%2F` or `%2B` in userinfo, while raw `/` in AWS/R2 secret keys
#        breaks URL authority parsing.
#      - Instead, `write_mc_config` writes `$MC_CONFIG_DIR/config.json` on the
#        tmpfs mount (`/tmp/.mc`, mode `0600`, atomic rename) using shell
#        builtins only, escaping `\` and `"` in JSON string values.
#      - `parse_database_url` parses `postgresql://` / `postgres://` URIs in
#        pure shell into exported `PG*` variables (`PGHOST`, `PGPORT`,
#        `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, ...) and unsets
#        `DATABASE_URL` before any `libpq` binary runs.
#   2. `Never Enable Shell Trace`:
#      - `set -x` is forbidden across all ops scripts so expanded environment
#        variables never leak into container logs.
#   3. `Bucket-Scoped Token Compatibility`:
#      - `assets_mirror_enabled` activates only when both `S3_*` and
#        `BACKUP_S3_*` are configured and point to distinct `(endpoint, bucket)`
#        pairs, and callers never run `mc mb` against `BACKUP_S3_BUCKET`
#        (production R2 backup tokens only hold Object Read & Write).
# ============================================================================

# Logs an error through the caller's `log` function when available, or stderr.
# Never pass raw secret values or unredacted `DATABASE_URL` strings here.
ops_err() {
	if command -v log >/dev/null 2>&1; then
		log "$*"
	else
		printf 'ops: %s\n' "$*" >&2
	fi
}

# Escapes `\` -> `\\` and `"` -> `\"` in `$1` using pure shell parameter
# expansion (no child processes) and stores the result in `_JSON_ESCAPED`.
json_escape() {
	_je_rest=$1
	_je_s1=''
	while :; do
		case "$_je_rest" in
		*\\*)
			_je_s1="${_je_s1}${_je_rest%%\\*}\\\\"
			_je_rest=${_je_rest#*\\}
			;;
		*)
			_je_s1="${_je_s1}${_je_rest}"
			break
			;;
		esac
	done
	_je_rest=$_je_s1
	_JSON_ESCAPED=''
	while :; do
		case "$_je_rest" in
		*\"*)
			_JSON_ESCAPED="${_JSON_ESCAPED}${_je_rest%%\"*}\\\""
			_je_rest=${_je_rest#*\"}
			;;
		*)
			_JSON_ESCAPED="${_JSON_ESCAPED}${_je_rest}"
			break
			;;
		esac
	done
}

# Formats a single `"<alias>": { ... }` entry for `$MC_CONFIG_DIR/config.json`
# into `_MC_ALIAS_JSON` (`$1` = alias, `$2` = url, `$3` = access key, `$4` = secret key).
format_mc_alias_entry() {
	json_escape "$1"
	_fma_name=$_JSON_ESCAPED
	json_escape "$2"
	_fma_url=$_JSON_ESCAPED
	json_escape "$3"
	_fma_key=$_JSON_ESCAPED
	json_escape "$4"
	_fma_secret=$_JSON_ESCAPED
	_MC_ALIAS_JSON=$(printf '    "%s": {\n      "url": "%s",\n      "accessKey": "%s",\n      "secretKey": "%s",\n      "api": "S3v4",\n      "path": "auto"\n    }' \
		"$_fma_name" "$_fma_url" "$_fma_key" "$_fma_secret")
}

# Atomically writes `$MC_CONFIG_DIR/config.json` (mode `0600` under tmpfs
# `/tmp/.mc`) with `store` (`S3_*`) and/or `backup` (`BACKUP_S3_*`) aliases.
write_mc_config() {
	MC_CONFIG_DIR=${MC_CONFIG_DIR:-/tmp/.mc}
	export MC_CONFIG_DIR
	(
		umask 077
		mkdir -p "$MC_CONFIG_DIR"
		_wmc_tmp="$MC_CONFIG_DIR/.config.json.$$"
		_wmc_entries=''
		if [ -n "${S3_ENDPOINT:-}" ]; then
			format_mc_alias_entry "store" "$S3_ENDPOINT" "${S3_ACCESS_KEY_ID:-}" "${S3_SECRET_ACCESS_KEY:-}"
			_wmc_entries=$_MC_ALIAS_JSON
		fi
		if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
			format_mc_alias_entry "backup" "$BACKUP_S3_ENDPOINT" "${BACKUP_S3_ACCESS_KEY_ID:-}" "${BACKUP_S3_SECRET_ACCESS_KEY:-}"
			if [ -n "$_wmc_entries" ]; then
				_wmc_entries="${_wmc_entries},
${_MC_ALIAS_JSON}"
			else
				_wmc_entries=$_MC_ALIAS_JSON
			fi
		fi
		if [ -n "$_wmc_entries" ]; then
			printf '{\n  "version": "10",\n  "aliases": {\n%s\n  }\n}\n' "$_wmc_entries" >"$_wmc_tmp"
		else
			printf '{\n  "version": "10",\n  "aliases": {}\n}\n' >"$_wmc_tmp"
		fi
		chmod 0600 "$_wmc_tmp"
		mv -f "$_wmc_tmp" "$MC_CONFIG_DIR/config.json"
	)
}

# Percent-decodes `%XX` byte escapes in `$1` into `_URI_DECODED`.
# Preserves literal `+` per RFC 3986 and `libpq` connection URI rules.
# Rejects NUL (`%00`) bytes with return code 1.
uri_decode() {
	_ud_rest=$1
	_URI_DECODED=''
	while [ -n "$_ud_rest" ]; do
		case "$_ud_rest" in
		*%*)
			_URI_DECODED="${_URI_DECODED}${_ud_rest%%\%*}"
			_ud_rest=${_ud_rest#*%}
			case "$_ud_rest" in
			[0-9A-Fa-f][0-9A-Fa-f]*)
				_ud_hex=$(printf '%.2s' "$_ud_rest")
				_ud_val=$((0x$_ud_hex))
				if [ "$_ud_val" -eq 0 ]; then
					return 1
				fi
				_ud_oct=$(printf '%03o' "$_ud_val")
				_ud_ch=$(printf '%b' "\\0${_ud_oct}.")
				_URI_DECODED="${_URI_DECODED}${_ud_ch%.}"
				_ud_rest=${_ud_rest#??}
				;;
			*)
				_URI_DECODED="${_URI_DECODED}%"
				;;
			esac
			;;
		*)
			_URI_DECODED="${_URI_DECODED}${_ud_rest}"
			break
			;;
		esac
	done
}

# Parses `DATABASE_URL` (`postgresql://` or `postgres://`) into exported `PG*`
# environment variables and unsets `DATABASE_URL` so `pg_dump`, `pg_restore`,
# `psql`, `dropdb`, and `createdb` never receive a connection URI on argv.
parse_database_url() {
	[ -n "${DATABASE_URL:-}" ] || return 0

	case "$DATABASE_URL" in
	postgresql://* | postgres://*) ;;
	*)
		ops_err "DATABASE_URL must start with postgresql:// or postgres://"
		exit 2
		;;
	esac

	_pdu_no_query=${DATABASE_URL%%\?*}
	if [ "$_pdu_no_query" != "$DATABASE_URL" ]; then
		_pdu_query=${DATABASE_URL#*\?}
	else
		_pdu_query=''
	fi

	_pdu_rest=${_pdu_no_query#*://}
	case "$_pdu_rest" in
	*/?*)
		_pdu_auth=${_pdu_rest%%/*}
		_pdu_raw_db=${_pdu_rest#*/}
		;;
	*)
		ops_err "DATABASE_URL must end with /<database>"
		exit 2
		;;
	esac

	case "$_pdu_raw_db" in
	*/*)
		ops_err "DATABASE_URL database name must not contain '/'"
		exit 2
		;;
	esac

	unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGCHANNELBINDING

	if ! uri_decode "$_pdu_raw_db" || [ -z "$_URI_DECODED" ]; then
		ops_err "DATABASE_URL contains an invalid database name"
		exit 2
	fi
	PGDATABASE=$_URI_DECODED
	export PGDATABASE

	case "$_pdu_auth" in
	*@*)
		_pdu_userinfo=${_pdu_auth%@*}
		_pdu_hostport=${_pdu_auth##*@}
		case "$_pdu_userinfo" in
		*:*)
			_pdu_raw_user=${_pdu_userinfo%%:*}
			_pdu_raw_pass=${_pdu_userinfo#*:}
			if ! uri_decode "$_pdu_raw_user"; then
				ops_err "DATABASE_URL contains an invalid user"
				exit 2
			fi
			PGUSER=$_URI_DECODED
			export PGUSER
			if ! uri_decode "$_pdu_raw_pass"; then
				ops_err "DATABASE_URL contains an invalid password"
				exit 2
			fi
			PGPASSWORD=$_URI_DECODED
			export PGPASSWORD
			;;
		*)
			if ! uri_decode "$_pdu_userinfo"; then
				ops_err "DATABASE_URL contains an invalid user"
				exit 2
			fi
			PGUSER=$_URI_DECODED
			export PGUSER
			;;
		esac
		;;
	*)
		_pdu_hostport=$_pdu_auth
		;;
	esac

	case "$_pdu_hostport" in
	\[*\]:*)
		_pdu_raw_host=${_pdu_hostport#\[}
		_pdu_raw_host=${_pdu_raw_host%%\]:*}
		_pdu_port=${_pdu_hostport##*\]:}
		;;
	\[*\])
		_pdu_raw_host=${_pdu_hostport#\[}
		_pdu_raw_host=${_pdu_raw_host%\]}
		_pdu_port=5432
		;;
	*:*)
		_pdu_raw_host=${_pdu_hostport%%:*}
		_pdu_port=${_pdu_hostport#*:}
		;;
	*)
		_pdu_raw_host=$_pdu_hostport
		_pdu_port=5432
		;;
	esac

	if [ -z "$_pdu_raw_host" ]; then
		ops_err "DATABASE_URL must specify a host"
		exit 2
	fi
	case "$_pdu_port" in
	'' | *[!0-9]*)
		ops_err "DATABASE_URL port must be numeric"
		exit 2
		;;
	esac
	if ! uri_decode "$_pdu_raw_host" || [ -z "$_URI_DECODED" ]; then
		ops_err "DATABASE_URL contains an invalid host"
		exit 2
	fi
	PGHOST=$_URI_DECODED
	PGPORT=$_pdu_port
	export PGHOST PGPORT

	_pdu_qrest=$_pdu_query
	while [ -n "$_pdu_qrest" ]; do
		case "$_pdu_qrest" in
		*\&*)
			_pdu_pair=${_pdu_qrest%%\&*}
			_pdu_qrest=${_pdu_qrest#*\&}
			;;
		*)
			_pdu_pair=$_pdu_qrest
			_pdu_qrest=''
			;;
		esac
		[ -n "$_pdu_pair" ] || continue
		case "$_pdu_pair" in
		*=*)
			_pdu_qkey=${_pdu_pair%%=*}
			_pdu_qval=${_pdu_pair#*=}
			if ! uri_decode "$_pdu_qval"; then
				ops_err "DATABASE_URL contains an invalid query parameter"
				exit 2
			fi
			case "$_pdu_qkey" in
			sslmode)
				PGSSLMODE=$_URI_DECODED
				export PGSSLMODE
				;;
			channel_binding)
				PGCHANNELBINDING=$_URI_DECODED
				export PGCHANNELBINDING
				;;
			connect_timeout)
				PGCONNECT_TIMEOUT=$_URI_DECODED
				export PGCONNECT_TIMEOUT
				;;
			sslrootcert)
				PGSSLROOTCERT=$_URI_DECODED
				export PGSSLROOTCERT
				;;
			application_name)
				PGAPPNAME=$_URI_DECODED
				export PGAPPNAME
				;;
			options)
				PGOPTIONS=$_URI_DECODED
				export PGOPTIONS
				;;
			esac
			;;
		esac
	done

	unset DATABASE_URL
}

# Returns 0 when the primary S3 asset store (`S3_ENDPOINT` + `S3_BUCKET`) is configured.
store_enabled() {
	[ -n "${S3_ENDPOINT:-}" ] && [ -n "${S3_BUCKET:-}" ]
}

# Returns 0 when the off-machine backup bucket (`BACKUP_S3_ENDPOINT` + `BACKUP_S3_BUCKET`) is configured.
remote_enabled() {
	[ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]
}

# Returns 0 when both `S3_*` and `BACKUP_S3_*` are configured and refer to
# distinct `(endpoint, bucket)` locations so asset objects should be mirrored.
assets_mirror_enabled() {
	store_enabled && remote_enabled || return 1
	if [ "${S3_ENDPOINT%/}" = "${BACKUP_S3_ENDPOINT%/}" ] && [ "$S3_BUCKET" = "$BACKUP_S3_BUCKET" ]; then
		return 1
	fi
	return 0
}

# Prints the `mc` target path (`backup/<bucket>[/<prefix>]`) for PostgreSQL dumps.
remote_prefix() {
	_rp_prefix=${BACKUP_S3_PREFIX#/}
	_rp_prefix=${_rp_prefix%/}
	if [ -n "$_rp_prefix" ]; then
		printf 'backup/%s/%s' "$BACKUP_S3_BUCKET" "$_rp_prefix"
	else
		printf 'backup/%s' "$BACKUP_S3_BUCKET"
	fi
}

# Prints the `mc` target path (`backup/<bucket>[/<prefix>]`) for mirrored S3 assets.
remote_assets_prefix() {
	_rap_prefix=${BACKUP_S3_ASSETS_PREFIX#/}
	_rap_prefix=${_rap_prefix%/}
	if [ -n "$_rap_prefix" ]; then
		printf 'backup/%s/%s' "$BACKUP_S3_BUCKET" "$_rap_prefix"
	else
		printf 'backup/%s' "$BACKUP_S3_BUCKET"
	fi
}
