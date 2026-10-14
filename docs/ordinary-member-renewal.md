# Native member renewal lifecycle

This is the implementation contract for extending the owned member session.
Renewal preserves the signed admission evidence and its end, relay and scope
rules. It supplies no current MLS authority or independent rollback protection.
The first-credential session checkpoint is not completion of this lifecycle.

The current source implements strict lease parsing, native input preparation,
whole-image composition and actor-scoped removal. It does not implement the
renewal producer, pre-entropy reservation, signing/ACK coordination or Session
handoff described below. The first-credential factory still refuses renewed
material. Offline custody remains readable after sign-out or account replacement;
only a new genuine Fore check at preparation/open can authorise account effects.

## Selected successor

Retain a versioned encrypted member lease beside the existing V2 proof. Each
successor replaces that tab's selected V2 device snapshot with the exact new
signed credential; its admission evidence, capability, room secret, original
keep timestamp, actor/native/device scopes and keep choice stay byte-identical.
The existing admission writer records are not refreshed. Other actors and inert
historical tab proofs are preserved.

The lease contains the original bootstrap proof, immediate predecessor proof
and predecessor header. Its canonical header binds the original bootstrap
operation, predecessor lease operation, selected current proof operation,
credential ID/seal/created-at/expiry, sequence, immutable authority components and
the complete predecessor browser/tab image commitment with both revisions.
A header's operation is its domain-separated canonical hash. The predecessor
header is independently hashed and its sequence must immediately precede the
current one. The source commitment is SHA-256 of the domain and both native
images' purpose, expiry, generation, revision, sorted fences and sorted exact
record bytes, in code-unit order. It excludes keys, frame nonces/ciphertext and
the successor. This bounded local lineage is not an independently permanent log.

The first predecessor header is sequence zero, reconstructed from the actual
selected bootstrap credential and the current native read. Later construction
must use the actual previously selected lease, not a caller-provided ancestor.
The first credential's requested expiry remains the bootstrap intent; current
usability is read from the selected successor. No old completion may move that
selection backwards or overwrite a later acknowledged operation.

For keep:true the browser lease and selected tab lease have exactly equal bytes
and the matching V2 proof pair. For keep:false the full proof, lease, own device,
credential and private seal history remain only in the exact tab. No browser
fallback, promotion or synthetic device exists. New credentials use the same
room device; actual ownership and complete composition remain mandatory.

## Capacity, signing and commit

Before any new seal entropy, reserve both revision+1 images, complete proof and
lease values, actual writer cells, seal history and actor/device lifecycle fences.
The signed credential is an actual Fold credential from genuine Fore signing
or native visitor participant custody. Start the signer under the predecessor's
fresh paired read; await outside the lock. At handoff repeat the composer,
complete image/revision/scopes, actual session epoch and exact room/device/seal/
created-at/expiration template. Timestamp restamping is refused.

Store `tabExpiresAt` (milliseconds), `admissionEndsAt` (seconds or null),
`foregroundExpiresAt` (milliseconds or null) and `membershipEndsAt` (seconds or
null) individually. Their minimum, converting milliseconds down to seconds,
is `authorityUntil`. The native tab and signed admission supply the first two;
only a genuine current Fore instance supplies the third. No separately validated
membership producer exists yet, so this checkpoint requires the fourth to be
null. All four are immutable across successors. The bootstrap credential expiry
is the first credential intent, not an authority ceiling. Every new credential
expiry must strictly advance its predecessor and remain at or below
`authorityUntil`. Renewal never refreshes these authorities or treats EOSE as a
new grant.

Each actor/invitation/tab lease uses the physical name
`kithmoot.account.<participant>.kithmoot.member-lease.v1.<invitation>.<tab-id>`.
It contains exactly two independently verified proof strings and two fixed
headers, never a nested lease or a recursive ancestor list. There are at most
64 browser slots per actor/invitation and one selected slot per tab; each proof
is at most 1 MiB and the raw UTF-8 lease at most 4 MiB + 16 KiB. This native
renewal schema requires one exact own credential per embedded device snapshot;
it does not relabel legacy secondary-credential custody. The complete
image, record and fence limits still apply.

Private seal history remains at most 128 keys. Deterministic pruning keeps the
current credential's seal and the most recent 127 predecessors, but may run only
after the composer proves every retained current/historical device proof and
in-flight operation remains usable. A bootstrap proof embedded in a lease is
verified as historical evidence and does not require its original private seal
forever. An unsafe pruning plan holds before entropy; capacity is not reclaimed
by silently deleting proofs or fences.

One paired candidate replaces credential, seals, selected V2 proof and lease.
An unknown acknowledgement owns the exact frames, signature and secret until
reconciliation, even after expiry or revocation. Retry never regenerates them.
After a classified definite abort, wipe the candidate and require an explicitly
fresh attempt against the unchanged predecessor. A mixed/unknown result cannot
be called a definite abort.

## Atomic handoff

