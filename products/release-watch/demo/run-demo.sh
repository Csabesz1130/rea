#!/usr/bin/env bash
# Build the two Acme Notes releases and review the update with Release Watch.
# Needs Linux x64, Go, curl, unzip and a built REA checkout (npm run build:cached).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${RELEASE_WATCH_DEMO_DIR:-${TMPDIR:-/tmp}/release-watch-demo}"

build_args=(--work "$work")
if [[ -n "${ELECTRON_ZIP:-}" ]]; then build_args+=(--electron-zip "$ELECTRON_ZIP"); fi
node "$here/build-releases.mjs" "${build_args[@]}"

cd "$work/releases"
status=0
node "$here/../bin/release-watch.mjs" compare \
  acme-notes-1.4.0-linux-x64 acme-notes-1.5.0-linux-x64 \
  --vendor-domain acmenotes.example --out "$work/report" || status=$?

echo
echo "Exit status $status (2 means the update is blocked)."
echo "Open $work/report/report.html"
