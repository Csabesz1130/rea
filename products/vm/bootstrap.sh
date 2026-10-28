#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VM, such as a Hetzner CPX32 (4 vCPU, 8 GB),
# to run REA and its products: an unprivileged user, swap, this repository
# at a branch, Node.js as .nvmrc pins it (checked against node-sha256.txt),
# the locked dependencies and REA's build, then a smoke test of REA through
# Landscape. cloud-init.yaml runs it at first boot; run it again as root to
# update the checkout and rebuild. Each step checks first, so a second run
# changes only what is out of date.
#
# Settings (environment):
#   REA_REPO    repository to clone      (https://github.com/Csabesz1130/rea.git)
#   REA_BRANCH  branch to check out      (claude/release-watch-prototype)
#   REA_USER    owner of the checkout and of every run  (rea)
#   REA_HOME    checkout directory       (/home/$REA_USER/rea)
#   NODE_ROOT   where Node.js goes, as node-v<version>  (/opt)
#   SWAP_SIZE   swap file to add when the VM has none   (4G; 0 adds none)
set -euo pipefail

REA_REPO=${REA_REPO:-https://github.com/Csabesz1130/rea.git}
REA_BRANCH=${REA_BRANCH:-claude/release-watch-prototype}
REA_USER=${REA_USER:-rea}
REA_HOME=${REA_HOME:-/home/$REA_USER/rea}
NODE_ROOT=${NODE_ROOT:-/opt}
SWAP_SIZE=${SWAP_SIZE:-4G}

say() { printf 'bootstrap: %s\n' "$*"; }
fail() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

# Runs a command as REA_USER, directly when already that user, else with
# that user's home, so git and npm read and write their own files there.
as_user() {
  if [[ "$(id -un)" == "$REA_USER" ]]; then
    "$@"
  else
    runuser -u "$REA_USER" -- env HOME="$(getent passwd "$REA_USER" | cut -d: -f6)" \
      USER="$REA_USER" LOGNAME="$REA_USER" "$@"
  fi
}

# What the steps below need that a minimal image may lack.
packages() {
  local missing=() package
  for package in git ca-certificates curl xz-utils; do
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null |
      grep -q "install ok installed" || missing+=("$package")
  done
  ((${#missing[@]} == 0)) && return
  say "installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
}

# Swap absorbs a peak above the VM's memory instead of the kernel killing
# an analysis. /etc/fstab is backed up before the one line is added.
swap() {
  [[ "$SWAP_SIZE" == 0 || -n "$(swapon --show --noheadings)" ]] && return
  say "adding a $SWAP_SIZE swap file"
  if [[ ! -e /swapfile ]]; then
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    cp -p /etc/fstab "/etc/fstab.rea-backup.$(date +%Y%m%d%H%M%S)"
    echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
}

# The user that owns the checkout, with the keys root logs in with, so the
# operator can also ssh in as that user. An existing key file is kept.
account() {
  if ! id -u "$REA_USER" >/dev/null 2>&1; then
    say "creating user $REA_USER"
    useradd --create-home --shell /bin/bash "$REA_USER"
  fi
  local home
  home=$(getent passwd "$REA_USER" | cut -d: -f6)
  if [[ -f /root/.ssh/authorized_keys && ! -e "$home/.ssh/authorized_keys" ]]; then
    install -d -m 700 -o "$REA_USER" -g "$REA_USER" "$home/.ssh"
    install -m 600 -o "$REA_USER" -g "$REA_USER" /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
  fi
}

# The checkout, cloned once and fast-forwarded after, onto REA_BRANCH when
# it names another branch; a branch that has diverged, or changes in the
# checkout, stop the bootstrap instead of being reset.
checkout() {
  if [[ -d "$REA_HOME/.git" ]]; then
    say "updating $REA_HOME"
    as_user git -C "$REA_HOME" fetch --quiet origin "$REA_BRANCH"
    if [[ "$(as_user git -C "$REA_HOME" branch --show-current)" != "$REA_BRANCH" ]]; then
      if as_user git -C "$REA_HOME" rev-parse --verify --quiet "refs/heads/$REA_BRANCH" >/dev/null; then
        as_user git -C "$REA_HOME" switch --quiet "$REA_BRANCH"
      else
        as_user git -C "$REA_HOME" switch --quiet -c "$REA_BRANCH" FETCH_HEAD
      fi
    fi
    as_user git -C "$REA_HOME" merge --quiet --ff-only FETCH_HEAD
  else
    say "cloning $REA_REPO ($REA_BRANCH) into $REA_HOME"
    as_user git clone --quiet --branch "$REA_BRANCH" --single-branch "$REA_REPO" "$REA_HOME"
  fi
}

node_version() { tr -d ' v\n' <"$REA_HOME/.nvmrc"; }
node_dir() { printf '%s/node-v%s' "$NODE_ROOT" "$(node_version)"; }

# Node.js as .nvmrc pins it, in a directory of its own: nothing else on
# the VM changes. The tarball must match node-sha256.txt, whose lines come
# from the release's signed SHASUMS256.txt.
install_node() {
  local version arch name dir expected tmp
  version=$(node_version)
  dir=$(node_dir)
  if [[ -x "$dir/bin/node" && "$("$dir/bin/node" --version)" == "v$version" ]]; then
    return
  fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) fail "no Node.js build for $(uname -m)" ;;
  esac
  name="node-v$version-linux-$arch.tar.xz"
  expected=$(awk -v name="$name" '$2 == name { print $1 }' "$REA_HOME/products/vm/node-sha256.txt")
  [[ -n "$expected" ]] ||
    fail "products/vm/node-sha256.txt has no checksum for $name; add its line from the release's signed SHASUMS256.txt"
  say "installing Node.js $version into $dir"
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/$name" "https://nodejs.org/dist/v$version/$name"
  echo "$expected  $tmp/$name" | sha256sum --check --quiet ||
    fail "$name does not match its pinned checksum"
  rm -rf "$dir.partial"
  mkdir -p "$dir.partial"
  tar -xJf "$tmp/$name" -C "$dir.partial" --strip-components=1
  rm -rf "$tmp" "$dir"
  mv "$dir.partial" "$dir"
}

# The locked dependencies, installed again only when the lockfile or
# Node.js changed since the last install (a stamp npm ci itself removes),
# and REA's build, then a smoke test: Landscape maps three small
# checked-in products with REA end to end, and exits non-zero unless REA
# analyzed every one.
build() {
  local fixtures="$REA_HOME/products/landscape/test/fixtures" out lock
  local stamp="$REA_HOME/node_modules/.bootstrap-lock"
  lock="$(sha256sum "$REA_HOME/package-lock.json" | cut -d' ' -f1) $(node_version)"
  if [[ "$(cat "$stamp" 2>/dev/null)" != "$lock" ]]; then
    say "installing locked dependencies"
    as_user env PATH="$(node_dir)/bin:$PATH" bash -c \
      'cd "$1" && npm ci --no-audit --no-fund' _ "$REA_HOME"
    as_user bash -c 'printf "%s\n" "$1" >"$2"' _ "$lock" "$stamp"
  fi
  say "building REA"
  as_user env PATH="$(node_dir)/bin:$PATH" bash -c 'cd "$1" && npm run build:cached' _ "$REA_HOME"
  say "smoke test: Landscape on three checked-in products"
  out=$(as_user mktemp -d)
  as_user env PATH="$(node_dir)/bin:$PATH" node "$REA_HOME/products/landscape/bin/landscape.mjs" \
    map "$fixtures/notes-a" "$fixtures/notes-b" "$fixtures/notes-c" --out "$out" >/dev/null
  rm -rf "$out"
}

packages
swap
account
checkout
install_node
build
say "ready: as $REA_USER, run $REA_HOME/products/vm/pipeline.sh"
