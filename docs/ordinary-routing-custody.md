# Routing record custody

This unpublished pure helper validates routing writer formats and returns
frozen numeric counts. No endpoint, scope, room, mark, signed flag or signature
is returned. The complete same-image composite, production root, real client
fence and durable-before-effect consumers remain open; DG08 is not complete.

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
retained inert. The required complete composite must verify it against the
authenticated same-image room authority before any authority-bearing consumer
can use it; current permission and effect fencing remain separate runtime gates.

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
