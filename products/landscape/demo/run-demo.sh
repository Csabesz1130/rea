#!/usr/bin/env bash
# Map product categories with Landscape.
#   run-demo.sh [fixtures|mcp|history|all|index|gemini|agents|addons]   (default: all)
# fixtures maps the checked-in example products offline, with one marked as
# yours. mcp downloads five public terminal MCP servers from npm and maps
# them (about two and a half minutes; the largest takes most of it).
# history downloads six ai-renamer releases and shows how its traits
# changed. index maps the 40 most-downloaded MCP servers on npm, the MCP
# Trust Index: about half an hour and 5.5 GB of Evidence; run it with
# NODE_OPTIONS=--max-old-space-size=8192, since with Node's default heap
# REA keeps fewer results of the largest servers. gemini follows Google's
# Gemini CLI core from its first public release to 0.64.0 (about five
# minutes). agents maps four open coding agents and addons the 21
# most-installed open add-ons for coding agents; run both with
# NODE_OPTIONS=--max-old-space-size=6144. A set's large packages are read as
# one component per source directory (packages.json names the root). all
# runs fixtures, mcp and history. All need a built REA checkout (npm run build:cached); every
# set but fixtures also needs npm and tar.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${LANDSCAPE_DEMO_DIR:-${TMPDIR:-/tmp}/landscape-demo}"
which="${1:-all}"
cli="$here/../bin/landscape.mjs"
fixtures="$here/../test/fixtures"

case "$which" in fixtures | mcp | history | all | index | gemini | agents | addons) ;; *)
  echo "Usage: $0 [fixtures|mcp|history|all|index|gemini|agents|addons]" >&2
  exit 1
  ;;
esac

# One field of a demo set in packages.json.
setting() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sets[process.argv[2]][process.argv[3]])' \
    "$here/packages.json" "$1" "$2"
}

# Downloads one demo set and reads the directories to map into `packages`:
# each unpacked package, or its split; a failed download stops the demo.
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
  node "$cli" map "${packages[@]}" --category "$(setting mcp category)" \
    --out "$work/mcp" || status=$?
  show mcp "$status" brief
fi

if [[ "$which" == history || "$which" == all ]]; then
  echo "Downloading ai-renamer releases from npm:"
  fetch_set history
  status=0
  node "$cli" history "${packages[@]}" --category "$(setting history category)" \
    --out "$work/history" || status=$?
  show history "$status"
fi

if [[ "$which" == index ]]; then
  echo "Downloading the 40 most-downloaded MCP servers from npm:"
  fetch_set index
  status=0
  node "$cli" map "${packages[@]}" --category "$(setting index category)" \
    --out "$work/index" || status=$?
  show index "$status" brief
fi

if [[ "$which" == gemini ]]; then
  echo "Downloading four Gemini CLI core releases from npm:"
  fetch_set gemini
  status=0
  node "$cli" history "${packages[@]}" --category "$(setting gemini category)" \
    --out "$work/gemini" || status=$?
  show gemini "$status"
fi

for set in agents addons; do
  if [[ "$which" == "$set" ]]; then
    echo "Downloading the $(setting "$set" category | tr '[:upper:]' '[:lower:]') from npm:"
    fetch_set "$set"
    status=0
    node "$cli" map "${packages[@]}" --category "$(setting "$set" category)" \
      --out "$work/$set" || status=$?
    show "$set" "$status" brief
  fi
done
