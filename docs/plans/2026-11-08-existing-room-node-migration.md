# Existing rooms on a KithMoot node

Owner request, 8 November 2026: retain the existing rooms, history and access
while using the owner's Archy for messaging, STUN and TURN. Desktop, Android
and web run simultaneously in the same rooms. No live migration or public
TURN closure has run. The clipboard fix is separately held in Archy draft PR54.

## Contract

- The room secret, room id, root authority, participant identities, epoch,
  archive, name, original expiry and self-destruct choice remain unchanged.
- An independently signed existing-room node profile preserves client file
  features; strict node-room/1 remains files-off and self-destructing. Older
  readers refuse the distinct profile. No new node file-storage service.
- The root authority chooses one paired node. Account pairing alone cannot
  change a room and a delegated inviter cannot authorise its migration.
- Owner steering later on 8 November prioritises moving rooms first and
  resolving issues afterwards. Provision the destination and current device
  grants, publish the root-signed destination through encrypted source control,
  and let updated desktop, Android and web devices follow independently.
  An offline client does not block the other devices. Defer a device's route
  change until its active call ends. Keep its source recovery material.
- The optional prepare/ready/commit coordinator remains available as a tested
  foundation; it is not a prerequisite for this cutover. Never treat missing
  delivery acknowledgements as proof that another device moved successfully.
- A selected node route remains pinned: node outage must not silently send its
  traffic through public relays or public STUN/TURN. Public TURN stays available
  to rooms and clients that have not moved until real mixed-client calls pass.
- Preserve archives and queued messages. Do not re-sign, extend expiry or
  publish quiet-room events as bare events. Backfill reports bounds and any
  missing data rather than claiming complete history from an empty read.
- Persist preparation, grants, progress and selection before dependent
  effects so restart can reconcile uncertain acknowledgements. Source data
  and room recovery material remain intact throughout.

## Operating and privacy boundary

This is an operator-selected private node, not a new ForgeSworn public relay
or credential broker. Archy receives encrypted room events and admitted
device identifiers. It does not receive room, account, epoch or media keys.
Existing node retention/storage limits remain in force; original signed
expiries cannot be extended in migration. A targeted legal-cover gap check
and factual privacy wording accompany the final client integration.

## Acceptance

Shared TypeScript/Kotlin vectors; real signed grant and relay history tests;
interrupted/uncertain copy and commit recovery; stale/forged/other-room and
other-node refusals; simultaneous desktop/Android/web and a second participant;
history and file metadata preserved; two-minute bidirectional media using
Archy; TURN-renewal and reconnect tests with other clients still connected.
Physical GrapheneOS and owner accounts remain distinct acceptance evidence.

The standalone KithMoot room migration controls need client review and test
captures. They do not change Archipelago screens. The separate Archy dashboard
clipboard change remains subject to its existing review pack: Maintainer must
review and approve UI work on Archy KithMoot node Settings before merging or
approval. ZAT pending. A backend-only private image upgrade must preserve the
running controller and dashboard bytes exactly.

## Implementation status

Protocol, relay and client transition foundations are under development. No
client UI or automatic room migration is enabled yet. Original policy is signed
in the destination and reproduced by TypeScript/Kotlin shared vectors. Browser
staging preserves the original device key, room identity and recovery link,
seeds original membership and grants current devices before activation. Full
browser/desktop and Android runtime wiring, quiet carrier history, offline
catch-up and real mixed-client media acceptance remain outstanding.

The private Linux relay was built on Archy from Bothy 93dabf4 with locked,
offline vendored dependencies and Rust 1.94.1, one job, release LTO disabled to
bound RAM. This is a private engineering candidate, with no new throughput
claim. The node ledger upgrades to schema 2 and Bothy's store to schema 4;
rollback requires the stopped state-volume backup as well as the old image.
