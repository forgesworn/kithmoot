# KithMoot protocol draft: v1 profile, M2

Status: project draft, not an accepted NIP or a claim of registered kind
ownership. Published by `forgesworn/kithmoot`. The reference and independent
Kotlin implementation consume the same [interop vectors](../vectors/README.md).
This freezes existing KithMoot event numbers and adds compatible signalling
metadata. Existing readers remain supported indefinitely.

This document and its normative companions constitute the draft:

- [Persistent groups](persistent-groups.md): v3 admission, retirement, owner
  recovery and the distinction between admission and epoch authority.
- [Messages](messages.md), [reactions](chat-reactions.md): channel derivation,
  edits, retractions, threads, mentions, DM invitations and read positions.
- [Agents](agents.md): ownership, sender consent, approvals, room authority,
  channels, file announcements and the Wildbloom envelope contract.
- [Shared context](context.md) and [shared assignments](den-assignments.md):
  current M1 review/execution shapes carried through the existing channels.
- [Service admission](protocol/service-admission.md): reserved pass/policy
  shapes. No consumer enforces them in M2.
- [Vectors](../vectors/kithmoot-vectors.json): exact input/output bytes and
  negative cases. Secrets in that file are synthetic fixtures, never credentials.

An implementation MUST read these contracts together. Reject an invalid signed
statement; do not repair its security-relevant fields. Preserve unknown optional
fields only where a companion expressly defines extensibility. A UI projects
untrusted input onto named fields. Nothing in this draft authorises executing
text received from a relay, a file or another member.

## Identities and trust boundaries

A participant is a person or an agent; a device is an endpoint acting for that
participant in one room. Device credentials bind a device to a participant, room
and expiry. Participant secrets never go to relays, forwarders or stores. Device
keys MUST be scoped to rooms. A member can have several devices without becoming
several people. Agents carry a principal's verified ownership attestation; their
ability to read or act remains constrained by sender consent and explicit
approvals. Possession of a room key does not grant room-authority privileges.

Relays see event kinds, event authors, recipient/room selectors, sizes and timing.
Current roster events reveal per-room device public keys and opaque room selectors;
signalling wraps reveal their recipient device keys. Room rekeys reveal the room
selector, authority and epoch metadata. Encryption hides payloads, not these
observations, and does not prevent timing correlation. No claim of anonymous
network transport or unlinkability against all colluding observers is made.

Services are optional and replaceable. A forwarder carries encrypted media and
never receives a room traffic key. TURN provides connectivity; a Blossom store
holds encrypted files. A Bothy node is the preferred optional archive host in M3
and optional nudger host in M5. Neither is required to create or use a room.

## Primitives and encoding

Use NIP-01 canonical event IDs and BIP-340 signatures, NIP-44 v2 encryption and
HKDF-SHA256. Event timestamps and expiries are integral Unix seconds. JSON is
UTF-8; compact encoding is used inside encrypted payloads. Hex writers emit
lower case. Existing key readers compare hex case-insensitively where the
vectors specify it. New service scopes require canonical lower-case identifiers.

A room starts with a random 32-byte secret. Derive two independent 32-byte values
using HKDF-SHA256 with that secret as IKM, an empty salt and UTF-8 info:

| Info | Output |
|---|---|
| `kithmoot/v1/room-id` | Lower-case hex room ID |
| `kithmoot/v1/room-key` | Room encryption key |

Never substitute the room secret directly for either derived value. Channel
keys/selectors, epoch keys and media keys have separate domains; their canonical
inputs and outputs are pinned by the companion contracts and vector groups
`channelDerivation`, `roomEpoch`, `roomDescriptor` and `verificationWords`.

Transport receives NIP-01 events through REQ subscriptions, verifies signed
events and closes each subscription when its owner leaves. Publish to chosen
writable relays and read chosen readable relays. A relay is not authoritative
merely because it supplied an event. Duplicate relay delivery must not repeat a
message, action or negotiation. Regular events may be replayed; ephemeral events
must not be relied upon as storage.

## Kind table

The [registration file](protocol/kind-registration.json) prepares project entries;
submission to the upstream registry is separate. Existing numbers do not change.

| Kind | Meaning | Visibility and persistence |
|---|---|---|
| 1460 | Chat and named-channel messages | Room/channel ciphertext; regular |
| 1461 | Invitation retirement | Creator-signed tombstone; regular |
| 1462 | Room rekey | Authority-signed, prior-epoch ciphertext; regular |
| 1463 | Group invitation | Creator-signed, bearer-derived ciphertext; regular |
| 20460 | Device credential | Participant-signed inner event; never published bare |
| 20461 | Roster | Device-signed room ciphertext; ephemeral |
| 20462 | KithMoot signal | Signed inner event or sealed rumor; never published bare |
| 20463 / 20464 | Device pairing request / grant | Room ciphertext; ephemeral |
| 20465 | Room descriptor | Room ciphertext; ephemeral |
| 20466 / 20467 | Legacy invitation request / grant | Capability/requester ciphertext; ephemeral |
| 20468 / 20469 | Epoch request / grant | Authority/device ciphertext; ephemeral |
| 20470 | Member pass | Reserved signed presentation; no automatic relay publication |
| 21059 | Ephemeral signal wrap | Shared upstream kind; recipient-addressed ciphertext |
| 30460 | Service policy | Reserved addressable event; no publication in M2 |
| 30461–30469 | Service policy expansion | Reserved only; no semantics assigned |
| 30078 | Read positions | NIP-78, label `kithmoot.read.v1`; own-account ciphertext |
| 1063 / 24242 | File metadata / Blossom authorisation | Existing file standards, unchanged |
| 9734 / 9735 | Zap request / receipt | Existing payment standards, unchanged |

