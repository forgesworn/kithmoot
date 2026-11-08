# Existing rooms on a KithMoot node

Owner request, 8 November 2026: retain the existing rooms, history and access
while using the owner's Archy for messaging, STUN and TURN. Desktop, Android
and web run simultaneously in the same rooms. The private Archy backend has
been upgraded; no owner room migration or public TURN closure has run. The clipboard fix is separately held in Archy draft PR54.

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

The browser and standalone desktop path now prepares current valid device
credentials without a session-readiness barrier, ACKs node grants, publishes
one encrypted signed destination (bounded fragments only when required),
and lets each device follow independently. An active call delays only that
device. Each current device retrieves its own pre-authorised grant by NIP-98
proof; unknown/expired/revoked devices gain nothing. No grant or room key is
publicly discoverable. The source route and archives remain available locally.

A local Chromium acceptance test uses the actual native private relay and
supervisor with three independent contexts on one account plus a peer. All
four retain their room/device identities and history, exchange messages on
the node, and an old bookmark reopens after the keeper closes. TURN is
synthetic in this chat-only fixture: this is not Android, Electron or media
acceptance. Normal existing-room member epoch catch-up stays on the private
transport; strict new rooms retain keeper-only admission.

Android now has the same codec, original-record custody, independent follower
and owner move control under Privacy and connection. Focused node/runtime
checks, the full protocol suite and the full app unit suite pass. Lint and
APK packaging remain in progress. Original quiet policy, file settings,
removal state and agent admission evidence are retained. Node traffic uses
its quiet wrapper directly rather than delegating new writes to an old
external cadence box; old lease/counter/pending records remain for recovery.
Quiet carrier backfill, full history qualification, mixed-client media,
physical device and owner-account acceptance remain unproven. The optional
coordinated migration engine remains a tested foundation and is not activated.

The grant-id-optional existing-room access API is implemented, tested and
deployed on Archy. All 11 release files match the candidate manifest, all six
controller/dashboard files remain unchanged, and the public health readback
retains one room and ten devices. The current receipt is
docs/evidence/node-backend-archy-followup-20261108.json. JavaScript node checks
pass 174 tests; the real-relay browser test passes with the keeper offline.
Client releases, owner room migration and physical media proof remain pending.

The private Linux relay was built on Archy from Bothy 93dabf4 with locked,
offline vendored dependencies and Rust 1.94.1, one job, release LTO disabled to
bound RAM. This is a private engineering candidate, with no new throughput
claim. The node ledger upgrades to schema 2 and Bothy's store to schema 4;
rollback requires the stopped state-volume backup as well as the old image.
