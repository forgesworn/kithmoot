# Native member session source

`OrdinaryPersistentBootstrap.openMemberSession` constructs the genuine library
`RoomSession` from this bootstrap's acknowledged incoming-member proof. The
private factory owns its root/device/seal buffers, protocol execution guard and
exact `OrdinaryRelayCarrier`. It remains **unmounted in production**. The
dependency and lockfile now pin published `signet-login@0.19.1`; see
[SDK provenance](ordinary-sdk-provenance.md).

The public facade exposes join, chat sends, publish-only prepared retries,
detached message reads, named chat channels, descriptor publication and awaited
close. It exports no raw session, executor, epoch keys, authority signer, device
issuer, media, assignment storage or generic effect callback. One child may be
starting, live or cleaning up per bootstrap. A synchronous latch precedes caller
selectors; another child is permitted only after terminal cleanup has joined.

## Current custody and private preparation

Before construction and every supported private preparation or disclosure, the
factory repeats the full composer under an actual native browser/tab read. It
requires the exact owner instances, invitation scopes/fences, selected retained
operation, complete source bytes and native revisions. The session's own captured
live selector is part of this decision, alongside bootstrap selection, native
lifetimes, credential expiry and carrier liveness. A relay-only check would be
too late to prevent message entropy, signing or encryption.

The library's optional `ProtocolExecution` hooks add restrictions at construction,
initial fresh-root request/adoption, roster, descriptor and chat preparation and
ingress. Synchronous effects run inside current native custody; provider/network
promises start there, are retained there, and are awaited outside the origin
lock. Neither this interface nor a previously successful check proves membership.
The hooks are not a complete inventory of every raw `RoomSession` operation.
They must not be used to claim that arbitrary external raw sessions are guarded.
The factory explicitly disables the automatic member epoch desk and catch-up
requests. Directly decryptable signed rekeys use guarded ingress/adoption; a
rekey requiring catch-up terminates this session before any authority/member
request preparation. Full timer-driven epoch catch-up remains separate work.

Room policy is parsed from the exact retained link. This bounded factory supports
an omitted policy or exactly the default `tier: open` rule, and passes a present
rule to the real session. Other tiers, agent rules, member lists and quiet rooms
hold before private construction or sockets. Their real proof and carrier flows
remain to be integrated; they are never silently treated as open rooms.

The retained credential, device and own seal are independently checked by the
guarded loader. It must have at least the library's exported ten-minute resume
minimum before opening the carrier. The threshold is repeated inside actual
carrier reads until initial join completes, including delayed pool/socket
construction. The private native timer now renews through the dedicated producer
described in [ordinary-member-renewal.md](ordinary-member-renewal.md). It reserves
both complete images and bounded seal retention before entropy, signs one exact
template, reconciles both native frames, and adopts the acknowledged successor
in one synchronous paired callback. A successor must retain the same ten-minute
reopening minimum before signing and immediately before writing. The immutable
admission, foreground and tab authority ceilings never advance. Idle resources
close at the selected expiry if renewal cannot succeed. This implementation
remains unpublished and unmounted. Exact-source acceptance is recorded separately
in checkpoint review and automated-test receipts.

## Routing and authentication

A signed relay list in retained admission constrains the normalised destination
set and read/write permissions, independent of input order. Substitution holds
before carrier creation. Where admission carries no signed list, the caller's
bounded relay set is an explicit local selection, not evidenced routing authority.
Caller `circle: true` marks are refused: neither a destination nor its signed
list proves current box ownership or a sheltered lane.
Profile and WebSocket implementation remain caller-selected source/test seams;
production mounting must supply their actual consent and lane decisions.

Authentication consent is synchronously captured from bounded array/grant data
descriptors before the first wait. Accessors are refused. Captured grants retain
the exact native signer instance and its private method provenance; later array
or grant replacement cannot redirect consent. The carrier repeats these same
member restrictions at actual account SDK attempts and handoff. Visitor AUTH
uses acknowledged native participant custody. Tor/device acceptance is separate.

Join uses the actual library's fresh-root request and sealed grant verification
against the pinned invitation inviter. Silence, EOSE and query completion cannot
release roster or chat. This verifies a cryptographic round trip, not independent
current production MLS authority or permanent allocation history.

## Revocation and evidence limits

Either native owner closing, source/selection refusal, credential expiry, explicit
close or fatal carrier closure revokes the owned protocol/session. Socket closure
and session leave are synchronous; terminal cleanup joins native reads, pending
root work, outstanding SDK requests and pool publication tails before wiping
owned buffers and releasing the child slot. An unabortable provider can delay
close but cannot authorise a late frame. Close must never be awaited from a
provider promise that close itself is joining.

A prepared send from a previous epoch or credential is a recoverable application refusal.
The executor repeats custody before releasing that refusal and preserves the
current session. Every validation, native read or owner failure still revokes it;
the caller must prepare a new message under the new key rather than replay old
prepared ciphertext.

Browser tests use real IndexedDB/Web Locks/AES-GCM custody, Fold signatures and
sealed grants, the genuine session and relay pool, controlled wallet/network
scheduling and actual loopback WebSockets. These tests do not establish real
wallet behaviour, deployed relay/Tor isolation, physical device acceptance or
production entry behaviour.

Production root/startup and every carrier, creator-member sessions, restrictive
and quiet policies, durable unknown-commit startup classification, media/assignments/member epoch
desks and the complete protocol inventory remain open. So do board invitation
verification and explicit legacy recovery, current MLS admission authority,
independently permanent allocation continuity, required protected SDK consumer
release and deployment/device acceptance. Production MLS remains disabled.
