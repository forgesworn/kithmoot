#!/usr/bin/env bash
set -euo pipefail

# blossom-deploy.sh - ship the Blossom server kit to the box and install it
# there: blossom-server-ts, pinned, as a systemd service under its own user,
# with a fixed-size filesystem for the blobs. A file dropped into a room's
# chat is sealed in the browser and put here; the box learns an encrypted
# blob and a device key, and nothing else.
#
# Companion to deploy.sh (the site), turn-deploy.sh (TURN) and
# keeper-deploy.sh (rooms). Separate for the same reason as those: it
# manages a system service, and is run when something about it changed.
#
# Usage:
#   DEPLOY_HOST=deploy@your-box deploy/blossom-deploy.sh
#
# Env:
#   DEPLOY_HOST         required, e.g. deploy@your-box. No default on purpose.
#   DEPLOY_KEY          ~/.ssh/id_ed25519
#   BLOSSOM_PUBLIC_URL  where blobs are served; default https://kithmoot.forgesworn.dev/blossom/
#   BLOSSOM_PORT        loopback port; default 8092
#   BLOSSOM_QUOTA_GIB   blob filesystem size; default 20
#   (the last three are read only when the box is first set up)
#
# It does not touch Caddy. The two handles that expose the server, /upload
# and /blossom/*, are in deploy/Caddyfile.kithmoot: put them in the vhost,
# validate, reload. Until then the service answers on loopback and nothing
# reaches it.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "blossom-deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/blossom-deploy.sh" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
BLOSSOM_PUBLIC_URL="${BLOSSOM_PUBLIC_URL:-https://kithmoot.forgesworn.dev/blossom/}"
BLOSSOM_PORT="${BLOSSOM_PORT:-8092}"
BLOSSOM_QUOTA_GIB="${BLOSSOM_QUOTA_GIB:-20}"

SSH_OPTS=(-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$DEPLOY_KEY")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }

echo "==> creating the remote directory"
remote bash -s <<'REMOTE'
set -euo pipefail
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /opt/kithmoot-blossom
# Whatever a previous install left owned by somebody else comes back to the
# deploy user, so the rsync below can replace it.
sudo chown -R "$(id -un):$(id -gn)" /opt/kithmoot-blossom
REMOTE

echo "==> shipping the kit"
rsync -az -e "ssh ${SSH_OPTS[*]}" --relative \
  ./deploy/blossom.service \
  ./deploy/blossom.yml \
  ./deploy/blossom-install.sh \
  ./deploy/README.md \
  "$DEPLOY_HOST:/opt/kithmoot-blossom/"

echo "==> running blossom-install.sh on the box"
install_env="BLOSSOM_PUBLIC_URL=$(printf %q "$BLOSSOM_PUBLIC_URL") BLOSSOM_PORT=$(printf %q "$BLOSSOM_PORT") BLOSSOM_QUOTA_GIB=$(printf %q "$BLOSSOM_QUOTA_GIB")"
remote "sudo env $install_env bash /opt/kithmoot-blossom/deploy/blossom-install.sh" </dev/null

echo "==> Blossom server deployed to $DEPLOY_HOST"
