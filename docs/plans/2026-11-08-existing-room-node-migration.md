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
- Prepare before cutover. Every currently connected endpoint (device and
  session id, including the three client kinds) must freeze source writes,
  obtain an acknowledged node grant, copy eligible original encrypted events
  unchanged and acknowledge readiness. New/unsupported endpoints block commit.
- A signed commit binds that exact preparation and every required endpoint's
  signed readiness. Missing acknowledgements, refusals, expiry, cancellation,
  account changes and incomplete history never mean success.
- Before readiness, cancellation restores source writes. After readiness,
  an uncertain client stays fenced until a verified shared decision; a signed
  abort and reconciliation path is still required. After commit, room
  traffic uses only the pinned node; outage must not route it to public
  relays, public STUN/TURN or peer forwarding. Keep rollback explicit.
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

Affected UI will include room hosting/migration and node settings. Prepare
exact builds, steps and captures for every material revision. Maintainer must
review and approve UI work on the existing-room node migration and node
settings screens before merging or approval. ZAT pending.

## Implementation status

Protocol, relay and client transition foundations are under development. No
client UI or automatic room migration is enabled. The transition engine,
strict archive snapshot, original-history copy/readback, encrypted fragments
and source publication fence have local tests. Source room policy, bearer
admission, quiet carriers, full app wiring and signed cancellation/recovery
must be finished before the feature is enabled. An expired preparation or a
missing acknowledgement must never silently reopen an uncertain source route.
