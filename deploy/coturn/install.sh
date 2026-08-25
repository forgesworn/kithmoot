#!/usr/bin/env bash
set -euo pipefail

# install.sh - stand up (or update) the KithMoot TURN server on a box.
#
# Runs ON the target box, as root, from the directory it was rsynced into.
# deploy/turn-deploy.sh is the local driver that puts the files there and
# calls this; running it by hand is fine, but that script is the record of
# what a deploy actually consists of.
#
# Idempotent by design. Re-running it re-renders the config, re-applies the
# firewall rules and restarts the services; it never regenerates the shared
# secret once one exists, because doing so would invalidate every credential
# already minted and silently break every call in progress. Rotating the
# secret is a deliberate act: delete /etc/kithmoot/turn-secret and re-run.
#
# What it touches, and nothing else - this is a shared box with other
# tenants on it:
#   /etc/kithmoot/                       config and secrets for this service
#   /opt/kithmoot-coturn/                the compose project
#   /opt/kithmoot-turn/                  the credential service's tree
#   /etc/systemd/system/turn-credentials.service
#   /etc/systemd/system/kithmoot-turn-certs.{service,timer}
#   ufw rules for this service's ports
# It does not write to /etc/caddy: the vhost is installed by deploy.sh
# --install-caddy, which validates the whole config first.

HOSTNAME_TURN="${HOSTNAME_TURN:-kithmoot.forgesworn.dev}"
SITE_ORIGIN="${SITE_ORIGIN:-https://${HOSTNAME_TURN}}"
SERVICE_USER="${SERVICE_USER:-kithmoot-turn}"
COTURN_DIR="${COTURN_DIR:-/opt/kithmoot-coturn}"
TURN_SVC_DIR="${TURN_SVC_DIR:-/opt/kithmoot-turn}"
ETC_DIR=/etc/kithmoot
SECRET_FILE="$ETC_DIR/turn-secret"
TTL_SECONDS="${TTL_SECONDS:-3600}"
CRED_PORT="${CRED_PORT:-8089}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "$(id -u)" -eq 0 ]] || { echo "install.sh: needs root (it writes /etc and manages systemd)" >&2; exit 1; }

# turn-deploy.sh rsyncs this whole directory to $COTURN_DIR and then runs
# this script from inside it, so for the normal path source and destination
# are the same file and `install` refuses. Running it from a separate
# staging directory is still supported, and then the copy is real.
place() {
  local src="$1" dest="$2" mode="$3"
  if [[ "$src" -ef "$dest" ]]; then
    chmod "$mode" "$dest"
  else
    install -m "$mode" "$src" "$dest"
  fi
}

echo "==> service user"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "    created $SERVICE_USER"
else
  echo "    $SERVICE_USER exists"
fi
svc_uid="$(id -u "$SERVICE_USER")"
svc_gid="$(id -g "$SERVICE_USER")"

# The address clients will be told to relay through. Taken from the default
# route rather than an external echo service, so this works on a box with no
# outbound internet and cannot be answered wrongly by something in the middle.
public_ip="${PUBLIC_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)}"
[[ -n "$public_ip" ]] || { echo "install.sh: could not detect the public IPv4 address, set PUBLIC_IP=" >&2; exit 1; }
echo "==> public address: $public_ip"

# A relay candidate on an address the hostname does not resolve to is a
# connection that never completes, and the symptom (ICE just fails) points
# nowhere near the cause. Check it here, where the message can say so.
resolved="$(getent ahostsv4 "$HOSTNAME_TURN" | awk '{print $1}' | head -1 || true)"
if [[ "$resolved" != "$public_ip" ]]; then
  echo "install.sh: $HOSTNAME_TURN resolves to '${resolved:-nothing}', but this box is $public_ip." >&2
  echo "  A TURN client would connect to one address and be handed relay" >&2
  echo "  candidates on another. Fix DNS, or set HOSTNAME_TURN to a name" >&2
  echo "  that does point here, before running this." >&2
  exit 1
fi

echo "==> $ETC_DIR"
install -d -m 0755 "$ETC_DIR"
install -d -m 0755 "$ETC_DIR/coturn"
install -d -m 0755 "$ETC_DIR/certs"

echo "==> shared secret"
if [[ ! -s "$SECRET_FILE" ]]; then
  # umask before the redirect: the file must never exist, even briefly, at
  # a mode another user could read.
  ( umask 077; openssl rand -hex 32 > "$SECRET_FILE" )
  chown root:root "$SECRET_FILE"
  chmod 0600 "$SECRET_FILE"
  echo "    generated a new secret"
else
  echo "    reusing the existing secret (delete $SECRET_FILE to rotate)"
fi
secret="$(cat "$SECRET_FILE")"