RelaySwarm's 24170 and 24171 are documented alongside these entries for collision
avoidance. They remain RelaySwarm's protocol and are not KithMoot call events.
Neither their payloads nor Link's rendezvous-tag format is imported by this draft.

## Room links and admission

A link carries its capability only after `#`, encoded as unpadded base64url of
UTF-8 JSON. The HTTP request never carries the fragment. Fields are `r` (relay
URLs), `i` (ICE URL hints), optional `a` (admission policy), `n` (display name),
and `c` (one-use device pairing code). A fragment is at most 16 KiB. At most eight
relay and eight ICE hints and 256 policy keys are accepted. Public relays require
`wss`; plain `ws` is retained for loopback development. Hints do not override
signature checks or room membership.

New room creation emits v3: `{v:3,j:<32-byte bearer base64url>,h:<inviter pubkey>,r,i}`.
The creator saves owner recovery and publishes kind 1463 before offering durable
admission. Its `d` selector is HKDF-SHA256(bearer, empty salt,
`kithmoot/v2/invitation-id`, 32), hex encoded. Its encryption key uses the separate
info `kithmoot/v3/group-invitation-key`. The decrypted body is
`{v:3,room:<room ID>,secret:<base64url initial secret>}`. The signature MUST match
the pinned inviter. A valid retirement wins over the invitation. This record
carries epoch zero only; it cannot override removal or mint authority.

Readers MUST continue accepting v2 (`v:2,j,h`) and v1 (`s:<room secret>`, with no
version) indefinitely. Resharing an existing room preserves its capability and
version. In particular, an old keeper state file is not silently converted to a
durable invitation. A creator's explicit conversion to a group issues a fresh
bearer while retaining the conversation and authority. New v3 membership does
not hand an inviter/delegation signing key to a joining member.

An admission policy is `{tier,admitted?,agents?,members?}`. `tier` is `open`,
`ken`, `kith` or `kin`; `agents`, when present, is `owned-by-members`. `members`
is an explicit participant restriction. Unsupported/malformed policy means
reject the link, never an open room. The `accessEvaluation` and `kindredProof`
vectors define the recognised proof and expiry cases.

## Credentials, roster and room state

A kind-20460 credential has empty content and tags `d` = room ID, `device` =
device public key, `expiration` = Unix seconds. It is signed by the participant.
It travels inside the encrypted roster, never as a public participant-to-device
mapping. Check signature, room, device and expiry before attributing any track,
message or action to that participant. Pairing grants only a room-scoped,
expiring credential; it must not copy the participant secret to the new device.

The roster is kind 20461, signed by the device, tagged `d` with the current
room/epoch selector, and NIP-44-encrypted with the current room/epoch key. Its
inner credential must agree with the outer author. `updatedAt`, tracks, claims,
name, verified ownership and optional assist advertisement are interpreted by
`rosterEvent` vectors. A farewell uses `left:true`. Presence expires; replayed
presence is not a permanent guest list. New arrivals announce and existing
members answer because relays need not retain presence.

A descriptor (20465) contains forwarder references and ICE configuration under
the room key. It does not replace the invitation admission policy. A forwarder
reference names its signalling relay and public key; unrecognised properties do
not create capabilities. The old descriptor and first-offer shapes stay valid
without a ticket or policy event.

Rekeys and the encrypted control channel are authority-bound. A room advances
one verified epoch at a time; a removed device can read the removal notice but
cannot recover a next-epoch secret addressed only to remaining devices. The
`roomEpoch` vectors include wrong authority, missing recipients and epoch gaps.
Clients that cannot follow an epoch must say so rather than display a quiet,
empty room. Android capability gaps are recorded in the compatibility ledger;
passing M2 codecs does not implement features it did not previously support.

## Call signalling profile 1

