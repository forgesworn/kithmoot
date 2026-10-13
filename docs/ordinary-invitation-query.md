# Protected incoming invitation query

`OrdinaryPersistentBootstrap.queryEvidence` now reads actual Fold invitation
evidence through dedicated WebSockets. It is local source and **not mounted in
the production entry flow**. It introduces no default relay, relay pool,
background recovery, reconnect or publication. Its returned completed evidence
is historical custody, not current membership or independent antirollback proof.

The caller explicitly supplies destinations, network profile, carrier generation,
actual WebSocket implementation and a current selection callback. Those terms
are captured once. Native browser/tab migration and the complete composer must
pass before each constructor, raw `REQ` or `AUTH` enqueue and incoming query
observation. Exact opened record bytes, both native revisions, selected operation,
actor invitation fences and participant/link/keep/identity choices must still
match. A generation or `profile: 'tor'` label does not prove a verified Tor route;
the production caller still owes that authority and physical acceptance.

One exact Fold filter requests group invitation and retirement events for the
captured inviter and invitation ID. Every selected relay must return the exact
subscription's EOSE. A slower destination, disconnect, timeout, wrong ID, binary
frame, oversized frame or queue refusal cannot manufacture completed evidence.
Fold independently bounds, copies and verifies the signed events and selection.
The bootstrap verifies the resulting evidence again before device entropy.

Native WebSocket sends remain synchronous. The private wrapper captures immutable
strings and joins a bounded asynchronous FIFO of guarded effects. Aggregate
pending send/observation limits are 32 frames and 512 KiB, with lower caller
limits permitted; query messages after authentication opens additionally have a
128-message cap and 264,192-byte frame cap. Pre-authentication responses have
per-frame and timeout/challenge bounds in the shared authentication wrapper,
without an aggregate message-count cap. Fold has its own stricter event/evidence bounds.
Accepted bytes cannot be retracted when a later forget wins. Cancelled work
closes dedicated sockets; it emits no unguarded `CLOSE` and shares no subscription
with another consumer.

NIP-42 requires a separate explicit grant for the exact relay and actual identity
object, public key and sign method. The signer starts inside a fresh native read
and is awaited outside the origin lock with its original `this`. Exact requested
statement and uncached signature verification precede canonical `AUTH`; `REQ`
waits for that relay's actual authentication ACK. Tor profile refuses grants.
No-consent authentication challenges fail closed. A cancelled unabortable signer
is joined and its late result cannot send or complete the query. A provider must
not await the close operation joining its own promise; revoke and settle first.

Query startup latches before caller getters or callbacks; a second query or
bootstrap cannot re-enter it. Forget and revoke abort it synchronously. Sockets
are synchronously closed and fenced; native, provider and FIFO work is joined
before settlement. Native WebSocket close events are not awaited. A final fresh native
read repeats the complete captured image and choice checks after this cleanup,
including the exact current carrier and authentication grants. Decoded admission
root buffers are wiped; only completed canonical evidence escapes. No encrypted
image is written by querying.

Browser checks exercise IndexedDB, Web Locks, the actual Fold evidence helper,
real signatures and actual localhost WebSockets, with and without NIP-42.
They also exercise queued dial/send ordering, both native fences, identical-byte
revision changes, source choices, carrier replacement, timeout, queue refusal,
provider cancellation and getter/callback re-entry. Public relay, physical Tor,
physical signer, production mounting and release acceptance remain separate.
