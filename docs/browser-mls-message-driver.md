# Browser MLS message driver (P3-03c)

`BrowserMlsMessageDriver` connects the witnessed room API to the authenticated
Bothy client. It is development-only: no app or production caller starts it.
Production MLS remains disabled. Membership, account/room UI and live acceptance
state now has its own reviewed slice; grant transport, account/room UI and live
acceptance remain separate gates.

## A round and its authority

A driver captures one room, persona context and paired box client. Concurrent
calls coalesce; a Web Lock serialises that room's drivers across tabs. The lock
order is driver then persona. Network I/O and signing run outside persona
transactions. The caller owns a separate box Link endpoint, supplies its current
account/privacy predicate and shutdown function, invalidates synchronously on
account/privacy/offline transitions, and awaits `close()` before replacing it.
The dedicated witness endpoint must never be borrowed for box requests.
There is no background timer or automatic connection in this module.

Each request first confirms the exact room generation/device under a fresh
persona transaction. This is distinct from session-handle cleanup, which
invalidates the handle's short-lived confirmation. Typed box authentication then
uses the coordinated vault's bounded, unjournalled signing path. Capabilities is
the first box request. Refusal/silence holds; a parsed different installation is
witnessed as RestoreFenced and stops the round. Pending joins have no installation
until Welcome acceptance. The engine clock runs before any outbox deposit.

UI operations can change a room while the driver lock is held. Therefore every
reply that changes state carries the exact generation which authorised its
request, plus box/installation context. Room operations recheck those facts after
fresh witness reconciliation under the persona lock. A competing edit holds the
round; an old reply is never reapplied to a newly guessed generation. Within a
fetched page, only this driver's successfully witnessed results advance its
expected generation. The engine's returned generation is used, not an increment
assumption. Account and route validity are checked after awaits and final lock
cleanup. Withheld effect buffers are owned before stale checks and wiped.

## Delivery, receiving and recovery

Only the durable outbox is sent. Refused/untrusted records hold later records to
the same leaf across epochs. Unknown delivery stops the round and retains exact
bytes. A later round signs again. The vault's timestamp memo is per lifetime:
a same-second restart can produce the same deterministic authentication event.
The box may refuse that event as replay; commit status is still queried with
freshly signed authentication. Mailbox records stay pending until a later retry
is accepted. No timestamp or nonce is supplied by the driver.

Earlier-epoch commits are removed without redepositing. Current commits wait
while the room is in Gap, whose evidence mailbox is still fetched. A slot deposit
without an engine-verified signed receipt stays in the outbox; status reads can
decide it. This is stricter than treating framing or HTTP success as proof.
Commit slots use status routes, never fetch. Signed labels and engine validation
decide slot outcomes.

A fetched record is acknowledged only after an active process result whose Ack
is Now or AfterCommitAck. Keep, a held witness, stale context and failed history
persistence cannot acknowledge. Lost acknowledgement replies stop the round;
a later duplicate can be acknowledged from durable state. Welcome acceptance
uses the round's authenticated expected-box installation and persists that binding
with its snapshot before acknowledgement. A guest's first Update remains required.

Retained mailboxes are fetched individually, with sequential cursor pages. They
are reported drained only after a complete fetch which contained no records, with
its generation still current. Any page containing a record defers draining to a
later fresh fetch after acknowledgements. Default bounds are eight pages per
mailbox, 64 outgoing and 64 fetched records per round; repeated cursors stop paging.

OrderingUnconfirmed queries are stored in encrypted, witnessed room metadata with
the snapshot that emitted them, from every room-effect path. Slot plus attempt
is deduplicated; 1,024 outstanding queries is a hard recoverable bound. Overflow
refuses the whole candidate, without eviction or fencing the persona. Queries
survive reload and lost witness replies. Empty/unavailable/refused/unverified
answers retain them; successful associated `observeReceipt` removes the query
atomically with its resulting state. Existing version-1 rooms without this
optional metadata remain readable.

## Routing limits and evidence

This driver serves one explicit box. Other destinations remain held and counted.
An Introduction requires the saved ceremony's matching peer and resolved box;
it is never inferred from the group's box. Welcome deposits remain held because
their Add-persisted package route must name that exact box and mailbox. The
membership API registers every package successfully before `Session.add`; a
permanent registration refusal never admits the leaf, and an uncertain answer
is retried only by reopening the same capability. Successful Welcome delivery
removes its route atomically with the durable outbox record; `tick` removes
expired routes once no Welcome still references them. No home-box fallback is
used. Grant revocation transport remains separate. The WASM join API still
exposes no group-id pin.

Unit tests exercise ordering, bounded paging, stale replies, cancellation and
buffer ownership. Browser tests use real WASM, IndexedDB, WebCrypto, typed NIP-98
signatures and an independently signed simulated witness/box. They cover Update
slot reconciliation, join/Welcome/expiry, exact lost-deposit recovery, replay
status, received history before acknowledgement, stale account/room replies,
query persistence/verification/lost witness, registration-before-Add including
lost replies and permanent refusal, routed keeper Welcome delivery, and actual
two-tab round exclusion.
The query-capacity test instruments the effect stream around a real engine send
and verifies atomic refusal/retry; it does not claim to create cryptographic
fork evidence itself. These are automated fixture results, not live Bothy room,
Android composition, process-kill or physical-device acceptance.
