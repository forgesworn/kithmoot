#!/usr/bin/env bash
set -euo pipefail

# forwarder-install.sh - runs ON THE BOX, as root, from forwarder-deploy.sh,
# after keeper-deploy.sh has put the tree at /opt/kithmoot-keeper. One
# forwarder instance per room: kithmoot-forwarder@<name>, reading
# /etc/kithmoot/forwarder-<name>.env and running from that tree.
#
# Usage:
#   forwarder-install.sh --name <name> --room-id <64 hex> [first-run options]
#
# First-run options, written into the env file the first time and then left
# alone (edit the file and restart the instance to change them later):
#   --relays <a,b>     comma-separated; default: the app's own relays. Use the
#                      room's, or the room never sees this forwarder answer.
#   --url <wss://...>  the relay advertised in the descriptor; default: the first relay
#   --max-peers <n>    fan-out cap; default 24
#   --max-tracks <n>   per-peer track cap; default 4
#   --label <text>     a name for people; default: the instance name
#
# Nothing is read from the environment except to refuse it: a room key or
# secret anywhere in it stops this script, as it stops the forwarder.
#
# The forwarder's own Nostr key is generated here on the first run and never
# again: a room descriptor names a forwarder by pubkey, so a regenerated key
# would orphan every room pointing at it. It is written into the env file by
# a shell builtin, never passed as an argument, because arguments are
# visible in `ps` to every user on the box.
#
# It is given the room id and never the room key. There is no flag for the
# key and there never will be; see the top of server/forwarder.mjs.

[[ "$(id -u)" -eq 0 ]] || { echo "forwarder-install.sh: run as root" >&2; exit 2; }

TREE=/opt/kithmoot-keeper
ETC=/etc/kithmoot
FWD_USER=kithmoot-fwd
UNIT_DIR=/etc/systemd/system

NAME=""
ROOM_ID=""
RELAYS="wss://relay.trotters.cc,wss://nos.lol,wss://relay.primal.net"
URL=""
MAX_PEERS=24
MAX_TRACKS=4
LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?forwarder-install.sh: --name needs a value}"; shift 2 ;;
    --room-id) ROOM_ID="${2:?forwarder-install.sh: --room-id needs a value}"; shift 2 ;;
    --relays) RELAYS="${2:?forwarder-install.sh: --relays needs a value}"; shift 2 ;;
    --url) URL="${2:?forwarder-install.sh: --url needs a value}"; shift 2 ;;
    --max-peers) MAX_PEERS="${2:?forwarder-install.sh: --max-peers needs a value}"; shift 2 ;;
    --max-tracks) MAX_TRACKS="${2:?forwarder-install.sh: --max-tracks needs a value}"; shift 2 ;;
    --label) LABEL="${2:?forwarder-install.sh: --label needs a value}"; shift 2 ;;
    *) echo "forwarder-install.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "forwarder-install.sh: --name is 1 to 32 of a-z 0-9 _ -; got '$NAME'" >&2
  exit 2
fi
if [[ "$ROOM_ID" == *'#'* || "$ROOM_ID" == *'://'* ]]; then
  echo "forwarder-install.sh: --room-id looks like a join URL. A join URL carries the room secret, and a forwarder is never given that. Pass the 64-hex room id on its own." >&2
  exit 2
fi
ROOM_ID="${ROOM_ID,,}"
if [[ ! "$ROOM_ID" =~ ^[0-9a-f]{64}$ ]]; then
  echo "forwarder-install.sh: --room-id must be 64 hex characters" >&2
  exit 2
fi
for forbidden in KITHMOOT_ROOM_KEY KITHMOOT_ROOM_SECRET KITHMOOT_JOIN_URL KITHMOOT_SECRET; do
  if [[ -n "${!forbidden:-}" ]]; then
    echo "forwarder-install.sh: $forbidden is set; refusing. A forwarder is never given the room key." >&2
    exit 2
  fi
done
for relay in ${RELAYS//,/ }; do
  if [[ "$relay" != ws://* && "$relay" != wss://* ]]; then
    echo "forwarder-install.sh: --relays entry '$relay' is not a ws: or wss: address" >&2
    exit 2
  fi
done
if [[ ! "$MAX_PEERS" =~ ^[0-9]+$ || ! "$MAX_TRACKS" =~ ^[0-9]+$ ]]; then
  echo "forwarder-install.sh: --max-peers and --max-tracks are whole numbers" >&2
  exit 2
fi
[[ -s "$TREE/server/forwarder.mjs" && -s "$TREE/dist/src/peer.js" && -d "$TREE/node_modules" ]] || {
  echo "forwarder-install.sh: no shipped tree at $TREE; run keeper-deploy.sh first" >&2
  exit 1
}

if ! id "$FWD_USER" >/dev/null 2>&1; then
  echo "==> creating $FWD_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$FWD_USER"
fi

ENV_FILE="$ETC/forwarder-$NAME.env"
if [[ ! -s "$ENV_FILE" ]]; then
  echo "==> writing $ENV_FILE (generating this forwarder's key, once)"
  install -d -m 0755 "$ETC"
  sk="$(openssl rand -hex 32)"
  (
    umask 077
    printf '%s\n' \
      "# Forwarder \"$NAME\". Edit and \`systemctl restart kithmoot-forwarder@$NAME\`. Never add a room key here." \
      "KITHMOOT_ROOM_ID=$ROOM_ID" \
      "NOSTR_RELAYS=$RELAYS" \
      "KITHMOOT_FORWARDER_URL=${URL:-${RELAYS%%,*}}" \
      "KITHMOOT_MAX_PEERS=$MAX_PEERS" \
      "KITHMOOT_MAX_TRACKS_PER_PEER=$MAX_TRACKS" \
      "KITHMOOT_LABEL=${LABEL:-$NAME}" \
      "KITHMOOT_FORWARDER_SK=$sk" \
      >"$ENV_FILE"
  )
  unset sk
  chown "$FWD_USER:$FWD_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
else
  echo "==> keeping the existing $ENV_FILE"
  if ! grep -q "^KITHMOOT_ROOM_ID=$ROOM_ID\$" "$ENV_FILE"; then
    echo "    it names a different room id than --room-id; the file stands. Edit it if that is wrong." >&2
  fi
fi

echo "==> installing the unit"
install -m 0644 -o root -g root "$TREE/deploy/forwarder@.service" "$UNIT_DIR/kithmoot-forwarder@.service"
systemctl daemon-reload
systemctl enable "kithmoot-forwarder@$NAME" >/dev/null
systemctl restart "kithmoot-forwarder@$NAME"

echo "==> waiting for it"
sleep 4
if ! systemctl is-active --quiet "kithmoot-forwarder@$NAME"; then
  echo "forwarder-install.sh: kithmoot-forwarder@$NAME is not running" >&2
  journalctl -u "kithmoot-forwarder@$NAME" -n 20 --no-pager >&2 || true
  exit 1
fi
echo "==> kithmoot-forwarder@$NAME is up. Its banner:"
journalctl -u "kithmoot-forwarder@$NAME" -n 15 --no-pager -o cat
