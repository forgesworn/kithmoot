# Native relay carrier source

`app/src/ordinary-relay-carrier.ts` wraps the actual `NostrRelayPool` with
asynchronous, genuine browser/tab reads. Its first-credential incoming-member
owner is described in [native member sessions](ordinary-member-session.md).
Production root and complete room lifecycle integration remain open.

The component captures an immutable relay configuration, exact native owner
instances, scoped generations/fences, and the complete acknowledged browser
and tab images including their revisions. Every socket constructor, actual
socket write, socket callback, verified pool event callback, history completion
and publication acknowledgement repeats complete native composition and the
mandatory additional room validator. An unrelated same-byte revision holds
the component too; reopening is required. No supplied callback replaces native
storage or supplies a fabricated pair token.

The callback facade exists because extending a real WebSocket would dial before
an asynchronous read could authorise it. It preserves the string bytes queued
by the real pool. It admits REQ, EVENT, AUTH and CLOSE writes, and caps a frame
at 2 MiB and the shared queue across all sockets at 256 frames / 8 MiB. There
are at most four simultaneous sockets per configured relay and 128 distinct
subscription plans. Input events and filters are detached data fields before
waiting; accessor-backed payloads are refused. This is the callback interface
nostr-tools consumes, not a complete DOM WebSocket replacement.

An EOSE handoff requires at least one configured reader and actual EOSE frames
for the exact current socket, subscription id and filter plan at every reader.
The real pool and its dependency can otherwise call EOSE after a timeout or a
closed reader. Such completion holds and closes this carrier. A write-only
carrier can publish but refuses subscriptions; duplicate subscription plans
also hold. Neither a timeout nor a partial replay becomes admission evidence.

For account NIP-42, the selected genuine `OrdinaryForegroundSigner` borrows its
private implementation with this same native restriction at the actual SDK
attempt and handoff. Concurrent relay challenges are serialised per signer.
Visitor NIP-42 uses only the acknowledged native participant key and its named,
exact statement helper, even if the consent object has an external provider.
Provider results remain joined after cancellation and cannot produce late
frames. The parent live guard and additional validator must bind the current
participant, role, room proof, route and explicit relay consent; this class
cannot infer those choices from a stored key or configured endpoint.

`OrdinaryStateOwner.retainPairResource` retains the carrier on both actual
native lifetimes from a current read. Closing either owner and database
invalidation revoke sockets synchronously, and the tab deadline has a timer
even when the carrier is idle. Revocation then joins queue, SDK provider and
real pool publication work. Releasing a resource unregisters its timer and
callbacks. Registration grants no permission to sign, dial or mutate.
The callback facade emits one cancellation close notification to settle pending
pool connections even after revocation. That lifecycle signal dispatches no
incoming frame, history completion or private application callback. An optional
owned `onClose` notification lets the member factory revoke its protocol too.
As with native reads, revoke/close callbacks must not await the owner which
is joining their work from inside a pair callback.

The pool acknowledges publication after its first successful relay. That is
an actual relay acknowledgement, not local persistence or every-relay delivery.
Slower pool fan-out/retry tails remain live under the same guards; closing the
component aborts and joins them. The component does not add durable publication
intents or guarantee delivery if a native lifetime ends.

## Evidence boundaries

The browser suite uses actual encrypted native owners, complete composition,
the real relay pool and SDK classes, controlled route/wallet scheduling, and
actual loopback WebSockets with and without NIP-42. Controlled callbacks do not
establish a deployed route, Tor isolation, a physical device or an actual wallet.
The dependency and lockfile now pin published `signet-login@0.18.2`. See
[SDK provenance](ordinary-sdk-provenance.md) for the release evidence and the
separate limits of earlier development-overlay receipts.

The [member factory](ordinary-member-session.md) now owns a genuine first-credential
`RoomSession` and its supported private preparation. Renewal, board invitation
verification, explicit legacy recovery, protected startup and every application
carrier remain open.
The additional validator is a restriction, not independently verified current
membership. Current MLS admission authority and permanent independent allocator
continuity remain open; production MLS remains disabled.
