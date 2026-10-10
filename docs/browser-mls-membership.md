# Browser MLS membership and Welcome routing (P3-05c)

This development-only slice connects Vennel's shared membership journal and
capability metadata to KithMoot's witnessed browser room host. Production MLS
remains disabled and no ordinary room or UI starts these operations.

## Add and Welcome

`addCapabilities` takes ownership of opened WASM capabilities. It calls the
genuine WASM prototype method rather than a caller-overridable property, copies
only package id, Welcome mailbox, home box, leaf id and expiry, and checks the
single-box room, expiry, watch-list collision and bounded unique routes. It
authenticates each D5 registration through the concrete box client before it
opens the witnessed `Session.add` transaction. A permanent registration refusal
therefore leaves no admitted leaf. After an uncertain response the caller must
reopen the same capability record; registration is idempotent and Add occurs
only after the retry succeeds. Every unconsumed handle is freed even when one
cleanup throws.

The Add snapshot and its package routes are one witnessed candidate. The message
driver deposits a Welcome only at the saved route. It retains a plain deposit
that carries no package answer, confirms the pending member when the box reports
keeper acknowledgement, and removes the route with the delivered outbox record.
Delivered Welcome routes are removed atomically with their outbox record. An
expired Welcome that is never delivered remains in the outbox with its route;
automatic cleanup and capacity recovery for that abandoned state remain open.
There is no implicit home-box fallback.

## Removal journal

One sealed persona record holds at most 64 opaque engine removal journals, each
bounded to 64 KiB and bound on read to its operation, session and device/person
target. Invalid outer or inner data fences the persona. Device and whole-person
operations are idempotent by caller operation id. Status exposes the engine's
verbatim claim and its separate MLS, credential and grant states.

Each round asks the shared engine whether to propose, wait, update first or
finish. A successful Remove snapshot and the updated journal are witnessed
together. `Committed` is set only in a second readback transaction where the
live session and the reconciled Rust coordinator are held behind an ephemeral
capability; neither the coordinator nor a generation assertion is exposed.
Transient engine refusals (`CommitInFlight`, `UpdateRequired`,
`AwaitingCommitAck`, `OutboxFull` and `Callback`) stay pending. A terminal
failure waits for explicit retry, but if another applied Remove has already
removed the target it is returned to Pending and committed by witnessed
readback.

A compromised-device intent is saved before the first proposal. Until its MLS
component is committed, this browser refuses new application sends and Adds for
that room. Required own Updates, receiving and driver recovery continue so an
`UpdateFirst` removal can make progress. The hold fails closed when the journal
cannot be read.

## Evidence and remaining boundary

Automated Chromium fixtures use the real pinned WASM, encrypted IndexedDB,
WebCrypto, typed NIP-98 signing and a separately signed simulated witness and
box. They cover registration before Add, lost registration recovery, permanent
registration refusal, exact Welcome routing, route retirement, compromised
holds, transient Remove refusal, failed-to-done catch-up and malformed-journal
fencing. The wider MLS browser suite also runs on Firefox and WebKit.

These are browser automation results, not a live Bothy room, process-kill,
physical-device or production acceptance claim. Credential/grant state changes
are journal APIs only: keeper grant discovery, authenticated revocation and UI
composition remain open, as do dedicated endpoint lifecycle and app wiring.
Abandoned expired Welcome cleanup and a full joined-session
`UpdateFirst` -> Update -> Remove automation case also remain open.
