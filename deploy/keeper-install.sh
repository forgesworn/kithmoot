#!/usr/bin/env bash
set -euo pipefail

# keeper-install.sh - runs ON THE BOX, as root, from keeper-deploy.sh. Makes
# the service user, installs the production dependencies into the shipped
# tree, writes the env file if there is not one, installs the unit, starts
# it, and prints the room link.
#
# Env (passed through by keeper-deploy.sh):
#   KITHMOOT_BASE     where the app is served, e.g. https://host/j/
#   KITHMOOT_NAME     what the room calls the keeper; default "Keeper"
#   KITHMOOT_RELAYS   comma-separated relay list; default: the app's own
#
# Idempotent. A second run updates the tree and restarts the service; the
# env file and the state directory are left alone, so the room survives.

[[ "$(id -u)" -eq 0 ]] || { echo "keeper-install.sh: run as root" >&2; exit 2; }

TREE=/opt/kithmoot-keeper
ENV_FILE=/etc/kithmoot/keeper.env
UNIT=/etc/systemd/system/kithmoot-keeper.service
USER_NAME=kithmoot-keeper
STATE_DIR=/var/lib/kithmoot-keeper

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "==> creating $USER_NAME"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi

echo "==> installing production dependencies"
cd "$TREE"
# The tree was shipped without node_modules; only what the built library
# imports at runtime is installed here. No compiler, nothing to build.
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R "$USER_NAME:$USER_NAME" "$TREE"

if [[ ! -s "$ENV_FILE" ]]; then
  echo "==> writing $ENV_FILE"
  install -d -m 0755 /etc/kithmoot
  cat >"$ENV_FILE" <<EOF
# The standing room this box keeps. Edit and \`systemctl restart kithmoot-keeper\`.
KITHMOOT_BASE=${KITHMOOT_BASE:?KITHMOOT_BASE is required}
KITHMOOT_NAME=${KITHMOOT_NAME:-Keeper}
KITHMOOT_RELAYS=${KITHMOOT_RELAYS:-wss://relay.trotters.cc,wss://nos.lol,wss://relay.primal.net}
EOF
  chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
else
  echo "==> keeping the existing $ENV_FILE"
fi

echo "==> installing the unit"
install -m 0644 -o root -g root "$TREE/deploy/keeper.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now kithmoot-keeper >/dev/null
systemctl restart kithmoot-keeper

echo "==> waiting for the room"
for _ in $(seq 1 30); do
  if [[ -s "$STATE_DIR/room.json.link" ]]; then
    echo "==> the room is open. The link:"
    cat "$STATE_DIR/room.json.link"
    exit 0
  fi
  sleep 1
done
echo "keeper-install.sh: the keeper did not open a room within 30s; see journalctl -u kithmoot-keeper" >&2
journalctl -u kithmoot-keeper -n 20 --no-pager >&2 || true
exit 1
