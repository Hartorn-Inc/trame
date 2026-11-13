#!/bin/sh
# ============================================================================
# ASSET BUCKET CORS RULE (apply-bucket-cors.sh)
# ============================================================================
#
# PURPOSE:
# --------
# The battlemap is drawn on a WebGL canvas from a presigned S3 URL loaded with
# `crossOrigin = "anonymous"`. Unless the bucket answers with
# `Access-Control-Allow-Origin` for `TRAME_PUBLIC_ORIGIN`, the browser refuses
# the texture and the map stays blank (ADR-0041). This script sets that rule.
# The Compose `storage-init` job runs it automatically for Silo; for
# Cloudflare R2 run it once by hand (`docker compose run --rm storage-init`)
# with an R2 token allowed to edit bucket settings, or paste
# `r2-cors.example.json` into the R2 dashboard instead.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Read-Only, Single-Origin Rule`:
#      - Only `GET` and `HEAD` from exactly `TRAME_PUBLIC_ORIGIN` are allowed;
#        uploads always go through `trame-server`, never from the browser.
#   2. `Idempotent`:
#      - `mc mb --ignore-existing` creates the bucket only when it is missing
#        and `mc cors set` replaces the rule, so the job can run on every
#        `docker compose up`.
#
# ENVIRONMENT:
# ------------
#   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
#                          Same values as `trame-server`.
#   TRAME_PUBLIC_ORIGIN    Allowed origin, e.g. `https://table.example.com`.
# ============================================================================
set -eu

origin=${TRAME_PUBLIC_ORIGIN%/}
case "$origin" in
http://?* | https://?*) ;;
*)
	echo "storage-init: TRAME_PUBLIC_ORIGIN must be http(s)://host[:port], got '$origin'" >&2
	exit 2
	;;
esac
: "${S3_ENDPOINT:?set S3_ENDPOINT}" "${S3_BUCKET:?set S3_BUCKET}"

mc alias set store "$S3_ENDPOINT" "${S3_ACCESS_KEY_ID:-}" "${S3_SECRET_ACCESS_KEY:-}" --api S3v4 >/dev/null

mc mb --ignore-existing "store/$S3_BUCKET"

rule=/tmp/cors.xml
cat >"$rule" <<EOF
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>$origin</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
EOF
mc cors set "store/$S3_BUCKET" "$rule"
echo "storage-init: bucket $S3_BUCKET allows GET/HEAD from $origin"
