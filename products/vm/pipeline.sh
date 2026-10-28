#!/usr/bin/env bash
# The pipeline on one VM, as the user bootstrap.sh set up:
#   fetch  downloads the 40 most-downloaded MCP servers on npm, each checked
#          against the integrity pinned in products/landscape/demo/packages.json;
#   map    Landscape reads them with REA (the MCP Trust Index);
#   plan   Proof Swarm's plan, with REA's facts at level 0, for every server
#          whose "An MCP tool reaches process execution" cell is unknown.
# Agents take planned.json from there (products/proof-swarm/README.md).
# Nothing downloaded is run. Each step reuses the one before's output;
# costs.tsv gets one line per step run: wall, user and system CPU seconds,
# peak memory of the process family and of its largest process, exit status.
#
#   pipeline.sh [fetch|map|plan|all]   (default: all)
#
# Settings (environment):
#   WORK        output directory                     (~/rea-work)
#   JOBS        products REA analyzes at once        (2)
#   HEAP_MB     Node heap for the map and the plan   (6144)
#   BATCH_SIZE  packages per agent batch             (3)
#   CALIBRATE   npm names whose known answer is added as calibration (none)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=${WORK:-$HOME/rea-work}
JOBS=${JOBS:-2}
HEAP_MB=${HEAP_MB:-6144}
BATCH_SIZE=${BATCH_SIZE:-3}
CALIBRATE=${CALIBRATE:-}
step=${1:-all}

case "$step" in fetch | map | plan | all) ;; *)
  echo "Usage: $0 [fetch|map|plan|all]" >&2
  exit 2
  ;;
esac

version=$(tr -d ' v\n' <"$repo/.nvmrc")
node_dir=${NODE_DIR:-/opt/node-v$version}
if [[ -x "$node_dir/bin/node" ]]; then export PATH="$node_dir/bin:$PATH"; fi
if [[ "$(node --version 2>/dev/null)" != "v$version" ]]; then
  echo "pipeline: Node.js v$version is not installed in $node_dir; run bootstrap.sh" >&2
  exit 1
fi
heap="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$HEAP_MB"
mkdir -p "$WORK"
packages="$WORK/index-packages.txt"

# Runs one step, measured, with its output in <name>.log; a failing step is
# recorded and returns its status.
measured() {
  local name=$1 status=0 times
  shift
  echo "pipeline: $name"
  TIMEFORMAT="%R %U %S"
  times=$({ time node "$here/measure.mjs" "$WORK/$name.cost.json" "$@" \
    >"$WORK/$name.out" 2>"$WORK/$name.log"; } 2>&1) || status=$?
  node -e '
    const [file, name, times, status] = process.argv.slice(1);
    const cost = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const [, user, system] = times.trim().split(/\s+/);
    console.log([name, cost.wall_s, user, system, cost.peak_family_mb, cost.peak_process_mb, status].join("\t"));
  ' "$WORK/$name.cost.json" "$name" "$times" "$status" >>"$WORK/costs.tsv"
  tail -n 1 "$WORK/costs.tsv"
  return "$status"
}

if [[ ! -f "$WORK/costs.tsv" ]]; then
  printf 'step\twall_s\tuser_s\tsystem_s\tpeak_family_mb\tpeak_process_mb\texit\n' >"$WORK/costs.tsv"
fi

if [[ "$step" == fetch || "$step" == all ]]; then
  measured fetch node "$repo/products/landscape/demo/fetch.mjs" index --work "$WORK"
  cp "$WORK/fetch.out" "$packages"
fi

if [[ "$step" == map || "$step" == all ]]; then
  mapfile -t dirs <"$packages"
  category=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sets.index.category)' \
    "$repo/products/landscape/demo/packages.json")
  # Exit status 1 means REA could not analyze some product; the map is
  # still written and says which.
  NODE_OPTIONS="$heap" measured map node "$repo/products/landscape/bin/landscape.mjs" map "${dirs[@]}" \
    --category "$category" --jobs "$JOBS" --out "$WORK/map" || [[ $? == 1 ]]
fi

if [[ "$step" == plan || "$step" == all ]]; then
  calibrate=()
  for name in $CALIBRATE; do calibrate+=(--calibrate "$name"); done
  node "$here/swarm-args.mjs" "$WORK/map/report.json" "$packages" --claims "$WORK/claims" \
    --batch-size "$BATCH_SIZE" "${calibrate[@]}" >"$WORK/swarm-args.json"
  mkdir -p "$WORK/claims"
  NODE_OPTIONS="$heap" measured plan node "$repo/products/proof-swarm/bin/proof-swarm.mjs" plan "$WORK/swarm-args.json" --rea
  cp "$WORK/plan.out" "$WORK/planned.json"
  node -e '
    const planned = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const open = planned.batches.flatMap((batch) => batch.packages);
    console.log(`settled at level 0: ${planned.settled.length}${planned.settled.length ? ` (${planned.settled.map((item) => `${item.name}, ${item.sketch.basis}`).join("; ")})` : ""}`);
    console.log(`for agents: ${open.length} in ${planned.batches.length} batches`);
  ' "$WORK/planned.json"
fi

echo "pipeline: done; results in $WORK (map/report.html, planned.json, costs.tsv)"
