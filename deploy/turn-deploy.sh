#!/usr/bin/env bash
set -euo pipefail

# turn-deploy.sh - build the credential service's tree locally, ship it and
# the coturn files to the box, and run deploy/coturn/install.sh there.
#
# Companion to deploy.sh, which publishes the site. This one publishes the
# TURN server the site's app points at. They are separate on purpose: the
# site is redeployed often and touches nothing but a directory, while this
# manages system services, a firewall and a shared secret, and should be run
# when something about TURN actually changed.
#
# Usage:
#   DEPLOY_HOST=deploy@your-box deploy/turn-deploy.sh [--dry-run]
#
# Env:
#   DEPLOY_HOST      required, e.g. deploy@your-box. No default on purpose:
#                    this is a public repository, and a hardcoded host is
#                    both somebody's server address and a way to deploy to
#                    the wrong box by forgetting to set it.
#   DEPLOY_KEY       ~/.ssh/id_ed25519
#   HOSTNAME_TURN    kithmoot.forgesworn.dev
#
# The secret is generated on the box, by install.sh, and never leaves it.
# Nothing in this script reads it, prints it or copies it anywhere.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "turn-deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/turn-deploy.sh" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
HOSTNAME_TURN="${HOSTNAME_TURN:-kithmoot.forgesworn.dev}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$DEPLOY_KEY")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

echo "==> building dist/src/turn.js"
npm run build:lib
[[ -s dist/src/turn.js ]] || { echo "turn-deploy.sh: dist/src/turn.js missing after build:lib" >&2; exit 1; }

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> dry run: nothing was sent to $DEPLOY_HOST"
  exit 0
fi

echo "==> creating the remote directories"
remote bash -s <<'REMOTE'
set -euo pipefail
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /opt/kithmoot-coturn /opt/kithmoot-turn
REMOTE

echo "==> shipping the credential service tree"
# Only what the service actually runs: the entry point, the one built module
# it imports, and the lockfile that pins the two packages that module needs.
# Not a checkout - there is no compiler on the box and nothing to build there.
rsync -az -e "ssh ${SSH_OPTS[*]}" --relative \
  ./server/turn-credentials.mjs \
  ./dist/src/turn.js \
  ./package.json \
  ./package-lock.json \
  "$DEPLOY_HOST:/opt/kithmoot-turn/"

echo "==> shipping the coturn files"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  deploy/coturn/turnserver.conf \
  deploy/coturn/docker-compose.yml \
  deploy/coturn/sync-certs.sh \
  deploy/coturn/install.sh \
  "$DEPLOY_HOST:/opt/kithmoot-coturn/"
# The systemd units go beside them, in a units/ subdirectory install.sh
# installs from. They are copied rather than symlinked into
# /etc/systemd/system so that systemd holds the real file and a later deploy
# replacing this directory cannot leave a dangling unit behind.
remote "mkdir -p /opt/kithmoot-coturn/units"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  deploy/turn-credentials.service \
  deploy/kithmoot-turn-certs.service \
  deploy/kithmoot-turn-certs.timer \
  "$DEPLOY_HOST:/opt/kithmoot-coturn/units/"

echo "==> running install.sh on the box"
remote "sudo env HOSTNAME_TURN='$HOSTNAME_TURN' bash /opt/kithmoot-coturn/install.sh"

echo "==> deployed TURN for $HOSTNAME_TURN"
