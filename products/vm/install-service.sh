#!/usr/bin/env bash
# Installs Release Feed as a service on a machine bootstrap.sh set up: the
# work directory /var/lib/rea-feed with a first watchlist, the settings
# file /etc/rea-release-feed.env, and the systemd service and its hourly
# timer. Run as root; run again after an update to refresh the units. It
# adds its own files only: a unit file that differs is backed up before it
# is replaced, and the watchlist and the settings are never overwritten.
#
# Settings (environment):
#   REA_USER   the user bootstrap.sh set up              (rea)
#   REA_HOME   the checkout                              (/home/$REA_USER/rea)
#   FEED_WORK  the feed's work directory                 (/var/lib/rea-feed)
#   UNIT_DIR   where systemd units go                    (/etc/systemd/system)
#   ENV_FILE   the settings file                         (/etc/rea-release-feed.env)
#   NO_START   1 installs the files without enabling the timer
set -euo pipefail

REA_USER=${REA_USER:-rea}
REA_HOME=${REA_HOME:-/home/$REA_USER/rea}
FEED_WORK=${FEED_WORK:-/var/lib/rea-feed}
UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
ENV_FILE=${ENV_FILE:-/etc/rea-release-feed.env}
service="$REA_HOME/products/vm/service"

say() { printf 'install-service: %s\n' "$*"; }
fail() {
  printf 'install-service: %s\n' "$*" >&2
  exit 1
}

[[ -x "$REA_HOME/products/vm/feed.sh" && -f "$REA_HOME/dist/cli.js" ]] ||
  fail "$REA_HOME is not a built checkout; run products/vm/bootstrap.sh first"
id -u "$REA_USER" >/dev/null 2>&1 || fail "no user $REA_USER; run products/vm/bootstrap.sh first"

# The work directory: the feed writes it, a web server may read its site.
install -d -m 755 -o "$REA_USER" -g "$REA_USER" "$FEED_WORK"
if [[ ! -e "$FEED_WORK/watchlist.json" ]]; then
  say "writing a first watchlist to $FEED_WORK/watchlist.json"
  install -m 644 -o "$REA_USER" -g "$REA_USER" \
    "$REA_HOME/products/release-feed/watchlists/mcp-top-40.json" "$FEED_WORK/watchlist.json"
fi

# The settings hold the webhook's URL: root and the service's group read them.
if [[ ! -e "$ENV_FILE" ]]; then
  say "writing settings to $ENV_FILE"
  install -m 640 -o root -g "$REA_USER" "$service/rea-release-feed.env" "$ENV_FILE"
fi

# A unit as the checkout has it, for this user, checkout and work directory.
unit() {
  sed -e "s|^User=rea$|User=$REA_USER|" -e "s|^Group=rea$|Group=$REA_USER|" \
    -e "s|/home/rea/rea/|$REA_HOME/|g" -e "s|/var/lib/rea-feed|$FEED_WORK|g" \
    -e "s|^ReadWritePaths=\(.*\) /home/rea$|ReadWritePaths=\1 $(getent passwd "$REA_USER" | cut -d: -f6)|" \
    -e "s|^EnvironmentFile=-/etc/rea-release-feed.env$|EnvironmentFile=-$ENV_FILE|" "$1"
}

mkdir -p "$UNIT_DIR"
changed=0
for name in rea-release-feed.service rea-release-feed.timer; do
  target="$UNIT_DIR/$name"
  wanted=$(unit "$service/$name")
  if [[ -f "$target" && "$(cat "$target")" == "$wanted" ]]; then continue; fi
  if [[ -f "$target" ]]; then
    cp -p "$target" "$target.backup.$(date +%Y%m%d%H%M%S)"
  fi
  say "installing $target"
  printf '%s\n' "$wanted" >"$target"
  chmod 644 "$target"
  changed=1
done

if [[ "${NO_START:-}" == 1 ]]; then
  say "installed; the timer was not enabled (NO_START=1)"
  exit 0
fi
if ((changed)); then systemctl daemon-reload; fi
systemctl enable --now rea-release-feed.timer
say "the feed runs every hour; start a run now with: systemctl start --no-block rea-release-feed.service"
say "follow it with: journalctl -u rea-release-feed.service -f"
say "the site is built under $FEED_WORK/site; settings are in $ENV_FILE"
