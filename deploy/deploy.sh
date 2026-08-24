#!/usr/bin/env bash
set -euo pipefail

# deploy.sh - build the PWA locally and ship it to the KithMoot box as a
# new timestamped release, then flip the `current` symlink so Caddy serves
# it. This script is never run automatically by anything in this repo or
# by an agent working on it - it deploys to a real, public box, and only a
# human runs it, on purpose, when they mean to.
#
# Usage:
#   deploy/deploy.sh [--reload-caddy] [--prune N]
#
# Env overrides (defaults match deploy/README.md):
#   DEPLOY_HOST   deploy@144.126.230.165
#   DEPLOY_KEY    ~/.ssh/id_rsa_thecryptodonkey
#   DEPLOY_ROOT   /srv/kithmoot        (releases/<ts>/, current -> one of them)
#
# What it does, in order:
#   1. npm run build                        - local, produces app/dist
#   2. mkdir -p $DEPLOY_ROOT/releases/<ts>   - remote, over ssh
#   3. rsync app/dist/ into that release dir - remote, additive; the only
#      thing --delete ever applies to is that brand-new, just-created
#      release directory, never an existing one
#   4. atomically flip $DEPLOY_ROOT/current -> releases/<ts>
#      (symlink a temp name, then rename over the real one - file_server
#      resolves the symlink per request, so there is never a moment where
#      it points at nothing)
#   5. --reload-caddy: reload Caddy on the box. Not required for the new
#      release to start serving (Caddy re-resolves the symlink on every
#      request), offered for parity with how other sites on the box are
#      redeployed.
#   6. --prune N: delete all release directories except the N most recent.
#      The only destructive thing this script can do, and it never runs
#      unless this flag is given explicitly.
#
# Idempotent: running it again with nothing changed builds and ships a new,
# identical release directory and re-flips the symlink to it - safe, if a
# little wasteful of disk, to run twice. Nothing here overwrites a previous
# release in place.

DEPLOY_HOST="${DEPLOY_HOST:-deploy@144.126.230.165}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_rsa_thecryptodonkey}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/kithmoot}"

SSH_OPTS=(-o IdentitiesOnly=yes -i "$DEPLOY_KEY")

RELOAD_CADDY=0
PRUNE_KEEP=0

usage() {
  cat <<'EOF'
Usage: deploy/deploy.sh [--reload-caddy] [--prune N]

  --reload-caddy   Reload Caddy on the remote box after the symlink flip.
  --prune N        Delete all but the N most recent release directories
                    after a successful deploy. Destructive; off by default.
  -h, --help       Show this help.

Env overrides: DEPLOY_HOST, DEPLOY_KEY, DEPLOY_ROOT (see script header).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reload-caddy)
      RELOAD_CADDY=1
      shift
      ;;
    --prune)
      [[ $# -ge 2 ]] || { echo "deploy.sh: --prune needs a number" >&2; exit 1; }
      [[ "$2" =~ ^[0-9]+$ ]] || { echo "deploy.sh: --prune wants a non-negative integer, got '$2'" >&2; exit 1; }
      PRUNE_KEEP="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "deploy.sh: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "==> building app/dist"
npm run build

if [[ ! -d app/dist ]] || [[ -z "$(ls -A app/dist 2>/dev/null)" ]]; then
  echo "deploy.sh: app/dist is missing or empty after build - refusing to deploy" >&2
  exit 1
fi

release="$(date -u +%Y%m%dT%H%M%SZ)"
remote_release="$DEPLOY_ROOT/releases/$release"

echo "==> creating remote release directory $remote_release"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "mkdir -p '$remote_release'"

echo "==> rsyncing app/dist to $DEPLOY_HOST:$remote_release"
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  app/dist/ "$DEPLOY_HOST:$remote_release/"

echo "==> flipping current symlink"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s <<REMOTE
set -euo pipefail
ln -sfn "$remote_release" "$DEPLOY_ROOT/current.tmp"
mv -Tf "$DEPLOY_ROOT/current.tmp" "$DEPLOY_ROOT/current"
REMOTE

echo "==> deployed release $release -> $DEPLOY_ROOT/current"

if [[ "$RELOAD_CADDY" -eq 1 ]]; then
  echo "==> reloading caddy"
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "sudo systemctl reload caddy"
fi

if [[ "$PRUNE_KEEP" -gt 0 ]]; then
  echo "==> pruning releases, keeping the $PRUNE_KEEP most recent"
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s <<REMOTE
set -euo pipefail
cd "$DEPLOY_ROOT/releases"
ls -1t | tail -n +$((PRUNE_KEEP + 1)) | while read -r old; do
  echo "removing \$old"
  rm -rf -- "\$old"
done
REMOTE
fi

echo "==> done"
