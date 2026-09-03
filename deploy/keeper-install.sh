#!/usr/bin/env bash
set -euo pipefail

# keeper-install.sh - runs ON THE BOX, as root, from keeper-deploy.sh. Makes
# the service users, installs the production dependencies into the shipped
# tree, installs the unit templates, and, given a room, makes sure that
# room's instance has an env file and is running.
#
# Usage:
#   keeper-install.sh [--room <name>] [--seed-state]
#
#   --room <name>   the instance to install: kithmoot-keeper@<name>, reading
#                   /etc/kithmoot/keeper-<name>.env, state under
#                   /var/lib/kithmoot-keeper/<name>/. Without it only the
#                   tree and the units are updated, and every running
#                   instance is restarted onto the new tree.
#   --seed-state    read an existing room's keeper state (a room.json) from
#                   stdin into the instance's state directory before the
#                   first start, so the box takes over a room that already
#                   exists rather than opening a new one. Refused if the
#                   instance already has a room.
#
# Env (passed through by keeper-deploy.sh; read only when the env file is
# first written):
#   KITHMOOT_BASE     where the app is served, e.g. https://host/j/
#   KITHMOOT_NAME     what the room calls the keeper; default "Keeper"
#   KITHMOOT_RELAYS   comma-separated relay list; default: the app's own
#   KITHMOOT_FORWARDER the forwarder line to put in the room descriptor; optional
#
# Idempotent. A second run updates the tree and restarts the instances; the
# env files and the state directories are left alone, so the rooms survive.
#
# A box installed from the single-room kit (kithmoot-keeper.service, state
# directly under /var/lib/kithmoot-keeper, /etc/kithmoot/keeper.env) is
# migrated to the instance `default` the first time this runs: the same
# three files, moved (not copied) into /var/lib/kithmoot-keeper/default/,
# the env file renamed, the old unit stopped, disabled and moved aside under
# /etc/kithmoot/migrated-<stamp>/. The room and its link do not change.
#
# It prints the room's public id and the path of its link, never the link:
# a link is a capability, and a deploy log is not where one belongs.

[[ "$(id -u)" -eq 0 ]] || { echo "keeper-install.sh: run as root" >&2; exit 2; }

TREE=/opt/kithmoot-keeper
ETC=/etc/kithmoot
USER_NAME=kithmoot-keeper
FWD_USER=kithmoot-fwd
STATE_ROOT=/var/lib/kithmoot-keeper
UNIT_DIR=/etc/systemd/system
NODE=/usr/bin/node

ROOM=""
SEED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --room) ROOM="${2:?keeper-install.sh: --room needs a name}"; shift 2 ;;
    --seed-state) SEED=1; shift ;;
    *) echo "keeper-install.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [[ -n "$ROOM" && ! "$ROOM" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; then
  echo "keeper-install.sh: a room name is 1 to 32 of a-z 0-9 _ -; got '$ROOM'" >&2
  exit 2
fi
if [[ "$SEED" -eq 1 && -z "$ROOM" ]]; then
  echo "keeper-install.sh: --seed-state needs --room" >&2
  exit 2
fi

ensure_user() {
  if ! id "$1" >/dev/null 2>&1; then
    echo "==> creating $1"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$1"
  fi
}
ensure_user "$USER_NAME"
# The forwarder's user too: its unit ships in this tree.
ensure_user "$FWD_USER"

# Seeding reads stdin, so it goes first and nothing after it may.
if [[ "$SEED" -eq 1 ]]; then
  inst="$STATE_ROOT/$ROOM"
  if [[ -e "$inst/room.json" ]]; then
    echo "keeper-install.sh: $inst/room.json exists; refusing to seed over a room that is already here" >&2
    exit 1
  fi
  echo "==> seeding $inst/room.json from stdin"
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$STATE_ROOT" "$inst"
  ( umask 077; cat >"$inst/room.json" )
  chown "$USER_NAME:$USER_NAME" "$inst/room.json"
  chmod 0600 "$inst/room.json"
  # A v1 keeper state, and nothing else, and none of it printed.
  if ! "$NODE" -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v)
    if (s.v !== 1 || !hex(s.secret) || !hex(s.inviterSk) || !hex(s.bearer)) process.exit(1)
  ' "$inst/room.json" 2>/dev/null; then
    mv "$inst/room.json" "$inst/room.json.rejected-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "keeper-install.sh: what arrived on stdin is not a v1 keeper state; moved aside, nothing started" >&2
    exit 1
  fi
fi

echo "==> installing production dependencies"
cd "$TREE"
# The tree was shipped without node_modules; only what the built library
# imports at runtime is installed here. No compiler, nothing to build.
npm ci --omit=dev --no-audit --no-fund --loglevel=error </dev/null
# Readable by the service users, owned by whoever deploys: the tree is
# rsynced over by the deploy user on every deploy, and a tree handed to a
# service user is one the next deploy cannot write. The services only read.
chmod -R a+rX "$TREE"

