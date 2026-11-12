#!/usr/bin/env bash
# One run of Release Feed on this machine, as the user bootstrap.sh set up:
# checks every package of the watchlist against the npm registry, compares
# each release not seen before with Release Watch, and builds the site
# again under $FEED_WORK/site. rea-release-feed.service runs it on a
# timer; run it by hand the same way. How many comparisons run at once,
# and with how much heap, follows this machine's CPUs and memory.
#
# Settings (environment; the service reads /etc/rea-release-feed.env):
#   FEED_WORK              state, reports and site      (/var/lib/rea-feed)
#   FEED_WATCHLIST         the packages to watch        ($FEED_WORK/watchlist.json)
#   FEED_SINCE             first-sight baseline day, YYYY-MM-DD   (none)
#   FEED_BASE_URL          where the site is served     (none)
#   FEED_ALERT_ON          severity that alerts         (high)
#   FEED_NO_REPORTS        1 leaves full reports out of the site  (unset)
#   FEED_MAX_EVIDENCE_GB   REA Evidence to keep         (10)
#   FEED_DEPTH             standard or deep: how much of a large release
#                          REA examines                 (standard)
#   RELEASE_FEED_WEBHOOK_URL   where alerts go          (none: no alerts)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
FEED_WORK=${FEED_WORK:-/var/lib/rea-feed}
FEED_WATCHLIST=${FEED_WATCHLIST:-$FEED_WORK/watchlist.json}

version=$(tr -d ' v\n' <"$repo/.nvmrc")
node_dir=${NODE_DIR:-/opt/node-v$version}
if [[ -x "$node_dir/bin/node" ]]; then export PATH="$node_dir/bin:$PATH"; fi
if [[ "$(node --version 2>/dev/null)" != "v$version" ]]; then
  echo "feed: Node.js v$version is not installed in $node_dir; run bootstrap.sh" >&2
  exit 1
fi
if [[ ! -f "$FEED_WATCHLIST" ]]; then
  echo "feed: no watchlist at $FEED_WATCHLIST; run install-service.sh or set FEED_WATCHLIST" >&2
  exit 1
fi

args=(run "$FEED_WATCHLIST" --work "$FEED_WORK"
  --alert-on "${FEED_ALERT_ON:-high}"
  --max-evidence-gb "${FEED_MAX_EVIDENCE_GB:-10}")
if [[ -n "${FEED_SINCE:-}" ]]; then args+=(--since "$FEED_SINCE"); fi
if [[ -n "${FEED_BASE_URL:-}" ]]; then args+=(--base-url "$FEED_BASE_URL"); fi
if [[ "${FEED_NO_REPORTS:-}" == 1 ]]; then args+=(--no-reports); fi
if [[ -n "${FEED_DEPTH:-}" ]]; then args+=(--depth "$FEED_DEPTH"); fi

exec node "$repo/products/release-feed/bin/release-feed.mjs" "${args[@]}"
