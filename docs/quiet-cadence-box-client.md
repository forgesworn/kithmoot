# Quiet cadence box client

This slice implements KithMoot's phone-owned side of the Vennel G7 cadence
contract. It does not make box cadence available in the product yet.

`src/box-cadence.ts` owns the byte-level control contract. It builds the fixed
Kith profile, derives a finite table of public room drop keys, creates the
lease, queue, status, stop and withdraw bodies, and signs their exact bytes as
NIP-98 kind 27235 events. The server name is the pinned Link node id. Every
request is intended for an authenticated ordinary Link session; there is no
HTTPS or public-relay fallback.

The room epoch key and derived private drop scalars stay in the client. A lease
contains only public drop keys for `[start_epoch, end_epoch)` and one device's
eight-counter half. The first epoch is at least two hours ahead and a lease is
bounded to seven days.

`app/src/cadence-store.ts` is the durable ownership handoff. It writes the
exact request bytes and marks the range `client-excluded` before returning the
request to a caller. A timeout does not release that exclusion: the client must
retry the exact bytes or ask the box for the exact lease status. A matching
receipt transfers the record to `box-owned`; only an `ended` receipt releases
the range. Damaged state fails closed.

KithMoot pins `nostr-deaddrop` 0.3.x. Its `reservedCounters(epoch)` callback is
consulted for every live phone draw, including after an epoch rollover. The app
wires that callback to the durable records, so the phone cannot reuse a key it
may have delegated to a box.

The shared Rust/TypeScript fixture is `vectors/cadence-v1.json`. Tests reproduce
Bothy's exact lease and queue JSON, SHA-256 payloads and NIP-98 Authorization
headers, and cover restart, timeout, receipt, overlap and rollover behaviour.

Production activation still needs:

- a browser-capable ForgeSworn Link client that connects only through a
  verified, pinned box card;
- an active Bothy event route and circle grant for the same persona, room and
  device;
- Bothy's separate cadence store-key provider;
- both Tor and I2P cadence carriers;
- scheduler, queue reconciliation, rekey, revocation and composed acceptance
  across KithMoot, Bothy and the public relays.

Until those exist, no UI calls `prepareCadenceLease` and Bothy's cadence router
is not mounted. Ordinary phone-owned quiet cadence remains the only active
mode.
