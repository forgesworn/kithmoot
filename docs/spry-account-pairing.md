# Spry on your devices

Update desktop to 0.1.105 and Android to 0.6.112, or use the current web app.
Sign in with the same Nostr account on each device. Install/open Spry on your
node, choose **Pair with KithMoot**, open the KithMoot app and approve **Pair
Spry**. Its account pairing then follows your other signed-in devices through
your configured account relays. Those devices do not need another pairing code.

An existing local pairing made under that Nostr account can be shared using
**Settings → Connections → Spry → Sync Spry** while signed in. This also retries a refused or unavailable
signer/relay. A guest pairing stays on that device. The browser handoff offers
**Open KithMoot app** and a locally drawn Android QR for a device without the
account. Each such guest app needs a fresh one-use code.

Spry's handoff offers **Open KithMoot app** and **Copy pairing link**. Safari
does not need to sign into KithMoot: open the installed app where you are
already signed in. Desktop 0.1.105 and the current web app also accept a
copied app or web link in **Settings → Connections → Spry → Spry pairing
link**. Paste it and choose **Pair Spry**, then approve the node shown.
The one-use code is cleared from the input before the request and is never
stored as settings. Android 0.6.112 already opens the native pairing link;
use the link or local Android QR when its app is not signed into that account.

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

## Which rooms share your relay

A device paired over HTTPS shares its call relay automatically only in rooms
it made: it holds the room's root inviter key, so `isRoomAuthority()` is true
when the room's session starts. A room made on another of your devices does
not count on this one. In any other room, **Privacy and connection** shows
**Share my call relay here**; the choice is kept per person and room on this
device (`kithmoot.spry-share.v1`) and is never synced or put in a link.
Turning it off stops publishing the room's offer and asks the node to remove
the grant, so access already handed out ends within five minutes. A private
`spry:` pairing keeps sharing in every room, as the private mesh needs; its
offers work only for devices paired to the same node.

Where it shares, the app registers each present member's room Spry key (the
`spryKey` in their roster entry) with the node, and asks the node to seal the
grant once no present device lacks one, so a copied token alone no longer
gets relay access (spry-turn
`docs/design/2026-10-28-room-grant-seal-and-advert-privacy.md`). Members
already on a call vouch for a device that joins it, so the room's relay keeps
working while the owner is away.
