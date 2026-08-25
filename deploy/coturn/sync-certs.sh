#!/usr/bin/env bash
set -euo pipefail

# sync-certs.sh - copy the Let's Encrypt certificate Caddy already holds for
# the TURN hostname into a directory coturn can read, and restart coturn only
# if the bytes changed.
#
# Why this exists rather than certbot: Caddy serves the KithMoot site on 443
# for the same hostname, so it already issues and renews a certificate for it
# on its own. Running certbot alongside would mean two ACME clients competing
# for the same name, two renewal schedules, and a second chance to let one
# lapse. Caddy stays the only issuer; this just publishes a copy.
#
# Caddy's store is mode 0600 caddy:caddy and coturn does not run as caddy, so
# a copy is genuinely needed - a symlink into the store would not be readable.
#
# coturn reads cert and pkey once at startup and never re-reads them. Without
# the restart below, TURN over TLS would carry on serving the certificate it
# started with and begin failing handshakes about 60 days later, long after
# anyone connects the two events. The restart is skipped when nothing changed,
# so the daily timer does not drop live calls for no reason.
#
# Run by kithmoot-turn-certs.service, on the timer of the same name. Needs
# root: it reads Caddy's private key.

HOSTNAME_TURN="${HOSTNAME_TURN:-kithmoot.forgesworn.dev}"
CERT_DIR="${CERT_DIR:-/etc/kithmoot/certs}"
CADDY_STORE="${CADDY_STORE:-/var/lib/caddy/.local/share/caddy/certificates}"
SERVICE_USER="${SERVICE_USER:-kithmoot-turn}"
CONTAINER="${CONTAINER:-kithmoot-coturn}"

# The issuer directory name (acme-v02.api.letsencrypt.org-directory) is not
# guaranteed - Caddy would use a different one after a fallback to ZeroSSL or
# a staging endpoint - so find the pair rather than hardcoding the path.
src_crt="$(find "$CADDY_STORE" -type f -name "${HOSTNAME_TURN}.crt" -print -quit 2>/dev/null || true)"
if [[ -z "$src_crt" ]]; then
  echo "sync-certs: no certificate for ${HOSTNAME_TURN} under ${CADDY_STORE}." >&2
  echo "  Caddy issues it on first request to the site. Confirm the vhost is" >&2
  echo "  live and has been hit over https at least once, then re-run." >&2
  exit 1
fi
src_key="${src_crt%.crt}.key"
[[ -s "$src_key" ]] || { echo "sync-certs: found $src_crt but no matching .key beside it" >&2; exit 1; }

install -d -m 0755 "$CERT_DIR"

changed=0
sync_one() {
  local src="$1" dest="$2"
  if [[ ! -f "$dest" ]] || ! cmp -s "$src" "$dest"; then
    # Write to a temp name in the same directory and rename over the target,
    # so coturn can never read a half-written certificate if it happens to
    # start during the copy.
    install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$src" "$dest.tmp"
    mv -f "$dest.tmp" "$dest"
    changed=1
  fi
}

sync_one "$src_crt" "$CERT_DIR/fullchain.pem"
sync_one "$src_key" "$CERT_DIR/privkey.pem"

if [[ "$changed" -eq 1 ]]; then
  echo "sync-certs: certificate for ${HOSTNAME_TURN} updated, restarting ${CONTAINER}"
  # Absent on the very first run, when install.sh copies the certificate in
  # before starting the container at all. Not an error.
  docker restart "$CONTAINER" >/dev/null 2>&1 || echo "sync-certs: ${CONTAINER} not running, nothing to restart"
else
  echo "sync-certs: certificate for ${HOSTNAME_TURN} unchanged"
fi
