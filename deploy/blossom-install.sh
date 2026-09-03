#!/usr/bin/env bash
set -euo pipefail

# blossom-install.sh - runs ON THE BOX, as root, from blossom-deploy.sh.
# Makes the service user, installs the pinned blossom-server-ts into the
# tree, lays out the state directory with its fixed-size blob filesystem
# (the quota), writes the env file once, installs the unit and starts it.
#
# Usage: blossom-install.sh
#
# Env (passed through by blossom-deploy.sh; read only when something is
# first written):
#   BLOSSOM_PUBLIC_URL  where blobs are served, e.g. https://host/blossom/
#                       (the app's origin, then the path Caddy proxies).
#   BLOSSOM_PORT        loopback port the server listens on; default 8092
#   BLOSSOM_QUOTA_GIB   size of the blob filesystem in GiB; default 20
#
# Idempotent. A second run updates the tree, the config and the unit and
# restarts the service; the env file, the database and the blob filesystem
# are left alone. To change the quota, make a new image: stop the unit,
# unmount, move blobs.img aside (nothing here deletes anything), take its
# line out of /etc/fstab, and run this again.

[[ "$(id -u)" -eq 0 ]] || { echo "blossom-install.sh: run as root" >&2; exit 2; }

TREE=/opt/kithmoot-blossom
ETC=/etc/kithmoot
USER_NAME=kithmoot-blossom
STATE=/var/lib/kithmoot-blossom
IMG=$STATE/blobs.img
MNT=$STATE/blobs
UNIT_DIR=/etc/systemd/system
VERSION=5.2.0
PORT="${BLOSSOM_PORT:-8092}"
QUOTA_GIB="${BLOSSOM_QUOTA_GIB:-20}"

[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "blossom-install.sh: BLOSSOM_PORT must be a port; got '$PORT'" >&2; exit 2; }
[[ "$QUOTA_GIB" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "blossom-install.sh: BLOSSOM_QUOTA_GIB must be a whole number of GiB; got '$QUOTA_GIB'" >&2; exit 2; }

if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "==> creating $USER_NAME"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi

echo "==> installing blossom-server-ts $VERSION"
cd "$TREE"
if [[ ! -s package.json ]]; then
  cat >package.json <<PKG
{
  "name": "kithmoot-blossom",
  "private": true,
  "description": "The KithMoot box's Blossom server: blossom-server-ts, pinned",
  "dependencies": {
    "blossom-server-ts": "$VERSION"
  }
}
PKG
fi
npm install --omit=dev --no-audit --no-fund --loglevel=error --save-exact "blossom-server-ts@$VERSION" </dev/null
install -m 0644 deploy/blossom.yml config.yml
# Readable by the service user, owned by whoever deploys, as the keeper
# tree is: the deploy user rsyncs it, the service only reads it.
chmod -R a+rX "$TREE"

echo "==> state under $STATE"
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$STATE"
if [[ ! -e "$IMG" ]]; then
  echo "    making a $QUOTA_GIB GiB blob filesystem at $IMG"
  fallocate -l "${QUOTA_GIB}G" "$IMG"
  chmod 0600 "$IMG"
  # -m 0: no reserved blocks, so the quota is the whole image.
  mkfs.ext4 -q -m 0 -L kithmoot-blossom "$IMG"
fi
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$MNT"
if ! grep -qF " $MNT " /etc/fstab; then
  echo "    adding $MNT to /etc/fstab"
  cp -a /etc/fstab "/etc/fstab.before-kithmoot-blossom-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "$IMG $MNT ext4 loop,nofail,noatime,x-systemd.device-timeout=10s 0 0" >>/etc/fstab
  systemctl daemon-reload
fi
if ! mountpoint -q "$MNT"; then
  mount "$MNT"
fi
chown "$USER_NAME:$USER_NAME" "$MNT"
chmod 0750 "$MNT"

ENV_FILE="$ETC/blossom.env"
if [[ ! -s "$ENV_FILE" ]]; then
  echo "==> writing $ENV_FILE"
  install -d -m 0755 "$ETC"
  cat >"$ENV_FILE" <<ENV
# The KithMoot box's Blossom server. Edit and \`systemctl restart kithmoot-blossom\`.
PORT=$PORT
BLOSSOM_PUBLIC_URL=${BLOSSOM_PUBLIC_URL:?BLOSSOM_PUBLIC_URL is required}
BLOSSOM_STATE=$STATE
ENV
  chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
else
  echo "==> keeping the existing $ENV_FILE"
  PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"
fi

echo "==> installing the unit"
install -m 0644 -o root -g root "$TREE/deploy/blossom.service" "$UNIT_DIR/kithmoot-blossom.service"
systemctl daemon-reload
systemctl enable kithmoot-blossom >/dev/null
systemctl restart kithmoot-blossom

echo "==> waiting for the server"
up=0
for _ in $(seq 1 30); do
  # An upload with no authorisation is refused with 401: the server is up.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$PORT/upload" || true)"
  if [[ "$code" == "401" ]]; then up=1; break; fi
  sleep 1
done
if [[ "$up" -ne 1 ]]; then
  echo "blossom-install.sh: kithmoot-blossom did not answer on 127.0.0.1:$PORT within 30s" >&2
  journalctl -u kithmoot-blossom -n 20 --no-pager >&2 || true
  exit 1
fi
echo "==> kithmoot-blossom is up on 127.0.0.1:$PORT; blobs on $MNT ($(df -h --output=size,avail "$MNT" | tail -1 | xargs) size/free)"
echo "    now the Caddy side: the /upload and /blossom/* handles in deploy/Caddyfile.kithmoot"
