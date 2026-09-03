#!/usr/bin/env bash
set -euo pipefail

# announce.sh - publish this endpoint as a kind 31402 service announcement so
# it is discoverable on 402.pub and payable by any 402-mcp client without
# anybody being told a URL.
#
# Uses aperture-announce, which reads aperture.yaml directly rather than
# keeping a second copy of the service definition - so the price announced is
# the price charged, always, and there is nothing to drift.
#
#   go install github.com/forgesworn/aperture-announce/cmd/aperture-announce@latest
#
# Usage:
#   ./announce.sh                  # publish once
#   ./announce.sh --dry-run        # print the event JSON, publish nothing
#   ./announce.sh --interval 6h    # stay up and re-publish on a timer
#
# Env:
#   ANNOUNCE_KEY    hex Nostr signing key. Optional, and that is a trap - see
#                   below. Set it.
#   ANNOUNCE_RELAYS comma-separated relays; default below.
#   PUBLIC_URLS     comma-separated URLs clients should call; default below.
#
# SET ANNOUNCE_KEY. aperture-announce generates a fresh key when it is
# omitted, which publishes an announcement nobody can tie to the last one: a
# kind 31402 is addressable by (pubkey, d-tag), so a new key each run means a
# new service in the directory every time rather than an update to this one.
# Generate one once, keep it, and keep it out of a personal identity - a
# service key that announces uptime and a price is a different thing from the
# key somebody posts with.
#
# Re-running with the same key republishes: the price in aperture.yaml is what
# goes out, so change the price there and re-run rather than editing anything
# here.

cd "$(dirname "$0")"

RELAYS="${ANNOUNCE_RELAYS:-wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net}"
URLS="${PUBLIC_URLS:-https://turn.forgesworn.dev}"

command -v aperture-announce >/dev/null 2>&1 || {
	echo "announce.sh: aperture-announce not on PATH." >&2
	echo "  go install github.com/forgesworn/aperture-announce/cmd/aperture-announce@latest" >&2
	exit 2
}

[[ -f aperture.yaml ]] || { echo "announce.sh: aperture.yaml not found beside this script" >&2; exit 2; }

if [[ -z "${ANNOUNCE_KEY:-}" ]]; then
	echo "announce.sh: ANNOUNCE_KEY is not set." >&2
	echo "  Without it aperture-announce invents a key, and this endpoint" >&2
	echo "  appears as a brand new service every time you run this rather" >&2
	echo "  than updating the existing listing. Generate one once:" >&2
	echo "    openssl rand -hex 32" >&2
	echo "  and keep it somewhere this box can read and nobody else can." >&2
	exit 2
fi

echo "announce.sh: announcing ${URLS} to ${RELAYS}" >&2

# ANNOUNCE_KEY stays in the environment and is never passed as --announce-key:
# argv is world-readable in /proc for as long as the process runs, and with
# --interval this process runs for ever.
ANNOUNCE_KEY="$ANNOUNCE_KEY" aperture-announce \
	--config aperture.yaml \
	--relays "$RELAYS" \
	--public-urls "$URLS" \
	"$@"

echo "announce.sh: done. Check it resolved at https://402.pub/" >&2
