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
| 1460 | Chat and named-channel messages | Room/channel ciphertext, device-signed, or in envelope 2 signed by a one-time key (see Chat envelope 2); regular |
| 1461 | Invitation retirement | Creator-signed tombstone; regular |
| 1462 | Room rekey | Authority-signed, prior-epoch ciphertext; regular |
| 1463 | Group invitation | Creator-signed, bearer-derived ciphertext; regular |
| 1464 | Call bell | Throwaway-signed, daily room-derived tag, room/epoch ciphertext; regular with NIP-40 expiration |
| 1465 | Delivery receipt | Signed by a one-time key derived from the device key, chat stream `d`, stream-derived ciphertext; regular with NIP-40 expiration of at most seven days |
| 20460 | Device credential | Participant-signed inner event; never published bare |
| 20461 | Roster | Device-signed room ciphertext; ephemeral |
| 20462 | KithMoot signal | Signed inner event or sealed rumor; never published bare |
| 20463 / 20464 | Device pairing request / grant | Room ciphertext; ephemeral |
| 20465 | Room descriptor | Room ciphertext; ephemeral |
| 20466 / 20467 | Legacy invitation request / grant | Capability/requester ciphertext; ephemeral |
| 20468 / 20469 | Epoch request / grant | Authority/device ciphertext; a request carries an admission proof under the epoch-0 room key; ephemeral |
| 20470 | Member pass | Reserved signed presentation; no automatic relay publication |
| 20471 / 20472 | Member epoch request / grant | A request is device-signed ciphertext under a key derived from the epoch-0 room key, with the same admission proof as 20468; a grant is signed by a one-time key, sealed to the asking device, and carries the missed secrets with the authority's own 1462 rekeys as proof; ephemeral. See fold-kit's `docs/member-epoch-catch-up.md` |
| 21059 | Ephemeral signal wrap | Shared upstream kind; recipient-addressed ciphertext |
| 1059 | Quiet room drop | Shared upstream kind; a kind 1460 inside, addressed to a room-derived rendezvous key (`nostr-deaddrop` room case); regular |
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

**Conference rooms.** A group MAY end on a fixed date. Its body then also
carries `ends`, a positive integer of Unix seconds (`v` stays 3), and the 1463
event carries a NIP-40 tag `["expiration", "<ends>"]` with the same value, so
relays drop the invitation when the room ends. A creator MUST choose `ends`
after its own clock and no more than 30 days beyond it. A reader MUST reject
the invitation when `ends` is present and not a positive integer, when there is
more than one `expiration` tag, or when an `expiration` tag is present and is
not exactly the decimal of the body's `ends` (including when the body has no
`ends`). A body `ends` with no tag is valid. When two valid copies disagree,
the earlier `ends` stands. At or after `ends` the room is ended: a reader MUST
NOT join it and SHOULD tell a newcomer the date it ended. A re-signed
invitation keeps the same `ends`, and none is re-signed after it. A 1461
retirement of such a room carries the same `expiration` tag.