echo "==> coturn config"
# The secret goes in with a shell builtin, never as an argument to sed or
# any other command: an argument is visible in `ps` to every user on the box
# for as long as the process runs. The template's placeholder line is
# dropped and a real one appended instead.
umask 077
{
  sed -e "s|CHANGE_ME_PUBLIC_IP|${public_ip}|g" \
      -e "/^static-auth-secret=/d" \
      -e "s|^realm=.*|realm=${HOSTNAME_TURN}|" \
      -e "s|^server-name=.*|server-name=${HOSTNAME_TURN}|" \
      "$here/turnserver.conf"
  printf 'static-auth-secret=%s\n' "$secret"
} > "$ETC_DIR/coturn/turnserver.conf.tmp"
chown "$SERVICE_USER:$SERVICE_USER" "$ETC_DIR/coturn/turnserver.conf.tmp"
chmod 0600 "$ETC_DIR/coturn/turnserver.conf.tmp"
mv -f "$ETC_DIR/coturn/turnserver.conf.tmp" "$ETC_DIR/coturn/turnserver.conf"

echo "==> credential service environment"
{
  printf 'TURN_SECRET=%s\n' "$secret"
  printf 'TURN_URLS=turn:%s:3478,turn:%s:3478?transport=tcp,turns:%s:5349\n' \
    "$HOSTNAME_TURN" "$HOSTNAME_TURN" "$HOSTNAME_TURN"
  printf 'TURN_TTL_SECONDS=%s\n' "$TTL_SECONDS"
  printf 'ALLOWED_ORIGINS=%s\n' "$SITE_ORIGIN"
  printf 'PORT=%s\n' "$CRED_PORT"
} > "$ETC_DIR/turn-credentials.env.tmp"
chown "$SERVICE_USER:$SERVICE_USER" "$ETC_DIR/turn-credentials.env.tmp"
chmod 0600 "$ETC_DIR/turn-credentials.env.tmp"
mv -f "$ETC_DIR/turn-credentials.env.tmp" "$ETC_DIR/turn-credentials.env"
umask 022

echo "==> TLS certificate from Caddy's store"
place "$here/sync-certs.sh" "$COTURN_DIR/sync-certs.sh" 0755
HOSTNAME_TURN="$HOSTNAME_TURN" SERVICE_USER="$SERVICE_USER" "$COTURN_DIR/sync-certs.sh"

echo "==> compose project"
place "$here/docker-compose.yml" "$COTURN_DIR/docker-compose.yml" 0644
# Not a secret, just the uid the container runs as. Compose reads .env from
# beside the compose file for ${...} substitution.
{
  printf '# Generated by deploy/coturn/install.sh. The uid/gid the coturn\n'
  printf '# container runs as, so the config holding the shared secret can be\n'
  printf '# 0600 and owned by one dedicated user rather than group-readable.\n'
  printf 'KITHMOOT_TURN_UID=%s\n' "$svc_uid"
  printf 'KITHMOOT_TURN_GID=%s\n' "$svc_gid"
} > "$COTURN_DIR/.env"
chmod 0644 "$COTURN_DIR/.env"

echo "==> firewall"
# Read out of the rendered config rather than repeated here: a relay range
# that is open in coturn but closed in ufw fails in the least obvious way
# possible, with allocations succeeding and media silently going nowhere.
min_port="$(sed -n 's/^min-port=//p' "$ETC_DIR/coturn/turnserver.conf")"
max_port="$(sed -n 's/^max-port=//p' "$ETC_DIR/coturn/turnserver.conf")"
[[ -n "$min_port" && -n "$max_port" ]] || { echo "install.sh: no min-port/max-port in the rendered config" >&2; exit 1; }
ufw allow 3478/udp comment 'KithMoot TURN' >/dev/null
ufw allow 3478/tcp comment 'KithMoot TURN' >/dev/null
ufw allow 5349/tcp comment 'KithMoot TURN over TLS' >/dev/null
ufw allow "${min_port}:${max_port}/udp" comment 'KithMoot TURN relay range' >/dev/null
echo "    3478/udp, 3478/tcp, 5349/tcp, ${min_port}-${max_port}/udp"

echo "==> coturn"
docker compose --project-directory "$COTURN_DIR" up -d
docker compose --project-directory "$COTURN_DIR" restart >/dev/null

echo "==> credential service dependencies"
# --omit=dev: the service runs the already-built dist/src/turn.js, so it
# needs the runtime deps and not the toolchain that produced it.
( cd "$TURN_SVC_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 )

# Owned by whoever ran the deploy, readable by everyone, writable by the
# service user by nothing. Two reasons it is not chowned to kithmoot-turn:
# the next deploy rsyncs into this directory as the deploy user and would
# get permission denied, and a service that can rewrite its own code is a
# strictly worse position than one that can only read it. npm ci above runs
# as root, so the chown also undoes that.
owner="${SUDO_USER:-root}"
chown -R "$owner:$(id -gn "$owner")" "$TURN_SVC_DIR"
chmod -R a+rX "$TURN_SVC_DIR"

echo "==> systemd units"
install -m 0644 "$here/units/turn-credentials.service" /etc/systemd/system/turn-credentials.service
install -m 0644 "$here/units/kithmoot-turn-certs.service" /etc/systemd/system/kithmoot-turn-certs.service
install -m 0644 "$here/units/kithmoot-turn-certs.timer" /etc/systemd/system/kithmoot-turn-certs.timer
systemctl daemon-reload
systemctl enable --now kithmoot-turn-certs.timer
systemctl enable turn-credentials
systemctl restart turn-credentials

echo "==> done"
