# Routing record custody

This unpublished pure helper validates routing writer formats and returns
frozen numeric counts. No endpoint, scope, room, mark, signed flag or signature
is returned. The complete-image consumer now adds the bounded historical signature checks
below. Production root, complete cross-family binding, real client fencing and
durable-before-effect consumers remain open; DG08 is not complete.

| Physical family | Custody rule |
| --- | --- |
| `kithmoot.relays.v1` | Exact scope dictionary; default or room/inherited plus 64 hex room; normalised unique relay objects |
| `kithmoot.circle.v1` | Unique string Set members; older opaque and empty marks are retained as candidates |
| `kithmoot.room-relays-fixed.v1` | Room dictionary, exact c/signed shape, current invitation list format; signed boolean is inert |
| `kithmoot.room-relays.v1.<room>` | Exact relays/version/sig shape, canonical sorted list, nonnegative safe version, 128 lowercase hex signature carrier |

All families belong to the browser owner. Tab placement, account wrapping,
unknown versions/names, noncanonical JSON, malformed rows and values above
8 MiB UTF8 hold the full original image before migration writes or cleanup.
No malformed subset is dropped; no clock, loader, dial or pruning runs.
Empty dictionaries and mark lists are actual forget/unmark writer cuts.

`RelayConnections` can load a 16-relay, read-only or circle:true scope and carry
it through a later save of another scope, even though a newly edited scope is
limited to eight and strips circle. Custody therefore preserves those exact
carried formats. Manual marks can similarly carry arbitrary string members
from a previous loaded list. Preserving them proves no operator trust, current
box discovery, relay authentication, consent to dial or sheltered lane.

The room control row omits its authority key. This helper checks its carrier
shape, not its cryptographic validity. A shape-valid altered signature is
retained inert. The complete-image consumer now verifies it against exact retained inviter
candidates as described below. Current routing permission and effect fencing
remain separate runtime gates.

Fixtures use actual `RelayConnections` writers without opening pools. The
main-file saver is extracted byte-exactly from `storeRoomRelayRecord`, with its
exact literal constant and explicitly injected in-memory storage; the snippet
and source hashes are inspectable. It does not run surrounding bootstrap or
app controls. Signatures use a synthetic key. Older carried constructor seeds
are explicitly synthetic, not a historical-writer proof or real operator.
Native tests use actual Storage/IDB/WebCrypto/Web Locks and the migration owner
with a no-op client fence; physical and authenticated runtime acceptance remain
open. The media companion slice separately archives exact historical
`call-profile.ts` source from commit `76ee9bc`, proving durable profile-2
retention while the current loader still ignores it.

## Complete-image historical signature binding

The unmounted complete-image consumer resolves room metadata, bookmarks,
access and original startup/navigation links once. While their validated
invitation bindings remain private, it retains each room's distinct inviter
candidates. Conflicting claims for one invitation hold; different invitations
can belong to a legitimate room rotation. No inviter, link or endpoint is
returned to the caller.

`kithmoot.room-relays.v1.<room>` has already passed the strict routing carrier
parser. Its room ID, version and canonical relay list must then verify against
exactly one retained inviter for that physical room. A zero version is valid
historical custody. A signature from a rotated old inviter remains historical
evidence; it cannot select the current startup authority or permit dialing.
Unknown pins, changed signed fields and cross-room substitutions hold without
changing either owner's bytes. The count-only result adds
`historicalRoomRelayRecords`.

Fixed invitation relays are a separate layer. `RelayConnections.setRoomRelays`
persists only `{c,signed}`. The creator writes that row before publishing its
group invitation; owner reopening can mark an existing row signed from key
possession alone. Member join and background lookup authenticate a group
invitation, but the cached/kept admission writers discard its relay list and
signed event. The link's relay hints are unsigned. Thus a fixed `signed:true`
row holds in the complete-image consumer even when its URLs match a link,
the inviter key is present or a later added-relay record verifies. The lower
family parser still recognises its inert writer shape. Unsigned fixed hints
remain inert custody and confer no routing authority.

Recovery must retain the exact GROUP_INVITATION event or an independently
reviewed equivalent proof, its invitation capability and the accepted query
outcome. Revalidation must bind signature, inviter, invitation ID, decoded
room secret, exact fixed list, end and destruction state. Member recovery
must preserve EOSE, conflict and retirement semantics. Creator paths need
atomic event/fixed-list retention before publication. Missing, conflicting,
retired or uncertain evidence must preserve source bytes and hold; no fresh
attestation can silently claim to prove the historical row.

Tests use actual storage/cryptographic writers and exact extracted main
writer source, with synthetic offline keys and surrounding globals. Native
tests seed actual Storage and capture actual location before blocking clocks,
entropy, key allocation, encryption, IndexedDB opens, writes and networking.
They cover creator, kept/tab member, startup-only, metadata-only, duplicate
evidence, old/new rotation, wrong signed fields, cross-room substitution and
fixed-row refusal. They exercise a component barrier, with no production root,
current permission, live peer delivery, release or DG08 acceptance claim.
