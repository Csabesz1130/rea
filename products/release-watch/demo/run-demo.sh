#!/usr/bin/env bash
# Review the demo releases with Release Watch.
#   run-demo.sh [electron|cloud|all]   (default: all)
# electron builds the two Acme Notes desktop releases first and needs Linux
# x64, Go, curl and unzip. cloud uses the checked-in Acme Notes Cloud
# fixtures. Both need a built REA checkout (npm run build:cached).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${RELEASE_WATCH_DEMO_DIR:-${TMPDIR:-/tmp}/release-watch-demo}"
which="${1:-all}"
cli="$here/../bin/release-watch.mjs"

case "$which" in electron | cloud | all) ;; *)
  echo "Usage: $0 [electron|cloud|all]" >&2
  exit 1
  ;;
esac

review() {
  local name=$1
  shift
  local status=0
  node "$cli" compare "$@" --vendor-domain acmenotes.example --out "$work/$name" || status=$?
  echo
  echo "Exit status $status (2 means the release is blocked). Open $work/$name/report.html"
  echo
}

if [[ "$which" != cloud ]]; then
  build_args=(--work "$work")
  if [[ -n "${ELECTRON_ZIP:-}" ]]; then build_args+=(--electron-zip "$ELECTRON_ZIP"); fi
  node "$here/build-releases.mjs" "${build_args[@]}"
  review report \
    "$work/releases/acme-notes-1.4.0-linux-x64" "$work/releases/acme-notes-1.5.0-linux-x64"
fi

if [[ "$which" != electron ]]; then
  review cloud-report "$here/fixtures/acme-notes-cloud-2.3.0" "$here/fixtures/acme-notes-cloud-2.4.0"
fi
