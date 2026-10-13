# Guarded creator delivery

This is unpublished source preparation for the protected client. The production
PWA does not call `OrdinaryInvitationCreator.publish`. It does not establish
current admission, keeper/rekey authority, an independently verified Tor
carrier, independent rollback protection, production registry reproducibility,
or physical/browser–Android MLS acceptance.

`publish` requires an already durably retained creator event and pending intent.
It never creates or re-signs an event, adds a default/public relay, or silently
repairs a legacy owner. Publication destinations, profile and operation remain
bound to the retained proof. The caller explicitly supplies the selected
carrier implementation/generation, current carrier and per-relay NIP-42 consent.
Those callbacks supply current application authority; their strings and saved
URLs do not prove it. Tor requires validated onion destinations and refuses
identity authentication. The caller still owes a verified Tor carrier and fresh
persona policy. There is no automatic reconnect; an explicit retry must pass
fresh custody and carrier decisions.

## Effect and cancellation boundary

Every socket construction and actual synchronous `WebSocket.send` occurs inside
a coherent authenticated browser/tab read under the same origin-wide native
write lock as mutation and forgetting. That callback verifies the complete
protected image, exact creator operation/event, selected link/owner/fixed list,
browser generation and both invitation scopes/fences, tab lease, proof end,
current selection and exact carrier generation/profile/implementation/consent.
It invokes no awaited network operation under that lock. A synchronous start
latch prevents reentrant getters/current callbacks from opening a second run.

The private socket adapter owns immutable text frames. It accepts only the exact
retained EVENT or an independently verified AUTH statement for that socket's
explicit identity, relay and challenge. It rejects binary, unexpected and
repeated frames. A per-socket FIFO and aggregate ceilings (32 queued/in-flight
frames and 512 KiB by default; callers may only lower them) hold on overflow
without dropping a subset. These bounds do not claim a browser buffer quota.
The asynchronous custody read is joined through a failure latch because native
`send` itself returns void. Frames waiting for the native lock recheck all
bindings before enqueue. Close/abort/deadline stop new dials and sends
synchronously and join owned guard, queue and receipt work.

A cooperating forget which wins the lock prevents a queued dial/EVENT/AUTH.
If an enqueue wins first, those bytes have been accepted by the browser before
forget; they may reach the relay afterwards and cannot be retracted. This is a
linearisation boundary, not a claim that WebSocket transport can revoke already
accepted bytes. Explicit signer invocation starts within a guarded callback;
the signer promise is awaited outside the lock. Cancellation stops the owned
AUTH continuation. An already requested external signer operation can still
finish, but its result cannot start a later dial or enqueue.

## Receipts, uncertainty and retry

An exact, positive relay OK is accepted only from the private current socket
which actually enqueued that retained event. That creates a private, unforgeable
receipt obligation. The native writer revalidates complete custody, operation,
source, carrier, consent, lease/expiry and both fences, then merges that exact
destination into the intent. Duplicate OKs cannot create duplicate obligations.
False or malformed OKs refuse; wrong-event OKs cannot advance intent.

Network stop prevents new obligations. A receipt already accepted while current
may finish native retention after another connection fails or the network
deadline passes. It cannot survive owner close, abort, source/fence/generation
change, expiry, carrier revocation or identity-consent withdrawal. Thus known
partial delivery is retained without admitting late/stale callbacks.

The first ACK does not complete publication or cancel the slower destinations.
Success requires every configured destination's observed receipt to be durably
retained and a final fresh guarded native read. A durable ACK is a receipt from
the explicitly selected transport, not membership/current-authority evidence,
proof of global relay storage or independent delivery proof. Partial/refused/
timeout outcomes hold exact custody and observed receipts for explicit retry;
the retry sends the same event only to missing destinations.

Unknown paired native acknowledgement retains the same encrypted candidate and
native lock until explicit reconciliation. Neither publication nor close reports
completion early. Retry does not rerun the writer or allocate replacement AES
nonces. A committed candidate is reconciled byte-exactly; a definite abort keeps
both prior frames. After restart/reopen, a durable receipt is recognised before
any retry dial, so already acknowledged destinations are not resent. Native
uncertainty is distinct from a network deadline: owned native reconciliation
must finish before the delivery operation can settle.

## Acceptance scope

The delivery spec uses real IndexedDB, non-extractable native keys, AES frames,
coherent native locks, actual persistent invitation and NIP-42 encoders and
owner/intent writers. Controlled carrier cases exercise exact send/forget order,
queued generation/fence changes, cancellation, queue pressure, signer refusal,
late signer results, duplicate/malformed/stale receipts, partial retries, and
lost or aborted native ACK commits. These are controlled effect fixtures.

Separate tests serve the harness over a real loopback HTTP server and use real
browser WebSockets against a local relay, verifying canonical EVENT/AUTH bytes,
signatures and destination receipts. A synthetic HTTP response caused Chromium
local-network access refusal in an earlier harness; the corrected harness uses
an actual loopback response without weakening browser network protections.
These offline wire tests establish browser transport behaviour, not deployment,
independent production relay acceptance or a physical Tor/device run.
