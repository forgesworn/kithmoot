#!/usr/bin/env bash
set -euo pipefail

# keeper-deploy.sh - build the library locally, ship what the agent CLI and
# the forwarder run to the box, and install a keeper there: one process that
# holds one standing room open for as long as it runs. A box keeps as many
# rooms as it has instances; each is `kithmoot-keeper@<room>`.
#
# Companion to deploy.sh (the site) and turn-deploy.sh (TURN). Separate for
# the same reason: this manages system services that hold room keys, and
# should be run when something about them actually changed.
#
# Usage:
#   DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh [--room <name>] [--state-from <file>]
#   DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh --ship-only
#   DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh --dry-run
#
#   --room <name>        the room to install or update, as kithmoot-keeper@<name>.
#                        Default "default", so the old one-liner still keeps
#                        its room. 1 to 32 of a-z 0-9 _ -.
#   --state-from <file>  seed a room this box has not seen with an existing
#                        room's keeper state (the room.json that
#                        `kithmoot-agent create --state` wrote), so the box
#                        takes the room over rather than opening a new one.
#                        The file goes over ssh on stdin, never as an
#                        argument, and lands 0600 owned by the service user.
#                        Refused if the instance already has a room.
#   --ship-only          update the tree and the units and restart the
#                        running instances; install no room. What
#                        forwarder-deploy.sh uses.
#   --dry-run            build, then stop.
#
# Env:
#   DEPLOY_HOST      required, e.g. deploy@your-box. No default on purpose.
#   DEPLOY_KEY       ~/.ssh/id_ed25519
#   KITHMOOT_BASE    where the app is served; default https://kithmoot.forgesworn.dev/j/
#   KITHMOOT_NAME    what the room calls the keeper; default Keeper
#   KITHMOOT_RELAYS  comma-separated; default: the app's own relays
#   (the last three are read only when a room's env file is first written)
#
# A new room's secret, inviter key and the keeper's identity are generated
# on the box, under /var/lib/kithmoot-keeper/<room>/, and never leave it.
# Nothing here reads them, and nothing here prints a link: the install ends
# with the room's public id and the path of the link, and `sudo cat
# /var/lib/kithmoot-keeper/<room>/room.json.link` on the box prints it.

DEPLOY_HOST="${DEPLOY_HOST:-}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "keeper-deploy.sh: DEPLOY_HOST is not set." >&2
  echo "  Set it to the box you mean to deploy to, e.g." >&2
  echo "    DEPLOY_HOST=deploy@your-box deploy/keeper-deploy.sh --room standing" >&2
  exit 2
fi
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
KITHMOOT_BASE="${KITHMOOT_BASE:-https://kithmoot.forgesworn.dev/j/}"
KITHMOOT_NAME="${KITHMOOT_NAME:-Keeper}"
KITHMOOT_RELAYS="${KITHMOOT_RELAYS:-}"

ROOM=default
STATE_FROM=""
SHIP_ONLY=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --room) ROOM="${2:?keeper-deploy.sh: --room needs a name}"; shift 2 ;;
    --state-from) STATE_FROM="${2:?keeper-deploy.sh: --state-from needs a file}"; shift 2 ;;
    --ship-only) SHIP_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "keeper-deploy.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [[ ! "$ROOM" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "keeper-deploy.sh: a room name is 1 to 32 of a-z 0-9 _ -; got '$ROOM'" >&2
  exit 2
fi
if [[ -n "$STATE_FROM" ]]; then
  if [[ "$SHIP_ONLY" -eq 1 ]]; then
    echo "keeper-deploy.sh: --state-from and --ship-only do not go together" >&2
    exit 2
  fi
  if [[ ! -s "$STATE_FROM" ]]; then
    echo "keeper-deploy.sh: --state-from: '$STATE_FROM' is missing or empty" >&2
    exit 2
  fi
fi

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
# What the CLI and the forwarder run and nothing else: the entry points, the
# built library, the lockfile that pins its runtime dependencies (installed
# on the box by keeper-install.sh with --omit=dev), the units, the install
# scripts, and the docs the units link to. No checkout, no compiler, nothing
# to build there.
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" --relative \
  ./bin/kithmoot-agent.mjs \
  ./server/forwarder.mjs \
  ./dist/src/ \
  ./package.json \
  ./package-lock.json \
  ./deploy/keeper@.service \
  ./deploy/keeper-install.sh \
  ./deploy/forwarder@.service \
  ./deploy/forwarder-install.sh \
  ./deploy/README.md \
  ./docs/agents.md \
  "$DEPLOY_HOST:/opt/kithmoot-keeper/"

# The name may carry a quote or a space; %q makes it one word for the remote
# shell whatever it holds.
install_env="KITHMOOT_BASE=$(printf %q "$KITHMOOT_BASE") KITHMOOT_NAME=$(printf %q "$KITHMOOT_NAME") KITHMOOT_RELAYS=$(printf %q "$KITHMOOT_RELAYS")"
install_args=""
if [[ "$SHIP_ONLY" -eq 0 ]]; then install_args="--room $ROOM"; fi

if [[ -n "$STATE_FROM" ]]; then
  echo "==> running keeper-install.sh on the box, seeding room $ROOM from $STATE_FROM"
  remote "sudo env $install_env bash /opt/kithmoot-keeper/deploy/keeper-install.sh $install_args --seed-state" <"$STATE_FROM"
else
  echo "==> running keeper-install.sh on the box"
  remote "sudo env $install_env bash /opt/kithmoot-keeper/deploy/keeper-install.sh $install_args" </dev/null
fi

echo "==> keeper tree deployed to $DEPLOY_HOST"