**Self-destruct.** The body MAY also carry `destruct: true`, after `ends`
and before `relays` (key order `v, room, secret, ends, destruct, relays`): when
the room ends, by its `ends` or by its authority closing it, every member's
device deletes what it signed for the room (NIP-09) and forgets the room. A
reader MUST reject the invitation when `destruct` is present and not `true`.
`destruct` without `ends` is valid. When two valid copies disagree, the flag
sticks: any valid copy that says it makes the room self-destruct. The closing
rekey (1462, `closed: true`) MAY carry the same flag inside its encrypted body,
after `closed`; it is believed only beside `closed`. It is never written on
the outside of an event, and a client SHOULD NOT add it to the plain-JSON 1461
retirement either, although fold-kit can. A reader that predates the field
ignores it and ends the room the old way. See fold-kit's
`docs/room-destruct.md` and [persistent-groups.md](persistent-groups.md#self-destructing-rooms).

**Room relays.** The body MAY also carry `relays`, after `ends` and
`destruct` (key order `v, room, secret, ends, destruct, relays`): the relays the room was made on, fixed
then and never changed. When present it MUST be an array of one to eight
distinct strings, each a safe relay URL (`wss://`, or `ws://` on loopback
only) already in canonical form - nostr-tools' `normalizeURL`, so
`wss://relay.example/` with its trailing slash - with no credentials. A
reader MUST reject the whole invitation otherwise, never trim it. Absent, the
body is byte-identical to one written before the field existed, and a reader
that predates it ignores the key. When two valid copies disagree, the newest
`created_at` that names any relays stands; a copy naming none says nothing
about them, and between equal timestamps the first heard stays. (Contrast
`ends`, where the earliest stands.)

**Room storage nodes.** The body MAY also carry `storage`, after `relays` (key
order `v, room, secret, ends, destruct, relays, storage`): the base URLs of the
group storage nodes the room's keeper grants at, in order of preference. It is
an array of zero to eight strings, no two with the same host name. Each is a
canonical node base URL, defined by grammar and pinned by fold-kit's
`storage-vectors.json`: `https`, or `http` only for `localhost`, a loopback
address `127.a.b.c` or an onion v3 host; a lower-case host; no default port
(`:443` on `https`, `:80` on `http`); no trailing slash (the root is written
with no path); no user info, query or fragment; path segments of letters,
digits and `. _ ~ -` only; at most 256 characters. A host whose last label is
all digits must be exactly four decimal octets. `[]` means the authority
withdrew every node; a body with no `storage` key says nothing about nodes and
is byte-identical to one written before the field. A reader MUST reject the
whole invitation when `storage` is present and is not such a list, never trim
it. When two valid copies disagree, the newest `created_at` that has the key
stands, `[]` included; a copy without it says nothing. Between equal
timestamps the first heard stays. `relays` and `storage` merge independently.
A reader that predates the field ignores the key, except fold-kit's strict
evidence reader before 0.14.0, which drops an envelope that carries it: a
keeper creating a room with storage therefore first publishes the same
invitation without `storage` one second earlier, so such a reader still has a
copy to admit from. The version stays 3.

The `storage` key in the invitation is signed by the room's authority and is
written from the keeper's `--group-node` flags, so the two cannot disagree. A
keeper republishes its last signed invitation byte for byte when nothing in its
body has changed since (a fresh copy per start would eventually exceed the 64
copies fold-kit's strict reader will hold), and signs a new one only when the
body changes. A room made by a browser has no keeper and so no grants; it never
carries `storage`. See the `storage` control op under
"Credentials, roster and room state" below, and the `roomStorage` vectors.

Every member's pool is the room's relays - these, then the relays its
authority's newest `relays` control op added - first, reading and writing,
never cut; then the member's own relays for the room, up to sixteen in all.
Own relays are what the cap cuts. So any two members share at least one
relay, whatever else each of them uses. A client chooses the room's relays,
in order: a signed invitation's `relays`, replacing any learnt from a link;
else the ones it already holds; else a link's `r`, on first sight (a
temporary room, or one made before the field). The creator fixes them from
the relays it both reads and writes, at most eight. A link names the room's
relays, then the op's, cut to eight, rather than its sharer's whole pool. A
member holding no signed list reads the invitation once after opening and
adopts its `relays`; the creator's six-hourly re-sign carries them into an
invitation written before the field.

Every event a member device signs for a conference room carries
`["expiration", "<ends>"]`: chat and its channels, reactions, edits and
retractions, roster and farewell entries, signal wraps, descriptors, call
bells, assignment envelopes, file announcements, read positions, and the
authority's rekey (1462), epoch request (20468) and grant (20469), and the
member epoch request (20471) and grant (20472). An event
whose own expiration is earlier keeps it (a signal wrap's 60 seconds, a call
bell's 120); a later one is lowered to `ends`; an event never carries two.
Account-level events (project directory, bookmarks) are not tagged, and a
device credential keeps its own expiry. Readers ignore the tag on decode; it
tells relays when to let the room go, and is not an access rule.

A kind 1461 retirement's content is `{v:1}`. When the room itself was ended,
not just the link replaced, it is `{v:1,ended:true}`. The field is additive:
readers MUST treat any valid `v:1` retirement as a retirement and MAY tell a
newcomer the room ended when `ended` is exactly `true`. A browser room with no
keeper is ended from the browser holding its authority by publishing that
retirement and then a closing kind 1462 rekey with no recipients, the same
pair a keeper's close publishes. A keeper's close does not set `ended`, since
the admin who asked it to close need not be the person who started the room.

Readers MUST continue accepting v2 (`v:2,j,h`) and v1 (`s:<room secret>`, with no
version) indefinitely. Resharing an existing room preserves its capability and
version. In particular, an old keeper state file is not silently converted to a
durable invitation. A creator's explicit conversion to a group issues a fresh
bearer while retaining the conversation and authority. New v3 membership does
not hand an inviter/delegation signing key to a joining member.

An admission policy is `{tier,admitted?,agents?,members?,quiet?}`. `tier` is `open`,
`ken`, `kith` or `kin`; `agents`, when present, is `owned-by-members`. `members`
is an explicit participant restriction. `quiet`, when present, is exactly `true`
and requires `members`: the room's kind 1460 events are never published bare,
and ride instead inside kind 1059 room drops as `nostr-deaddrop` defines them,
each addressed to a key derived from the current epoch key, the member's
participant pubkey and a counter, one per slot per device with fillers between.
Every reader derives every listed member's keys; a reader that does not know
`quiet` would talk in the open, so a `quiet` in any other shape, or without
`members`, rejects the link. Unsupported/malformed policy means reject the link,
never an open room. The `accessEvaluation` and `kindredProof` vectors define the
recognised proof and expiry cases.

**Asking before letting people in.** The admission request body is
`{"v":1,"device":<hex>}` and may also carry `"name"` (what the person
asking calls themselves, at most 64 characters, a claim) and
`"participant"` (their participant key, when they hold one). Both are
optional and additive: a responder that does not know them grants as it
always did, and a responder whose owner has asked to be consulted shows
them on a card before answering. There is no refusal on the wire; a
declined request is simply never answered, which is indistinguishable
from nobody being online, and the door says so.

## Credentials, roster and room state

A kind-20460 credential has empty content and tags `d` = room ID, `device` =
device public key, `expiration` = Unix seconds. It is signed by the participant.
It travels inside the encrypted roster, never as a public participant-to-device
mapping. Check signature, room, device and expiry before attributing any track,
message or action to that participant. Pairing grants only a room-scoped,
expiring credential; it must not copy the participant secret to the new device.

A credential may end with `["seal", <x-only pubkey>]`: the device's seal key,
minted fresh at each renewal. The authority's rekey copy (1462 `keys`), its
grant (20469) and a member's grant (20472) are NIP-44-sealed to the seal key of
the newest credential the sender has seen for the device, not to the device
key; with no seal tag, to the device key as before. Senders keep that newest
credential per device and never move it back to an older one a roster entry
carries, and a desk seals to the newer of it and the credential a request
presents. Readers try every seal key they hold, then the device key, and keep
their seal secrets as they keep the device key. Because the participant, not
the device, signs the seal key, a copied device stops reading new epochs once
the credential it caught has lapsed and the room has rekeyed. See fold-kit's
`docs/seal-key.md` and `vectors/seal-vectors.json`.

The roster is kind 20461, signed by the device, tagged `d` with the current
room/epoch selector, and NIP-44-encrypted with the current room/epoch key. Its
inner credential must agree with the outer author. A device advertises at
most one track per role: a decode rule, not a new constraint, since a
device only ever runs one camera, mic, share and screen-audio track at a
time - an extra advert for a role already seen is dropped and the entry is
kept. `updatedAt`, tracks, claims,
name, verified ownership and optional assist advertisement are interpreted by
`rosterEvent` vectors. A farewell uses `left:true`. An optional `call`
object `{ id, since }` says the device is on the call with that id (32
lower-case hex characters, chosen by whoever started it) since that Unix
second; a call is read off presence, has no kind of its own, and ends when
the last present device stops carrying it (`valid-on-call` vector). A
malformed `call` is dropped and the entry kept. An optional `sid` of 8
lower-case hex characters names the page session that published the entry,
minted fresh per page session and never reused; a malformed one is dropped
and the entry kept. A device key is per browser profile, not per tab, so a
reader holds entries under `device|sid` where one is given and under
`device` alone where it is absent: two tabs of one room are two entries
rather than a last-writer-wins overwrite, a farewell removes only the page
session that sent it, and a media connection is bound to the page session
it was negotiated with - a changed `sid` for a device is a different
endpoint, and whatever was open to the old one is closed and rebuilt rather
than reused. Absence means unknown and reads exactly as it did before the
field existed. Presence expires; replayed
presence is not a permanent guest list. New arrivals announce and existing
members answer because relays need not retain presence.

An optional `callProfile` names the call-signalling profile a device speaks;
only the exact number `2` counts, meaning fixed media slots, reliable
signalling with generations and pairwise health (see "Profile 2 additions"
below) - anything else, including absence, is profile 1. It is a roster
field rather than a bump to the signal wire's own profile tag, on purpose:
`docs/protocol.md` already requires that an unknown profile tag never
silently enable new semantics, so capability lives on the one thing each
device already publishes about itself instead. A malformed value is dropped
and the entry kept, exactly as a malformed `sid` or `call` is.

An optional `spryKey` is the device's Spry signing key for this room: the
x-only public key, 64 lowercase hex, of HMAC-SHA256(device secret key,
"spry-device-v1") (`src/spry-key.ts`). Every current client announces it in
every room, so an admitted device without one is an older client. A paired
member's app registers these keys with its own Spry node so the room's relay
grant redeems only for admitted devices (spry-turn
`docs/design/2026-10-28-room-grant-seal-and-advert-privacy.md`). A value that
is not 64 hex naming a curve point is dropped and the entry kept.

A track advert may carry an optional `muted`, meaning the device itself
turned the track's source off (`track.enabled = false`) rather than a peer
turning its own playback down; only the exact boolean `true` counts, so it
sits beside `callProfile` as one more field where absence, `false`, `1` or
any other value reads as not-muted and the entry is kept regardless. This is
the device's own mic state, distinct from and additive to a listener's local
volume choice, which is never on the wire at all.

An automated device declares `agent:true`. It may additionally advertise
`requestReceipts:true` while its driver sends signed request-received markers
(see [agent receipts](agents.md#request-receipts-and-failures)). Only boolean
`true` on an agent entry enables this capability; other values are ignored.
Absence of this field does not imply that an ordinary agent reply failed.

A descriptor (20465) contains forwarder references and ICE configuration under
the room key. It does not replace the invitation admission policy. A forwarder
reference names its signalling relay and public key; unrecognised properties do
not create capabilities. The old descriptor and first-offer shapes stay valid
without a ticket or policy event.

A descriptor may carry one Spry offer, `spry`:
`{"v":1,"endpoint":"<https origin or spry: URI>","token":"<43 base64url>","expiresAt":<unix seconds>,"node"?:<kind 24183 event>}`
(`src/spry.ts`, `parseSpryOffer`). The token is a room relay grant; the
member's own node issues it and redeems it, with `/v1/credentials`, only for
devices whose `spryKey` it has registered or vouched for. An `https:` offer
yields TURN only on `turn:<host>:3478` (UDP, TCP) or `turns:<host>:5349`. A
`spry:` offer is reached over Spry's encrypted Nostr control channel (kinds
24181 and 24182) on the relays its URI names, and `node` is that node's card,
signed by the URI's key. A `spry-peer-v1` card names a private mesh node:
only a device paired with that node redeems its offer, and others never
contact it. A `spry-standard-v1` card names a standard-profile node, such as
a member's built-in relay (spry-turn `docs/supervised-mode.md`): its content
is exactly `{"profile":"spry-standard-v1","v":1}` (either key order, no
whitespace), it has exactly one tag, `expiration`, no more than 600 seconds
after `created_at` and in the future, and `created_at` is at most 60 seconds
ahead. A reader checks the card's expiry when it reads the offer and drops a
stale card, so an offer whose card has lapsed is not redeemed until its host
publishes it again. Any member may redeem a standard offer. The credential
answer must carry a standard card signed by the URI's key and one or two
`turn:` URLs on a single public unicast IPv4 literal (Spry's `public_v4`: not
private, loopback, link-local, broadcast, documentation, `0/8`, `224/3`,
carrier-grade NAT, benchmarking or `192.0.0/24`), ports 1024 to 65535,
`?transport=udp` or `?transport=tcp`, no repeats. Only the host publishes its
own `spry:` offer: other members do not republish it, so a reader can name
the host as the one participant whose descriptor carries it, and names
nobody if more than one does. A client with Hide my IP address on uses
another member's standard offer only after a one-time choice naming that
host, kept on the device per host. The card carries no address; the host's
public IPv4 travels only in the encrypted credential answer. The cards, offer
marker and URL rule are pinned by `vectors/spry-standard-offer-v1.json`.

The room's name is shared room state with no kind of its own: any member
renames the room with a `name` op on the encrypted control channel,
`{"op":"name","name":"…","id":"<32 hex>","at":<unix ms>}`, plus
`"carried":true` on a copy a member posts again. The newest by `at`, then
`id`, then name wins; `floor(at/1000)` may not exceed the carrying message's
`sentAt`; a name over 32 code points is refused, and the rest is sanitised as
a display name. Members carry the current name into each new epoch and back
inside the retention window. See [the room name](room-name.md) and the
`roomName` vectors.

A call can be run as a meeting. The authority signs a `meeting` op on the
control channel, `{"op":"meeting","on":<bool>,"speakers":[<pubkey>…],"version":<int>,"sig":"<128 hex>"}`,
over `sha256("kithmoot/v1/meeting:" + roomId + ":" + version + ":" + (on ? 1 : 0)
+ ":" + JSON(speakers))`, the speakers lower-case, deduplicated, sorted and at
most 64. The newest verified version wins and any member may repost it. While
`on`, a client MUST NOT send microphone, camera or screen from a participant
not on the list, and MUST NOT play or show what it receives from one; a device
whose participant it cannot place is treated as not on the list. A recording is
announced the same way, `{"op":"recording","on":<bool>,"id":"<32 hex>","version":<int>,"sig":"<128 hex>"}`
over `sha256("kithmoot/v1/recording:" + roomId + ":" + version + ":" + id + ":"
+ (on ? 1 : 0))`; a client records only after posting one, reposts it while
recording, and every client shows a notice for as long as the newest is on.

Recording profile 3 carries a complete authority-signed `liveRecording` in
authenticated roster presence. Profile 4 additionally supports participant
recording: `liveRecording` includes `call` (32 hex), `recorder` and `device`
(64 hex), with paired `recording` and `recording-capture` operations signed by
that device. The enclosing admitted roster must identify the same participant
and device; an On must also match its advertised call. An Off may be confirmed
after leaving, but remains scoped to that device and call. Receivers retain
independent notices per call/device; one recorder's stop cannot clear another.
Capture requires an exact guarded relay acknowledgement and profile 4 on every
device currently on the call. Presence in another room or idle device does not
qualify or block capture. Meeting policy and room authority are unchanged.

`{"op":"hand","up":<bool>}` raises or lowers the sender's hand and is unsigned:
the sender is the message's credential-bound participant. See `src/meeting.ts`,
"A meeting is moderated by the room's authority" in [decisions](decisions.md),
and the `meeting` vectors.

Group storage grants (experimental, phase S4; the nodes are listed in the room by phase S5, below).
When a keeper is configured with group storage nodes, it signs a kind 27541
event with the room's authority key for each admitted device at each node, and
sends each as `{"op":"storage-grant","event":{...}}`, one event per op, whole
and unaltered (about 750 characters, at most 1,070 for the largest legal one,
inside the 2,000-character control message limit). The event, its tags and the
rules for accepting it are in wildbloom-node's `docs/GROUP-GRANTS.md`, profile
`group-grants/1`; `src/group-grants.ts` builds, parses and verifies it. A
revocation (`status` `revoked`) and a `reset` ride the same op. A reader keeps
an event only if it verifies, is signed by the authority pinned in its link and
names its room id (`deriveRoom(secret).roomId`); it keeps the grants whose
`device` is its own key and every revocation and reset, to carry to nodes, so
any member may repost one and the op has no `host`. `{"op":"storage-grant?"}`
asks the keeper to send the asker's grants again; the asker is the message's
credential-bound device, as for `hand`. A grant is never published bare on a
relay: it travels only in this encrypted channel and by HTTP `POST
/groups/v1/events` to the node it names. Readers that do not know the op ignore
it.

Room storage nodes (experimental, phase S5). The room's authority posts
`{"op":"storage","nodes":[<node base URL>…],"version":<int>,"sig":"<128 hex>"}`
on the control channel: the same list the invitation's `storage` key carries,
for members who are already in the room. `sig` is BIP-340 by the authority over
`sha256("kithmoot/v1/storage:" + roomId + ":" + version + ":" + JSON.stringify(nodes))`,
the list in its given order (it is a preference order, so it is not sorted), and
every entry MUST be canonical as above. Unlike a `relays` op, an empty `nodes`
is valid and is the withdrawal of every node. `version` is Unix seconds, the
`created_at` of the invitation copy the keeper signed at the same time, so a
member comparing the two carriers sees one number. A member keeps the record
with the highest version from either carrier; a tie keeps what it holds. Any
member may repost an op, so it has no `host`; only the signature counts, and a
list that is not canonical fails verification rather than being corrected. A
keeper posts it when it opens the control channel and again after 20 days, so a
newcomer reading the channel's history window finds it. Readers that do not know
the op ignore it.

This is the rule for clients, not a description of today's apps. A client that
implements group storage keeps a listed room's files on its nodes, keeps them
off in a room whose list is `[]`, and never falls back to a public file server
for either. The library implements it (`GroupStorage`); the web app does not
yet, and still uploads to the member's own file server in such a room.

Rekeys and the encrypted control channel are authority-bound. A room advances
one verified epoch at a time; a removed device can read the removal notice but
cannot recover a next-epoch secret addressed only to remaining devices. The
`roomEpoch` vectors include wrong authority, missing recipients and epoch gaps.

An epoch request (20468) body is `{v:1,credential,proof?,admission}`. `admission`
is `HMAC-SHA256(k, "kithmoot/v1/epoch-request:" + roomId + ":" + authority + ":"
+ device + ":" + created_at)` as lower-case hex, where `k` is
HKDF-SHA256(ikm = epoch-0 room key, no salt, info `kithmoot/v1/epoch-request-key`,
32) and the identifiers are lower-case hex. It proves the asking device was
admitted to the room, which the credential alone does not: the room id and the
authority's pubkey are public on every rekey, and a credential is minted by any
participant key. A desk MUST refuse a request whose `admission` is missing or
does not verify, before consulting the policy and without publishing any grant.
The proof key is always epoch 0's, since the device asking is by definition
behind. A responder from before this field ignores it. The
`epochRequestAdmission` vectors pin the derivation and the refusals.
A client that has left an epoch goes on reading its chat and channels for a
while: the history window, every epoch left within the last 30 days
(`HISTORY_WINDOW_SECONDS`), newest first, at most 16 (`MAX_HISTORY_EPOCHS`),
each decoded under its own root. Every client applies the one rule,
fold-kit's `epochsInWindow`, so what an authority hands over is what a member
goes on reading. When the room left an epoch is the `created_at` of the
authority's rekey out of it. A chat subscription asks for the current epoch
and the four most recently left in a filter each, and folds any older ones
into one filter with several `#d` values, so it carries at most six filters
however many epochs it reads (the `chatHistory` vectors). This is how a
message published under an epoch just before a rekey, and delivered after
it, is still heard, how a device that applies several rekeys in a row on
returning reads the epochs it passed through, and how a room on a weekly
schedule keeps its last month. A message under a left epoch from a
participant removed at any epoch is refused, whatever its `created_at`: the
removed keep the old key. Messages are never written under a left epoch.

**Scheduled rekeys.** A rekey that turns the key on the room's schedule,
rather than to remove somebody, carries `"scheduled": true` in its encrypted
body (between where `closed` and `commit` would be), so it is signed and a
relay cannot tell it from a removal. It never sits beside a non-empty
`removed` or `closed`, and a reader believes it only when `removed` is empty
and the room stays open, so a body that contradicts itself is still
announced. A client moves to the new epoch exactly as for any rekey and says
nothing about it: no "moved to epoch" line, no removal. A reader that does
not know the field ignores it and announces the rekey as before. See
fold-kit's `docs/scheduled-rekey.md` and `vectors/schedule-vectors.json`.

**The window in an authority's grant.** An authority's grant (20469) may carry
`passed`: the window's left epochs, oldest first, each
`{epoch, secret (base64url), left (unix seconds)}`, never epoch 0 and never
one at or above the epoch granted, at most 16. Every grant carries it, because
a request does not say which epoch the device holds, so a newcomer and a
device back after missing several rekeys are both handed the last month. A
reader takes `passed` only in exactly that form and otherwise drops it and
keeps the grant; a reader that does not know it reads the current epoch, as
before. A member's grant (20472) already carries the epochs it passed, each
proven by the next rekey, and its reader takes when each was left from that
rekey's `created_at`. A client reads every passed epoch as a left one, from
when the room left it.

**Following a rekey from outside the room.** A client's rooms list reads a
room it is not in under the epoch it last held, and follows the authority's
1462 from there with this device's own copy (its device key and the seal
keys its credentials named), as a member does. A device the rekey left out,
because it was removed, the room was closed, or it was not in the room when
the authority rekeyed, has no copy and stays where it is until the room is
opened. The web keeps the epoch's secret, the window's secrets with when each
was left, the removed and the members (`kithmoot.room-epoch.v2.<room>`) and
opens the room from them, so it neither replays every rekey from epoch 0 nor
stalls on one sealed to a seal key it has since dropped.

A rekey is compared by event id. Two different rekeys for one epoch, both
validly signed by the authority, mean its key is rekeying from two places;
a client reports this (`EpochConflict`) and does not choose between them by
arrival order. A disagreement over an epoch the client skipped through a
grant is not seen. A client that reaches an epoch through a grant rather than
the rekey chain has jumped epochs (`EpochGap`) and cannot read the ones
between, except those a member grant carried (`passed`), which it reads as
left epochs; from an epoch above 0 that is a returning device that was offline
at a rekey or whose relays let one go, and it says so. The web client, the
library and the Android client (kithmoot-android #126) do all of this. On
Android, a quiet room still opens its dead drops only under the current
epoch's key, so a late message on an epoch it has left is not read there.

Clients that cannot follow an epoch must say so rather than display a quiet,
empty room. Android capability gaps are recorded in the compatibility ledger;
passing M2 codecs does not implement features it did not previously support.

## Chat envelope 2

Readers shipped; writers stay on envelope 1 until every client's reader has
had a release in the field (`EncodeChatOptions.envelope`, off by default).
This is phase 3 of `docs/2026-10-04-key-schedule-parity.md`.

An envelope-2 chat event is kind 1460 with the same tags and `created_at` as
envelope 1, signed by a key made for that message alone. Its NIP-44 v2
content, under the channel key, is exactly
`{"v":2,"body":<string>,"sig":<128 lower-case hex>}`:

- `body` is the message JSON an envelope-1 event carries, as a string, so a
  reader hashes the bytes the sender signed.
- `sig` is the device's BIP-340 signature over SHA-256 of UTF-8
  `kithmoot/v1/chat-envelope-2:<room id>:<d tag>:<outer pubkey>:<created_at>:`
  followed by `body`, every hex lower case, with the room's epoch-0 id.

A reader verifies `sig` against the body's `device`, requires the body's
`sentAt` to equal `created_at`, and then applies every envelope-1 rule (the
credential names that device and the participant, the policy admits them)
unchanged. A fourth key, another `v`, a body that is not a string or a
signature in any other form refuses the event. Because the signature names the
outer pubkey, a body cannot be lifted into another event, restamped or
retagged by anybody but the sender. Edits and retractions were already matched
on the inner participant and message id, never the event's signer, so they
work across envelopes.

The outer secret key is HKDF-SHA256(device secret key, empty salt,
`kithmoot/v1/chat-outer:<d tag>:<message id>`, 32), refused rather than
reduced outside [1, n). It is derived so the device can sign a NIP-09
deletion of its own message later; nobody without the device key can link
two of them. A reader never computes it. The `chatEnvelope2` vectors pin the
derivation, the digest and the refusals.

**What a relay learns.** Of a stored chat event: the channel's `d` tag, the
time, the padded size, and a key it never sees again. It no longer learns
which device wrote it, or how many messages each device sent. The `d` tag
still groups a channel's history, as a fixed per-channel author would. A
relay watching live still sees the roster (device-signed, ephemeral), presence
and the publishing connection, and can match a message to a device by
connection and timing. Quiet rooms go further.

A top-level `v` is reserved: a message JSON that carries `v` is read as an
envelope and refused unless it is exactly envelope 2, so no envelope-1 field
may ever be called `v`.

**Before writers switch on.**

- Deletion (done here; Android open). A device's own envelope-2 messages
  are found by stream, not by author: `RoomSession.chatStreams()` (or, for a
  room not open, epoch 0 and the kept epochs in the channels every client
  writes in) is read, `ownEnvelope2Events` keeps the events whose author is
  the outer key derived from this device's key, stream and message id, and
  each is asked for alone under that key. `deleteSignedEvents` takes them as
  `chat`; self-destruct, the agent's `deleteOwnEvents`, the keeper wipe
  (`src/node/cli.ts`) and the web tidy-up (`TidyUpDeps.chatStreams`) pass
  them. It costs one request per message, and the requests share a moment,
  which links them by timing. Named channels of a room that is not open in
  this browser are not known, so its messages there stay.
- Quiet rooms: the envelope adds the signature, the wrapper and a second
  escaping of `body`. Measured 2026-10-21 with a seal-keyed credential and a
  display name against `QUIET_BUCKET_BYTES` (4096): the longest plain-text
  message that fits falls from 1,696 to 1,480 characters, and one made only
  of double quotes from 848 to 370, since each is escaped twice. A writer
  that switches quiet rooms over refuses more long messages with
  `QUIET_TOO_LONG`; either accept that, or carry quiet chat as envelope 1
  inside its drop, where the wrap's one-time author already hides the
  device.
- Relay rate limits and write allowlists keyed on the author no longer apply
  to chat; the sender limit inside the room (`MAX_CHAT_MESSAGES_PER_MINUTE`)
  is the one that counts.

## Call bell

A call has no event of its own in the roster: it is read off presence. A
phone with the app closed cannot afford presence, which is a heartbeat every
20 seconds from every device in every room. Kind 1464 gives it one event per
call start and one per call end to wait for on an idle socket.

The bell is a regular kind, so a socket that has just reconnected catches it
with `since`, and every bell carries a NIP-40 `expiration` of `created_at +
120`. Its outer event is signed by a secret key minted for that one bell and
then discarded, never a device or participant key. It has exactly two tags:

- `d`: the first 32 hex characters of HMAC-SHA256(K, UTF-8
  `kithmoot-call-bell-v1|` + the UTC day of `created_at` as `yyyy-mm-dd`),
  where K = HKDF-SHA256(current room/epoch key, empty salt,
  `kithmoot/v1/call-bell-tag`, 32).
- `expiration`: `created_at + 120`, decimal.

The content is NIP-44 v2 with the conversation key HKDF-SHA256(current
room/epoch key, empty salt, `kithmoot/v1/call-bell-key`, 32), of compact
JSON `{"v":1,"state":"start"|"end","call":{"id","since"},"device","sig"}`.
`call` has the roster's shape. `device` is the ringing device's public key.
`sig` is its BIP-340 signature over SHA-256 of UTF-8
`kithmoot/v1/call-bell:<room id>:<state>:<call id>:<since>:<created_at>`,
with the room's (epoch-0) id, so a bell replayed into another room, or
restamped to another time, fails. The body carries no names.

A device publishes a `start` bell when it goes on a call no other present
endpoint carries, and an `end` bell when it leaves a call (by stepping off
or by leaving the room) and no other present endpoint carries it. Nothing
else rings: no periodic bells, and no bell when a call moves between two tabs
of one device. Publishing never delays going on or off a call; a failure
costs only the ring.

A reader subscribes to `{"kinds":[1464],"#d":[...]}` with today's tag and,
within 120 seconds after or 60 seconds before UTC midnight, the neighbouring
day's. It rejects a bell whose tag is not the day tag for its `created_at`,
whose outer signature fails, that does not decrypt, whose `v` is not `1` or
`state` not `start`/`end`, whose call id is not 32 lower-case hex characters,
whose device signature fails, that is more than 120 seconds old or more than
60 seconds in the future, or whose `since` is more than 60 seconds after
`created_at`, more than 120 seconds before it on a `start`, or more than 30
days before it on an `end`. A valid bell says a device holding the room key
rang; whether that device belongs to the room is checked against the roster
or a credential the reader holds. The `callBell` vectors pin the derivation
and the refusals.

**What a relay learns.** That some opaque tag, which changes every UTC day,
saw a call start or end at a time, from an unlinked key, and the connection
(and so the IP address) that published it. A relay that also carries the
room's roster can correlate that connection and moment with the roster
heartbeats the same connection sends, and so guess which roster tag the bell
belongs to; the bell hides nothing that the connection's own timing gives
away. Relays that ignore NIP-40 keep the event, still opaque. Anybody who
holds the room key can compute the tag and read the bell, exactly as they can
read the roster.

**What it cannot.** Derive the roster's `d` from the bell's tag or the other
way round, link bells of one room across days without the key, or tie a bell
to any device or participant key: those are only inside the ciphertext.
Another room's bells share nothing with this one's on the wire.

## Delivery receipts

A delivery receipt says that some messages reached a device: they were
decrypted and verified there. It is never a read receipt and says nothing
about whether anybody looked. A sender shows two ticks for a message once a
receipt from another person's device names it. The design, writer rules and
UI are in `docs/design/2026-10-28-delivery-ticks.md`; this section is the
wire contract, pinned by `vectors/delivery-receipt-v1.json`.

Kind 1465 is regular, so a sender who was away learns on return. The outer
event has these tags and no others beyond a total of four, each name once:

- `d`: the chat stream's own `d` (`deriveChannel` of the epoch root and the
  channel name, exactly as kind 1460 carries it), 64 hex characters.
- `expiration`: canonical decimal, `created_at + 604800`, lowered to a
  conference room's end when it is sooner. Required.

The outer event is signed by a key used for that one receipt:
HKDF-SHA256(device secret key, empty salt,
`kithmoot/v1/delivery-receipt-outer:<d>:<created_at>:<n>`, 32), where `n` is
the receipt's decimal index within that second for that stream (0 unless a
flush splits). Derived so the device can later sign NIP-09 deletions of its
own receipts; nobody without the device key can link two receipts to each
other or to the device.

The content is NIP-44 v2 under the conversation key HKDF-SHA256(stream key,
empty salt, `kithmoot/v1/delivery-receipt-key`, 32), separate from the chat
key, of `{"v":1,"body":<string>,"sig":<128 lower-case hex>}` with exactly
those three keys. `body` is compact JSON kept as a string so the signature
covers the sender's bytes, with keys in this order:

```json
{"v":1,"room":"<room id>","participant":"<hex>","device":"<hex>","credential":{...},"proof":{...},"agent":true,"got":["<16 hex>"]}
```

`proof` (the admission proof chat carries in closed tiers) and `agent` are
omitted when absent. `agent` counts only as exact boolean `true`. Unknown
body keys are ignored. `got` lists 1 to 256 unique entries, each the first 16
hex characters of SHA-256 of UTF-8 `kithmoot/v1/delivery-receipt-id:` + the
message's inner id (`ChatMessage.id`). `room`, `participant` and `device` are
64 lower-case hex characters. `sig` is the device's BIP-340 signature over
SHA-256 of UTF-8
`kithmoot/v1/delivery-receipt:<room id>:<d>:<outer pubkey>:<created_at>:<body>`,
every hex lower case. Binding the outer key and `d` stops a member lifting a
body into another event or stream.

A reader refuses a receipt, silently, unless every check holds. The cheap
ones come before any signature check or decryption:

1. Kind 1465; at most four tags with unique names and string values; one
   two-value `d` of 64 hex characters naming a stream the reader follows;
   one canonical `expiration` with `created_at < expiration <= created_at +
   604860`; the serialised event at most 16,384 UTF-8 bytes.
2. `created_at` at most 60 seconds ahead of the reader's clock and at most
   604,800 seconds behind it; `expiration` still in the future.
3. The outer signature verifies.
4. The content opens under the receipt key; envelope and body `v` are 1;
   `room` is the reader's room; `got` is well formed.
5. The inner signature verifies against `device`.
6. `credential` binds `device` to `participant` for this room and is valid
   at `created_at`, the rule chat applies at `sentAt`.
7. The room's access policy admits `participant` at `created_at`, with
   `proof` when present.

The 60-second future bound is deliberately tighter than chat's 300: a
receipt is signed when it is published, never composed offline.

**What a relay learns.** That a key it has never seen wrote a small event
under a chat stream's `d` at a time, and the connection that published it.
The `d` already groups that stream's chat, so the receipt adds no linkage the
relay could not get from timing. It cannot read which messages, which
person or which device a receipt is about. Its timing does show that a device
in the room was active. Quiet rooms never publish receipts.

**What members learn.** When each member's device received each message.
That is the point of the feature, and why no read state is ever carried.

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
   `SignalBody` JSON object: `type` = `offer`, `answer`, `ice`, `assist` or
   optional `annotation`, `relay-test` or `relay-test-result` (see "Relay
   outside test" below);
   `roomId`; optional `sdp`, JSON-string `candidate`, `trackHints`, `tier`,
   `assist` (far-end device), `accept` (assist response boolean),
   `annotation` and `relayTest`. An annotation is temporary screen-share markup:
   `{op:"stroke",shareId,strokeId,points:[{x,y},...]}` or
   `{op:"clear",shareId,strokeId:""}`. `shareId` is the advertised screen
   track ID; coordinates are finite numbers from zero to one; a stroke has
   2–128 points. Readers discard invalid annotation bodies. An old reader
   ignores the unknown signal type, so drawing cannot disturb its call.
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

1. Bound wrap content at 131,072 characters, at most 16 outer tags with at most
   eight strings of 2,048 characters each, and bound crypto attempts before
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
5. Apply sender rate limits and roster/authority checks before negotiating or
   displaying annotation. Annotation is never chat history and is not replayed
   to a device that was absent.

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

### Profile 2 additions

A device that speaks fixed media slots, reliable signalling with generations
and pairwise health declares this on its roster entry (`callProfile: 2`), not
on the signal wire's profile tag: `kithmoot` stays `'1'` on every signal a
profile-2 device sends, because an unknown profile tag must not silently
enable new semantics. A device is profile 2 for a pair once either its roster
entry says so or a signature-valid signal carrying `gen` has arrived from it,
whichever the reader learns first - roster presence can lag behind a signal
that has already crossed. A profile-1-shaped signal (no `gen`) from a device
believed profile 2 downgrades that pair back to profile 1: this is what a far
end reloading into an old build looks like.

All of the following are additional optional `SignalBody` fields, ignored by
an old reader's `JSON.parse` exactly as any other unknown field always was:

| Field | Type | On | Meaning |
| --- | --- | --- | --- |
| `gen` | integer >= 1 | every profile-2 signal | Pair generation. Monotonic per pair, never reused. |
| `conn` | 16 lower-case hex | every profile-2 signal | Sender's connection instance id, fresh per `RTCPeerConnection`. |
| `peerConn` | 16 lower-case hex | when known | The connection the sender believes it is addressing. |
| `seq` | integer >= 1 | offer, answer, ice | Per `conn`, from 1, gapless. |
| `first` | integer >= 1 | batched ice | First seq covered by this batch. |
| `candidates` | string[] | ice | Batched ICE candidates. `candidate` stays on the wire for profile-1 peers. |
| `ack` | integer >= 0 | any | Highest contiguous seq received from `peerConn`, piggybacked wherever possible. |
| `re` | integer >= 1 | answer | Seq of the offer being answered. |
| `restart` | `true` | offer | This offer carries an ICE restart inside the current generation. |
| `slots` | `{ [mid]: TrackRole }` | generation-opening offer | Exactly four entries - `mic`, `camera`, `screen`, `screen-audio` - each exactly once, keyed by transceiver mid. |
| `rx` | `{ [TrackRole]: 'ok' \| 'dead' }` | health | What the sender is receiving from the recipient, per slot; at least one entry. |

Three new `type` values ride the same envelope: `ack` (a standalone
acknowledgement, when nothing else is due to be sent), `health` (a report
that carries only `rx`, for a single dead slot on an otherwise healthy
transport - RTCP cannot express that on its own), and `sync` (carries `gen`
only, meaning "my current generation is this"; sent when a signal from an
older generation arrives, rate limited to one per two seconds per pair). An
old reader rejects all three exactly as it rejects any other unrecognised
`type` today, which is what keeps them addressed only to peers already known
to speak profile 2.

Every field above is validated strictly on decode - integer ranges, exact hex
length, the slot map's fixed shape - and a present-but-malformed field rejects
the whole signal body rather than being dropped on its own; unlike a roster
display name or assist offer, there is no "the entry is still someone
genuinely in the room" to fall back to; a mis-shaped connection id or
generation number is not safe to act on partially. What is deliberately not
validated at this layer: whether a field belongs on the `type` it arrived
with, and any cross-signal bookkeeping such as `gen` ordering or `(conn,
seq)` receiver dedup - those depend on protocol state the codec does not
hold and are `Peer`/`Mesh` concerns.

A retransmission of an unacknowledged offer, answer or batched `ice` is
re-wrapped with a fresh `created_at` each time it goes out, exactly as any
other call to the wrap function does - so the 60-second relay-retention hint
and the ±20-second staleness window never confuse a retransmission for a stale
replay, and the inner-event-id dedup above never mistakes it for a duplicate
of the original. Receiver dedup for profile-2 signals is keyed `(conn, seq)`
rather than by inner event id.

### Relay outside test

A member who shares a built-in call relay (a `spry:` offer with a
`spry-standard-v1` card, see the descriptor's Spry offer above) can ask one
other device in the room to test that relay from wherever the device is. The
test runs only when the host asks; nothing triggers it automatically. Both
messages ride the envelope above, so each is NIP-44 to exactly one device,
signed by the sending device key, tagged outside with only `p` and a NIP-40
`expiration` 60 seconds out, and subject to the same staleness, dedup and
roster checks. No new kind is used. An old reader refuses both types as it
refuses any unknown `type`, so an old client is never asked to do anything;
the host simply hears no answer.

The host sends `type: "relay-test"` with
`relayTest: {"id":"<16 lower-case hex>","endpoint":"<spry: URI>"}`: a fresh
`id` and its own endpoint exactly as its room offer carries it. The tester
answers the asking device alone with `type: "relay-test-result"` and
`relayTest: {"id","endpoint","ok":<boolean>,"stage"?,"sameNetwork"?:true}`,
echoing `id` and `endpoint`. `stage` is present exactly when `ok` is false and
is one of `declined` (the tester did not run it), `credentials` (the node gave
the tester no relay login), `allocate` (no relayed address), `stun` (the
listener did not answer plain STUN) or `inbound` (both ends ready, nothing
reached the relayed address). `sameNetwork` is present only as `true` and
never with `declined` or `credentials`. Both bodies are closed: any other key,
a missing key, an `id` that is not 16 lower-case hex, an endpoint over 1,024
characters or not a canonical `spry:` URI refuses the whole signal. Neither
body carries an address, a credential, a name or a time; the result's time is
the signed inner `created_at`. Readers admit at most 8 relay-test signals per
sending device per 20 seconds, apart from the call budget, and only from
devices in the current roster, whether or not a media connection exists.

A tester ignores, without answering, a request whose sender's participant is
not the one participant whose descriptor carries that endpoint, or for an
endpoint it holds no unexpired standard offer for. It answers a genuine host
`declined` when a test is already running, when it ran a test for the same
device in the last 60 seconds, or when it may not use that relay (Hide my IP address on
and no choice made for that host). Otherwise it takes a relay login for the
offer (one it holds with at least a minute left, or a fresh `/v1/credentials`
redemption that is never applied to its calls), and answers `credentials` if
that fails.

The test itself, at most 15 seconds: peer A is relay-only on the returned
TURN URLs; peer B has no TURN and uses `stun:<ip>:<port>` from the UDP TURN
URL, so it learns its own public address and A's relay can let it in. The
two peers exchange candidates locally, A opens a data channel and B echoes a
fixed string. It passes when the echo returns, A's nominated succeeded pair
has a `relay` local candidate that received bytes, and B's has a local
candidate that is not `relay` and received bytes: B's checks reached A's
relayed address from B's public address, through the host's allocation
port, proving listener and allocation inbound together. Otherwise the stage
is `allocate` when A gathered no relay candidate, then `stun` when B gathered
no server-reflexive candidate and `sameNetwork` does not hold, otherwise
`inbound`. `sameNetwork` holds when any of B's server-reflexive or host
addresses, or the address of B's selected local candidate, equals the relay's
IPv4: the tester was on the host's own network or machine. A relay with
mapped ports refuses peers on its own addresses other than its allocations,
so such a test normally fails `inbound` with `sameNetwork`. A host may call its relay
reachable only from `ok: true` without `sameNetwork`; a pass with
`sameNetwork` is a hint, never "reachable". Only the verdict leaves the
tester. The host's relay sees the tester's address, as on any call through
it; the room's relays see only that two devices exchanged wraps; ForgeSworn
receives nothing. Pinned by `vectors/relay-outside-test-v1.json`.

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
