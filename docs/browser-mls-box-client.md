# Browser MLS box client (P3-03c prerequisite)

`BrowserMlsBoxClient` is a development-only client for the existing Bothy VMLS
routes. The development-only [message driver](browser-mls-message-driver.md) now
uses it; there is no application or production caller. Construction
does not load WASM, sign, open storage or connect. Production MLS remains disabled.
This client alone does not close P3-03c or P3-06.

## Authentication and ownership

The constructor checks the signed Link card of an already paired route against
the requested box identity. The endpoint must have accepted that card through
Link's full verifier. The caller owns that endpoint and route: keep the same
verified route installed, invalidate this client before replacement, and await
endpoint shutdown on account/privacy changes. Never borrow the dedicated witness
writer outside its existing persona-lock lifetime. This client neither starts nor
stops a Link endpoint; account integration must supply that
lifetime and its current-context predicate.

Each request copies its input and hashes those exact bytes. The coordinated vault
signs an allowed route under its existing device/box/principal consent scope. The
client accepts the exact reply's provenance immediately before dispatch. Retries
and status reads sign afresh. Vault/context checks surround every await and suppress
late replies. Signer faults propagate; transport faults are uncertain outcomes.

At most 32 underlying operations may remain outstanding in one client, including
timed-out work until its signer/transport settles. Signing and transport share a bounded
20-second default deadline (configurable from 1 ms to 60 seconds); invalidation
wakes waiters. A late consent result cannot dispatch a request. A dispatched request
may still reach the box after timeout or invalidation, so drivers must retain
the durable outbox and reconcile with a fresh signature. A consent answer that
arrives after cancellation is treated as denial and cannot save a new approval.

## Checked wire facts

- Capabilities use the shipped engine's strict parser, returning its installation.
- Success and refusal codes must match their HTTP statuses. Unknown refusal codes
  are malformed, preserving fail-closed behaviour for future protocol changes.
- Response objects have exact required/optional keys, safe unsigned integers,
  canonical base64 and lowercase 32-byte identifiers. Duplicate JSON keys,
  escaped duplicate aliases, excessive nesting and invalid UTF-8 are refused.
- Deposits and fetched records must name the SHA-256 of their exact envelope.
  Fetch records must belong to a requested mailbox; duplicate records are refused.
- Slot receipts must be exactly 197 bytes and agree with the node, slot, attempt
  and envelope hash stated in the response. Filled/expired/void facts must agree
  with the requested attempt. The engine still verifies the signature and
  installation; JSON status is never a substitute for the signed label.
- Package registration uses the contracted deterministic package/mailbox hash and
  a caller-supplied authenticated server time to enforce the seven-day horizon.

Bounds match the box/Link contract: 1,048,620-byte envelopes, 128 KiB ordinary
responses, 2 MiB fetch/slot-status responses, 16 fetched mailboxes and 64 records or
acknowledgements. No cursor is followed automatically and no record is acknowledged
automatically. Valid reply data is not permission to release an engine effect.

## Evidence and remaining integration

Unit cases cover framing, body/signature correlation, route identity, refusals,
resource bounds and late/cancelled operations. Chromium, Firefox and WebKit cases
use the real witnessed vault, verify its NIP-98 signatures, and use the real WASM
capabilities parser. Their transport is simulated; this is not live Bothy, cross-
client or physical-device acceptance.

The [typed join](browser-mls-join.md) and [message driver](browser-mls-message-driver.md)
now supply the room-side ceremony and driving rules. Request methods accept an
additional lifetime predicate, checked through signing and dispatch, for pending
join/evidence expiry. `isCurrent()` exposes account/privacy validity to the driver.
Endpoint creation and app wiring, membership, offline policy, real-box composition
and production-enablement review remain open.
