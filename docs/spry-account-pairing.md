# Spry on your devices

Update desktop to 0.1.104 and Android to 0.6.112, or use the current web app.
Sign in with the same Nostr account on each device. Install/open Spry on your
node, choose **Pair with KithMoot**, open the KithMoot app and approve **Pair
Spry**. Its account pairing then follows your other signed-in devices through
your configured account relays. Those devices do not need another pairing code.

An existing local pairing can be shared using **Settings → Connections →
Spry → Sync Spry** while signed in. This also retries a refused or unavailable
signer/relay. A guest pairing stays on that device. The browser handoff offers
**Open KithMoot app** and a locally drawn Android QR for a device without the
account. Each such guest app needs a fresh one-use code.

The shared account record contains the Spry endpoint, pairing id and pairing
authority key. It is signed by the account and NIP-44 encrypted to that same
account. Relay operators cannot read it; devices authorised to decrypt the
account's private data can. Nostr private keys, room keys, media keys and the
devices' call keys are not part of this record. TURN credentials remain
short-lived and are obtained separately for each device.

**Unpair Spry** revokes this shared pairing at the node and publishes an
encrypted removal for the account. Existing call credentials can take up to
five minutes to expire. Signer/relay failures retain a retryable removal;
older known records cannot replace a newer removal. A relay can withhold the
latest record from a fresh device, but it cannot restore access revoked at the
node. Account sign-out closes its subscription and invalidates late results.

Both implementations use kind 30078, address `kithmoot.connections.v1`, and
the generic label `kithmoot.private-settings.v1`. The encrypted payload is
`{v:1, at:<event created_at>, pairing:<v1 Spry pairing or null>}`. NIP-01's
newest timestamp, then lowest event id, determines replacement. Endpoint,
credentials and room identifiers never appear in public tags. Caches retain
signed encrypted records and pending publications; Android also encrypts its
cache at rest. Account publication follows the existing transport policy,
including Android's account write hold for Tor-only rooms.

Pairing config sync does not provide a network route to a private node. Each
device still needs to reach its paired relay; private home calls still use
their existing node mesh. Spry's Rust runtime and Archipelago's authority,
identity and lifecycle adapters are unchanged by account sync.