MIGRATED=0
if [[ -f "$STATE_ROOT/room.json" ]]; then
  if [[ -e "$STATE_ROOT/default" ]]; then
    echo "keeper-install.sh: both $STATE_ROOT/room.json and $STATE_ROOT/default/ exist; sort that out by hand" >&2
    exit 1
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "==> migrating the single-room keeper to kithmoot-keeper@default"
  if systemctl cat kithmoot-keeper.service >/dev/null 2>&1; then
    systemctl disable --now kithmoot-keeper.service
  fi
  install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$STATE_ROOT/default"
  for f in room.json room.json.link identity.key; do
    if [[ -e "$STATE_ROOT/$f" ]]; then mv "$STATE_ROOT/$f" "$STATE_ROOT/default/$f"; fi
  done
  if [[ -f "$ETC/keeper.env" && ! -e "$ETC/keeper-default.env" ]]; then
    mv "$ETC/keeper.env" "$ETC/keeper-default.env"
    sed -i 's/systemctl restart kithmoot-keeper`/systemctl restart kithmoot-keeper@default`/' "$ETC/keeper-default.env"
  fi
  if [[ -f "$UNIT_DIR/kithmoot-keeper.service" ]]; then
    install -d -m 0700 "$ETC/migrated-$stamp"
    mv "$UNIT_DIR/kithmoot-keeper.service" "$ETC/migrated-$stamp/kithmoot-keeper.service"
    echo "    old unit moved aside to $ETC/migrated-$stamp/"
  fi
  MIGRATED=1
fi

echo "==> installing the units"
install -m 0644 -o root -g root "$TREE/deploy/keeper@.service" "$UNIT_DIR/kithmoot-keeper@.service"
install -m 0644 -o root -g root "$TREE/deploy/forwarder@.service" "$UNIT_DIR/kithmoot-forwarder@.service"
systemctl daemon-reload

if [[ "$MIGRATED" -eq 1 ]]; then
  systemctl enable kithmoot-keeper@default >/dev/null
fi

if [[ -n "$ROOM" ]]; then
  ENV_FILE="$ETC/keeper-$ROOM.env"
  if [[ ! -s "$ENV_FILE" ]]; then
    echo "==> writing $ENV_FILE"
    install -d -m 0755 "$ETC"
    name="${KITHMOOT_NAME:-Keeper}"
    name="${name//\\/\\\\}"; name="${name//\"/\\\"}"
    cat >"$ENV_FILE" <<ENV
# The standing room "$ROOM" this box keeps. Edit and \`systemctl restart kithmoot-keeper@$ROOM\`.
KITHMOOT_BASE=${KITHMOOT_BASE:?KITHMOOT_BASE is required}
KITHMOOT_NAME="$name"
KITHMOOT_RELAYS=${KITHMOOT_RELAYS:-wss://relay.trotters.cc,wss://nos.lol,wss://relay.primal.net}
# A forwarder this room may promote to: the line kithmoot-forwarder prints,
# {"url","pubkey","label"}. The keeper publishes it in the room descriptor at
# start, after every rekey and for every arrival. Empty means no forwarder.
KITHMOOT_FORWARDER='${KITHMOOT_FORWARDER:-}'
ENV
    chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
  else
    echo "==> keeping the existing $ENV_FILE"
  fi
  systemctl enable "kithmoot-keeper@$ROOM" >/dev/null
fi

# Everything on this box runs from the tree that just landed, so everything
# running comes up again on it. A restart is a few seconds in which that
# room's link is not answered.
echo "==> restarting onto the new tree"
running="$(systemctl list-units --plain --no-legend --state=active 'kithmoot-keeper@*.service' 'kithmoot-forwarder@*.service' | awk '{print $1}')"
if [[ "$MIGRATED" -eq 1 ]]; then running="$running kithmoot-keeper@default.service"; fi
if [[ -n "$ROOM" ]]; then running="$running kithmoot-keeper@$ROOM.service"; fi
for unit in $(printf '%s\n' $running | sort -u); do
  echo "    $unit"
  systemctl restart "$unit"
done

if [[ -n "$ROOM" ]]; then
  echo "==> waiting for room $ROOM"
  link="$STATE_ROOT/$ROOM/room.json.link"
  up=0
  for _ in $(seq 1 30); do
    if [[ -s "$link" ]] && systemctl is-active --quiet "kithmoot-keeper@$ROOM"; then up=1; break; fi
    sleep 1
  done
  if [[ "$up" -ne 1 ]]; then
    echo "keeper-install.sh: kithmoot-keeper@$ROOM did not open its room within 30s" >&2
    journalctl -u "kithmoot-keeper@$ROOM" -n 20 --no-pager >&2 || true
    exit 1
  fi
  room_id="$("$NODE" --input-type=module -e '
    import { readFile } from "node:fs/promises"
    import { deriveRoom } from "/opt/kithmoot-keeper/dist/src/room.js"
    const s = JSON.parse(await readFile(process.argv[1], "utf8"))
    process.stdout.write(deriveRoom(Uint8Array.from(Buffer.from(s.secret, "hex"))).roomId)
  ' "$STATE_ROOT/$ROOM/room.json")"
  echo "==> room $ROOM is open, kept by kithmoot-keeper@$ROOM"
  echo "    room id (public; what a forwarder is given): $room_id"
  echo "    link (a capability; hand it out yourself):    sudo cat $link"
fi
