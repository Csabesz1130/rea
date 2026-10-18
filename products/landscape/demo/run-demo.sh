#!/usr/bin/env bash
# Map product categories with Landscape.
#   run-demo.sh [fixtures|mcp|history|all]   (default: all)
# fixtures maps the checked-in example products offline, with one marked as
# yours. mcp downloads five public terminal MCP servers from npm and maps
# them (about two and a half minutes; the largest takes most of it).
# history downloads six ai-renamer releases and shows how its traits
# changed. All need a built REA checkout (npm run build:cached); mcp and
# history also need npm and tar.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${LANDSCAPE_DEMO_DIR:-${TMPDIR:-/tmp}/landscape-demo}"
which="${1:-all}"
cli="$here/../bin/landscape.mjs"
fixtures="$here/../test/fixtures"

case "$which" in fixtures | mcp | history | all) ;; *)
  echo "Usage: $0 [fixtures|mcp|history|all]" >&2
  exit 1
  ;;
esac

category() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sets[process.argv[2]].category)' \
    "$here/packages.json" "$1"
}

# Downloads one demo set and reads its unpacked package directories into
# `packages`; a failed download stops the demo.
fetch_set() {
  local list="$work/$1-packages.txt" line
  mkdir -p "$work"
  node "$here/fetch.mjs" "$1" --work "$work" >"$list"
  packages=()
  while IFS= read -r line; do packages+=("$line"); done <"$list"
}

show() {
  local name=$1 status=$2
  echo
  echo "Exit status $status. Open $work/$name/report.html${3:+ and $work/$name/brief.md}"
  echo
}

if [[ "$which" == fixtures || "$which" == all ]]; then
  status=0
  node "$cli" map "$fixtures/notes-a" "$fixtures/notes-b" "$fixtures/notes-c" \
    --ours "$fixtures/notes-ours" --category "AI commit helpers" \
    --out "$work/fixtures" || status=$?
  show fixtures "$status" brief
fi

if [[ "$which" == mcp || "$which" == all ]]; then
  echo "Downloading the terminal MCP servers from npm:"
  fetch_set mcp
  status=0
  node "$cli" map "${packages[@]}" --category "$(category mcp)" \
    --out "$work/mcp" || status=$?
  show mcp "$status" brief
fi

if [[ "$which" == history || "$which" == all ]]; then
  echo "Downloading ai-renamer releases from npm:"
  fetch_set history
  status=0
  node "$cli" history "${packages[@]}" --category "$(category history)" \
    --out "$work/history" || status=$?
  show history "$status"
fi