The credited envelope model is [NIP-AC, revision 31c7a41](https://github.com/vitorpamplona/nips/blob/31c7a410dc4bfea12e127b1065e3dcd1ad150d58/AC.md).
[NIP-59](https://github.com/nostr-protocol/nips/blob/c3fd9af17939316bf6d0d83a5759100f8b0a1bdb/59.md)
and [NIP-40](https://github.com/nostr-protocol/nips/blob/c3fd9af17939316bf6d0d83a5759100f8b0a1bdb/40.md)
are pinned in [upstream.json](protocol/upstream.json). KithMoot is envelope-compatible
with that NIP-AC draft, not live-call interoperable: its inner kind is 20462,
its recipients are room devices and its room-derived call ID is not NIP-AC's
per-call UUID. The roster supplies the participant-to-device mapping privately.

Writers keep the existing seal-less envelope:

1. Sign a kind-20462 inner event with the room device key. Its content is a
   `SignalBody` JSON object: `type` = `offer`, `answer`, `ice` or `assist`;
   `roomId`; optional `sdp`, JSON-string `candidate`, `trackHints`, `tier`,
   `assist` (far-end device) and `accept` (assist response boolean).
2. Include inner tags `p` = recipient device, `call-id` = room ID,
   `alt` = `KithMoot call signalling`, and `kithmoot` = `1`.
3. Generate a fresh ephemeral signing key for each wrap. NIP-44-encrypt the
   complete signed inner event to the recipient using that ephemeral key.
4. Sign kind 21059 with the ephemeral key, tagging only `p` = recipient and
   `expiration` = inner creation time + 60 seconds. Sample creation time once
   for both emitted layers. Do not place the room ID or sender in public tags.

The 60-second expiry is a relay-retention hint, not the acceptance window. Local
staleness stays at ±20 seconds around the innermost signed time. Both numbers
include their specified boundary exactly; at expiry, a future service pass is
expired. A relay can ignore expiry, so receivers must still check staleness.

Receivers accept both the emitted shape and NIP-59-style seals:

1. Bound wrap content at 131,072 characters and bound crypto attempts before
   identifying the sender. Verify the outer signature. Duplicate outer IDs may
   be discarded before crypto.
2. Decrypt one layer. If its kind is 20462, verify the inner signature. If its
   kind is 13, verify the seal signature, decrypt its content with the seal
   author's shared key, and require a kind-20462 rumor with the same public
   key as the seal. Recompute the rumor's canonical ID. Any other kind fails.
3. On either path, check the innermost time, room binding and recipient. If a
   `call-id` tag exists it must be unique and equal the room ID. Absence is
   accepted for old writers. `alt` and profile tags are descriptive; future
   unknown profile tags do not silently enable new wire semantics.
4. Deduplicate the innermost event ID across fresh rewraps and both envelope
   forms. Randomised seal/wrap timestamps are never substituted for inner time.
5. Apply sender rate limits and roster/authority checks before negotiating.

The implementation budgets 4,096 unwrap attempts per room per 20 seconds and
120 accepted signals per sender per 20 seconds. Replay tables are bounded at
4,096 entries. These are local resource bounds, not proof against denial of
service: a malicious relay can consume the budget or withhold legitimate events.
Independent relays remain a resilience choice. A reconnect or new ephemeral
sender key must not bypass the room budget. Accepting two receive forms does
not change what old clients receive: writers still emit one seal-less form.

NIP-AC's offer/answer/candidate meanings correspond to 25050/25051/25052. Those
numbers are reserved for a future explicit compatibility decision after upstream
settles; M2 neither emits them nor pretends a 20462 body is their payload. Assist
stays on 20462. A weekly independent workflow reports changes to the pinned
upstream texts and relevant registry entries; it cannot change production code
or block every ordinary PR because a draft moved.

## Files, payments and ecosystem compatibility

Wildbloom files retain FSWNENC2, FSWNENC1 and WBLMENC1 read support. Recovery keys
travel inside encrypted chat/context, never in public kind-1063 metadata or
Blossom requests. Verify the envelope hash before decrypting. Upload signing
continues to use the room device key. M2 introduces no store allowlist, account
requirement, participant-key signing or compulsory Bothy service.

V4V payment/zap behaviour and RelaySwarm discovery/signalling are unchanged.
Their numbers, formats and trust boundaries are not repurposed for KithMoot.
The compatibility ledger distinguishes direct consumers, shared formats and
planned integrations; shared branding is not evidence of an integration test.

## Reserved selector mode, not implemented

A future mode may use pair-scoped, per-epoch rendezvous tags, borrowing Link's
privacy principles rather than its tag format. No wire shape is frozen. It
needs KithMoot-specific Nostr-relay threat-model vectors, capability negotiation
and explicit authority-controlled room activation.

Old clients require `p`. Emitting both selectors retains those clients and still
reveals device keys; emitting tags alone excludes them. Until a negotiated mode
exists, relays continue learning the current per-room device keys. M2 changes
neither selectors nor subscriptions to hide that trade-off.

## Compatibility and release gate

Old-to-new and new-to-old reads must pass for signalling, links, chat, agents,
keeper state and forwarder offers. Shared Wildbloom vectors and attachment
journeys must remain valid. Android runs the same signal/pass/policy vectors.
Existing services must operate without redeployment or an authority policy.

See [M2 compatibility ledger](protocol/m2-compatibility.md) for commands, concrete
results and remaining physical/live gates. Protocol vectors, browser CI and an
APK build are separate evidence from installed-device acceptance and public
service behaviour. A feature absent from the old Android client is not claimed
as implemented merely because its vectors are copied into the repository.
