# Browser MLS room operations (P3-03c)

`BrowserMlsRoomOperations` connects the coordinated typed vault to real WASM
creation and Update, and stores room metadata and accepted chat history in the
witnessed persona transaction. It has no app, UI or network caller. Production
MLS remains disabled; this slice does not close P3-03c or P3-06.

## Signing and ownership

Creation reads the current public device credential, prepares a one-shot engine
operation, obtains scoped typed signing consent outside the writer lock, then
completes under a fresh witnessed transaction. Device, credential, approval,
account and expiry are checked again before completion and effect release.

Update needs two transactions because the engine keeps its pending private key
in memory. Phase one opens the exact witnessed predecessor and prepares without
changing its generation. Only after that transaction fully closes may consent
begin. Phase two checks the predecessor's generation and SHA-256 snapshot digest,
then rereads the latest room metadata and device/approval under the writer lock.
A concurrent send or Update prevents stale completion; a room-only rename is
preserved. The handle stays private to the operation and is never cached for reuse.

Both pending operations expire within the engine's 600-second RPC lifetime.
Invalidation wakes unresolved consent and disposes the owned handle; late signer
answers cannot complete it. Cancellation callbacks always wake, even if freeing
throws, so one failure cannot strand another operation. Cleanup failures surface
through the awaited operation and withhold results. Platform ownership ends only
after engine cleanup, with current credential and binding expiry checked again.

## Durable room data

Room index and records are encrypted vault records covered by the same witness
advance as their engine snapshots. Each record binds session generation, device,
credential id, rendezvous key, box identity and installation. Missing, malformed
or mismatched metadata fences access. Creation stores name/binding alongside the
first snapshot. Reads currently require fresh witness confirmation.

Send requires a stable 32-byte caller operation id. An identical retry returns a
local duplicate without advancing the ratchet; reusing the id with different
plaintext is refused. Accepted receive plaintext is stored before the snapshot
can be acknowledged or any fetch acknowledgement released. Received history ids
use the envelope digest; engine duplicate handling prevents repeated history.
An interrupted promotion or lost witness reply is reconciled on reopen, retaining
both history and durable outbox. Callers recover that state instead of replaying
provisional effects.

Bounds are explicit: 60 rooms per installation, 512 history messages and 1 MiB
of plaintext per room. Full history refuses the operation atomically; entries
and deduplication ids are not evicted. The generic host also retains its existing
1,024 lifetime session-id adoption bound. There is no room-delete UI/API yet.
Buffers owned by these operations are wiped when withheld or consumed. History
encoding uses JSON/hex strings; JavaScript cannot explicitly erase strings or
promise physical erasure of runtime copies.

## Acceptance and remaining work

The fixture uses shipped Rust WASM, IndexedDB, WebCrypto and an independent
witness signer. It covers typed create/Update, competing mutations, rename,
revocation/replacement/withdrawal, pending expiry/invalidation, cleanup failure,
short binding expiry, interrupted stage/promotion, lost accepted witness replies,
send retries, received plaintext recovery, deduplication and storage bounds.
A fixture-only guest creates real Add/Welcome/Update and encrypted message input;
that guest is not a separately persisted or independently accepted client.

`process()` expects its future driver to authenticate box replies, mailbox and
receipt framing, and capabilities. It checks the room's box identity, passes
installation changes to the engine, and persists engine results. It does not
establish transport authenticity itself. Creation similarly requires a box and
installation supplied from authenticated capabilities.

Still required: typed join and membership operations; strict box client/driver
with capabilities and installation checks on every reply, Gap fetching, outbox
ordering and lost-reply reconciliation; encrypted drafts and explicit offline
history policy; UI/account wiring; real-Bothy, Android/browser and physical-device
acceptance; and production enablement review. No automated fixture here is a
live-room or physical acceptance claim.
