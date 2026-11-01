#!/usr/bin/env sh
# Asserts that every non-empty line of artifacts/server.log (captured with
# `compose logs --no-log-prefix`) is a JSON object with a level and a message,
# i.e. the production image emits structured logs outside TRAME_ENV=dev.
# Usage: sh e2e/scripts/check-json-logs.sh [artifacts-dir]
set -eu
dir="$(cd "${1:-$(dirname "$0")/../artifacts}" && pwd)"
docker run --rm -v "$dir":/a -w /a mcr.microsoft.com/playwright:v1.64.1-noble node -e '
const lines = require("fs").readFileSync("server.log", "utf8").split("\n").filter((l) => l.trim());
const bad = lines.filter((l) => { try { const o = JSON.parse(l); return !o.level || !(o.fields && o.fields.message); } catch { return true; } });
console.log(`server.log: ${lines.length} lines, ${bad.length} not structured JSON`);
bad.slice(0, 5).forEach((l) => console.log(`  ${l.slice(0, 200)}`));
process.exit(lines.length > 0 && bad.length === 0 ? 0 : 1);
'
