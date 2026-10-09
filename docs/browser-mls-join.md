# Browser MLS typed join and recovery

`BrowserMlsRoomOperations.join()` adopts a real WASM PendingJoin under the
persona witness. The application and box driver do not call it yet. Production
MLS remains disabled. This is the joiner side; inviter membership operations,
package registration, transport and UI remain separate.

## Custody and completion

The caller supplies the current provision receipt, including the retained NIP-46
client device, child index, public key and expiry. That device is distinct from
the MLS device which signs the leaf binding. Only the provisioned rendezvous
child performs ECDH; neither the persona identity scalar nor the MLS device
scalar substitutes for it. The encrypted source verifies account/device, the
exact receipt and scalar-derived public key. ECDH answers are opaque one-use
objects, bound to the exact operation, peer and deadline. Shared-byte copies
are wiped at consumption or abandonment, with no string encoding/cache.

Browser rendezvous storage uses a shared Web Lock. The order is rendezvous,
then persona; callers must never take these locks in reverse. Mutation invalidates
through a synchronous localStorage revision before waiting for the lock. Join
captures that revision before queuing, checks after acquisition, and retains the
source lock through consent, witnessed adoption and cleanup. A 50ms check wakes
an unresolved pending operation after cross-tab invalidation. The pending WASM
handle expires within the earlier of its 600-second request deadline, provision
expiry or binding expiry. Mutation may wait for current bounded witness/cleanup
work; it does not race the final transaction. An abandoned tab releases Web Locks.
The source must provide these lock/revision primitives; unsupported sources fail
closed. Same-origin clients must use this shared vault API when mutating its data.

The signature and ECDH requests must share the engine's operation and deadline.
After consent, completion freshly checks the current MLS device/credential,
scoped approval, same-object signature provenance and current child. Snapshot,
room metadata and session-id ledger are witnessed together before Introduction
bytes are released. Account, child revision and expiry are checked again after
source-lock release. A stale result is wiped even if adoption already committed.
Late approval after cancellation cannot save a signing permission.

## Pending state and recovery

A pending room has an explicit null installation; the engine has no group home
box yet. Its encrypted metadata retains the expected home box, inviter rendezvous
key, explicitly resolved Introduction box, counter, expiry and stable caller
operation ID. The supported ceremony uses one expected box for this leaf and
its eventual group; the Introduction box is separately explicit. The WASM adapter
does not expose a group-id pin: this API does not claim to verify a preselected
group ID or invitation UI beyond those stated bindings.

Use a fresh operation ID for a deliberate new join. Retrying an existing ID
refuses `join-exists` inside the final transaction and cannot adopt a second
session. After uncertainty or restart, `findJoin()` resolves that operation ID
under fresh witness confirmation, then `read()` recovers its exact durable
outbox. This does not need a still-live provisioned child. The existing lifetime
adoption ledger prevents reused session IDs; there is no room deletion API.
The [message driver](browser-mls-message-driver.md) now calls the engine's
clock/expiry operations before sending a pending session's outbox.

## Welcome and first Update

`process()` requires its caller to supply authenticated capabilities for the
expected home box. The engine checks the Welcome and pinned installation; a
wrong installation cannot join. The accepted Welcome snapshot and non-null room
binding are persisted together before an acknowledgement can be released.
Interrupted writes and lost witness replies recover that transition atomically.
Send refuses a pending join and a joined guest whose required first Update has
not completed. Existing typed Update then provides the witnessed commit path.
Transport authenticity, package registration before Add, Introduction/Welcome
routing and box acknowledgements remain driver responsibilities.

## Evidence and limits

Tests use the shipped WASM, real browser IndexedDB/WebCrypto, encrypted NIP-44
provisioning, verified leaf signatures and an independently signed simulated
witness. The inviter and box transport are fixtures. Coverage includes reload,
first Update/send, wrong Welcome installation/box, source substitution/expiry,
queued and cross-tab clear, replacement/revocation, never-returning and late
consent, copied signature replies, lock-release races, uncertain adoption,
lost witness replies and repeated operation IDs.

These are browser automation results, not real-Bothy room transport, Android
composition, OS process-kill or physical-device acceptance. This slice also
hardens the existing production rendezvous vault's cross-tab storage access and
removes an unwiped temporary scalar copy; it changes production build bytes
without enabling production MLS.