Synchronously latch a shared quiescing generation before draining. Every facade
start, timer, protocol run, socket constructor/write, AUTH attempt, incoming
callback, retry and handoff must either carry the preceding generation's owned
work ticket and be joined, or be refused/deferred. The origin Web Lock alone
does not provide this suspension. Intrinsic roster/heartbeat/rekey work owns
its complete promise through handoff, not only its preparation. Existing wallet
and acknowledgement continuations retain their generation and must finish
without joining the renewal promise itself. A bounded drain timeout makes no
writes and closes the old session.

Drain observations registered before the latch and fence subsequent general
socket observations. The sole old acknowledgement exception must identify an
already-sent event, destination, raw socket and generation; arbitrary EVENT,
EOSE or OK frames cannot keep the drain open. The existing ingress bound is
256 frames / 8 MiB, with terminal close on overflow. Continuous incoming traffic
cannot postpone the drain or accumulate behind an unknown-ACK write lock.
Reconnect and resubscribe under a freshly authenticated unchanged predecessor
after a definite abort, or under the acknowledged successor after adoption.
Old callbacks remain fenced; they never acquire the resumed generation.

After acknowledged commit, one fresh paired read authenticates the exact
successor. In that same read swap the private root selection, expected full
image, credential/seal set, expiry and timer, and the relay carrier's expected
image. The old executor cannot continue authorising effects. Return from the
existing `retainCredential` continuation while shared suspension remains active.
RoomSession then adopts its credential and seal in that existing continuation;
there is no new raw Session mutation API and no asynchronous adoption inside the
synchronous native read. Revalidate the exact adopted state under a fresh guard
before unpausing timers and work. Never await a provider or owner close inside
the read.

A failed handoff after commit closes and wipes the old session. Reopen must load
the committed successor; storage is never rolled back. Close/forget synchronously
revoke, join signing/reconciliation and erase candidate buffers. Unknown ACK
keeps the old effect lease blocked/revoked until exact candidate classification;
close/forget joins reconciliation outside the held lock and never waits for
itself. A classified definite abort wipes the candidate and requires a fresh
predecessor read/reopen, rather than reusing a partially advanced guard. Forget removes
the selected actor's lease together with its proof and advances the correct
fences, preserving unrelated actors and rows.

## Acceptance still required

The bounded first-credential implementation now has a shared ownership graph.
It registers queued roots and descendants before their first await, keeps a
parent nonterminal until its descendants finish, expires completed scopes and
uses the exact producer root as its only drain exclusion. An abandoned producer
or drain timeout closes terminally. Rejected retention cannot attach new native
owner lifetimes. Synchronous nested task starts reuse an existing genuine native
callback; asynchronous data/refusal handoffs still require fresh native reads.

The native session's heartbeat, presence sweep, reply and renewal timers are
fenced at suspension, including callbacks waiting for a native read. Original
deadlines remain fixed and missed periodic ticks coalesce. A fresh admission
wait cancels and unsubscribes when suspended. Caller-held prepared chat closures
acquire fresh ownership only when published. Pool fan-out after the first ACK
remains owned through actual settlement and close joins it.

The carrier now latches suspension before cancelling recovery, read-back,
subscription bindings, retry delays and unfinished dials. Background promises
register before their first await. Each pending dial has its own cancellation
signal, so dependency cancellation cannot strand it until its connection
deadline. Shared dial reservations use opaque receipts, consumed at the first
success, failure or cancellation. Duplicate/late callbacks and cached connection
work cannot release another pool's reservation. Local cancellation preserves
prior relay backoff. Already started AUTH providers remain joined; queued AUTH cannot start
another provider after the latch. No general incoming observation or new socket
write is admitted while paused.

Only an exact canonical OK for an already sent event on its original raw socket
and generation may enter as a child of the still-owned publication tail. Each
receipt can be claimed once. The socket stays alive until the dependency has
actually consumed its claimed ACK and the full publication fan-out settles.
Negative ACKs settle refusals without retries. Freshly guarded abort resume
recreates readers, keeps logical event deduplication and original absolute
history deadlines, and preserves already completed history. Old callbacks stay
fenced. Original bounded binding evidence survives already registered handoffs;
fresh bindings clear it and use fresh wire subscription IDs. The route-facing
pool type omits suspension controls; that type is not a
runtime capability boundary.

These pool, graph and timer changes do **not** activate native renewal. The
candidate producer and atomic acknowledged Session adoption remain
unimplemented. Browser suspension tests use actual native owners with a local
graph controller; they supply no production successor or MLS authority.
General catch-up timers are outside this
bounded factory, which still sets `epochCatchUp:false`. The first-credential
factory refuses minting a replacement before entropy; refusal leaves the old
credential usable only until its original fixed expiry.

Exercise actual native owners and the real session for renewal, restart, both
keep choices, concurrent tabs, exact-byte ABA, delayed predecessor completion,
unknown ACK and definite abort, rekey/expiry/forget during signing and commit,
commit-then-handoff failure, seal-history decryption, full capacity and fences,
and malicious/restamped signer results. Include continuous incoming traffic,
drain-boundary and timer-overlap races, queue overflow, failed post-commit
adoption, reconnect after unknown ACK and immutable authority versus advancing
credential expiry. Test every protocol/timer path against the suspension and
swap. Schema/source, automated, independent review, production
mounting, registry release and physical acceptance remain separate gates.
