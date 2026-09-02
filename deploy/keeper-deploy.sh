#!/usr/bin/env bash
set -euo pipefail

# keeper-deploy.sh - build the library locally, ship what the agent CLI
# runs to the box, and install a keeper there: one process that holds one
# standing room open for as long as it runs.
#
# Companion to deploy.sh (the site) and turn-deploy.sh (TURN). Separate for
# the same reason: this manages a system service that holds a room key, and
# should be run when something about the keeper actually changed.
#
# Usage:
#   DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh [--dry-run]
#
# Env:
#   DEPLOY_HOST      required, e.g. deploy@your-box. No default on purpose.
#   DEPLOY_KEY       ~/.ssh/id_ed25519
#   KITHMOOT_BASE    where the app is served; default https://kithmoot.forgesworn.dev/j/
#   KITHMOOT_NAME    what the room calls the keeper; default Keeper
#   KITHMOOT_RELAYS  comma-separated; default: the app's own relays
#
# The room's secret, inviter key and the keeper's identity are generated on
# the box, under /var/lib/kithmoot-keeper, and never leave it. Nothing here
# reads them. The link is printed at the end, and `sudo cat
# /var/lib/kithmoot-keeper/room.json.link` on the box prints it again.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "keeper-deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
KITHMOOT_BASE="${KITHMOOT_BASE:-https://kithmoot.forgesworn.dev/j/}"
KITHMOOT_NAME="${KITHMOOT_NAME:-Keeper}"
KITHMOOT_RELAYS="${KITHMOOT_RELAYS:-}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$DEPLOY_KEY")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

echo "==> building dist/"
npm run build:lib
[[ -s dist/src/node/cli.js ]] || { echo "keeper-deploy.sh: dist/src/node/cli.js missing after build:lib" >&2; exit 1; }

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> dry run: nothing was sent to $DEPLOY_HOST"
  exit 0
fi

echo "==> creating the remote directory"
remote bash -s <<'REMOTE'
set -euo pipefail
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /opt/kithmoot-keeper
# Whatever a previous install left owned by somebody else comes back to the
# deploy user, so the rsync below can replace it.
sudo chown -R "$(id -un):$(id -gn)" /opt/kithmoot-keeper
REMOTE

echo "==> shipping the tree"
# What the CLI runs and nothing else: the entry point, the built library,
# the lockfile that pins its runtime dependencies (installed on the box by
# keeper-install.sh with --omit=dev), the unit, and the design doc the unit
# links to. No checkout, no compiler, nothing to build there.
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --relative \
  ./bin/kithmoot-agent.mjs \
  ./dist/src/ \
  ./package.json \
  ./package-lock.json \
  ./deploy/keeper.service \
  ./deploy/keeper-install.sh \
  ./docs/agents.md \
  "$DEPLOY_HOST:/opt/kithmoot-keeper/"

echo "==> running keeper-install.sh on the box"
remote "sudo env KITHMOOT_BASE='$KITHMOOT_BASE' KITHMOOT_NAME='$KITHMOOT_NAME' KITHMOOT_RELAYS='$KITHMOOT_RELAYS' bash /opt/kithmoot-keeper/deploy/keeper-install.sh"

echo "==> keeper deployed to $DEPLOY_HOST"
