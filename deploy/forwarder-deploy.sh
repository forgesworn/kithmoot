#!/usr/bin/env bash
set -euo pipefail

# forwarder-deploy.sh - ship the tree to the box (via keeper-deploy.sh
# --ship-only, so keepers and forwarders run one tree) and install a
# forwarder instance there for one room: `kithmoot-forwarder@<name>`.
#
# Usage:
#   DEPLOY_HOST=deploy@your-box deploy/forwarder-deploy.sh --name <name> --room-id <64 hex> [first-run options]
#
# First-run options, written into the instance's env file the first time and
# then left alone; edit /etc/kithmoot/forwarder-<name>.env on the box and
# restart the instance to change them later:
#   --relays <a,b>     comma-separated; default: the app's own relays. Use the
#                      room's, or the room never sees this forwarder answer.
#   --url <wss://...>  the relay advertised in the descriptor; default: the first relay
#   --max-peers <n>    fan-out cap; default 24
#   --max-tracks <n>   per-peer track cap; default 4
#   --label <text>     a name for people; default: the instance name
#
# Env:
#   DEPLOY_HOST  required, e.g. deploy@your-box. No default on purpose.
#   DEPLOY_KEY   ~/.ssh/id_ed25519
#
# Nothing else is read from the environment. Every value the forwarder runs
# with is a flag here, so a NOSTR_RELAYS left in your shell by some other
# tool cannot quietly become the relays this room's forwarder listens on.
#
# The room id is the one thing you bring, and deliberately the only thing:
# keeper-install.sh prints it for a room the box keeps, and a member can
# read it off `deriveRoom(secret).roomId`. There is no flag for the room key
# and there never will be; see the top of server/forwarder.mjs.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "forwarder-deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/forwarder-deploy.sh --name townhall --room-id <64 hex>" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"

NAME=""
ROOM_ID=""
PASS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?forwarder-deploy.sh: --name needs a value}"; shift 2 ;;
    --room-id) ROOM_ID="${2:?forwarder-deploy.sh: --room-id needs a value}"; shift 2 ;;
    --relays|--url|--max-peers|--max-tracks|--label)
      [[ $# -ge 2 ]] || { echo "forwarder-deploy.sh: $1 needs a value" >&2; exit 2; }
      # %q makes a value one word for the remote shell whatever it holds.
      PASS="$PASS $1 $(printf %q "$2")"; shift 2 ;;
    *) echo "forwarder-deploy.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "forwarder-deploy.sh: --name is 1 to 32 of a-z 0-9 _ -; got '$NAME'" >&2
  exit 2
fi
if [[ "$ROOM_ID" == *'#'* || "$ROOM_ID" == *'://'* ]]; then
  echo "forwarder-deploy.sh: --room-id looks like a join URL, which carries the room secret. Pass the 64-hex room id on its own." >&2
  exit 2
fi
if [[ ! "$ROOM_ID" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "forwarder-deploy.sh: --room-id must be 64 hex characters" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

DEPLOY_HOST="$DEPLOY_HOST" DEPLOY_KEY="$DEPLOY_KEY" deploy/keeper-deploy.sh --ship-only

echo "==> running forwarder-install.sh on the box"
ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i "$DEPLOY_KEY" "$DEPLOY_HOST" \
  "sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin bash /opt/kithmoot-keeper/deploy/forwarder-install.sh --name $NAME --room-id $ROOM_ID$PASS" </dev/null

echo "==> forwarder $NAME deployed to $DEPLOY_HOST"
