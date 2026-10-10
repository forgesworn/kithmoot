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
expired Welcome that is never delivered is removed with its route in one
witnessed transaction, after the full 120-second box clock-skew allowance has
also passed. Cleanup requires one exact package-id/mailbox match, the room's
exact home box and the route's still-pending verified leaf; inconsistent state
remains held. This releases local route and outbox capacity without claiming
delivery, acknowledgement or member confirmation. `tick` still records the
pending member's expiry and proposes its later removal. There is no implicit
home-box fallback.

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

## Grant ledger and membership controls

`BrowserMlsRoomOperations.members` reads verified bindings from the live,
witnessed MLS session. The UI may attach profile labels, but presence, profiles
and invitations never decide which leaf is removed.

`BrowserMlsGrantLedger` keeps one device-wide VMLS grant per Bothy node. Its
scope is `SHA-256("VMLS/1 box grant" || device)`, it reads kind 1460, writes no
event kinds and carries the 64 MiB VMLS ceiling. The exact signed withdrawal is
encrypted and saved before the active grant is published. Installation and
withdrawal use the paired Link route, NIP-42 authentication and an `OK true`
reply. An uncertain reply retries the same signed event. A local clock or an
expired record never becomes evidence that the box revoked a grant.

The encrypted ledger also keeps the bounded, named MLS-room uses of that
node-wide grant, each bound to the exact MLS leaf admitted there. Pending
installation recovery and expired renewal preserve the complete inventory. An
ordinary removal drops only its reviewed leaf's use, and only after its MLS
Remove is committed. The grant stays live while another saved room uses it;
after the last room, a durable 24-hour grace lets the removed device fetch its
Remove before the retained withdrawal is published. An explicitly confirmed
compromised-device removal publishes the withdrawal promptly. Every withdrawal
checks the exact reviewed grant reference under the same node/device lock, so a
replacement grant cannot be substituted. Re-admission has a new leaf, so an old
removal retry cannot detach that new use or restart its grace.

`BrowserMlsMembershipController` binds confirmation to the account, room,
vault generation/revision, exact verified target leaves and exact grant
references. The room operation compares those leaves again inside the witnessed
journal transaction. It records the engine removal journal before external
changes. Compromised withdrawals then progress beside the Remove; ordinary
grant handling begins only after the Remove is committed.
A box failure is recorded as `Failed`, never `Revoked`; retry uses the retained
withdrawal. The compromised-device choice activates the existing send/Add hold
until the Remove is applied and witnessed.

`BrowserMlsMembershipPanel` shows the MLS, credential and grant components
separately. Its final sentence is the engine's `claimCopy` verbatim. Before
confirmation it names every saved affected room and states whether a VMLS grant
will remain shared, enter the 24-hour grace, or be revoked promptly. It also
states that delivered message history is not erased.

## Evidence and remaining boundary

Automated Chromium fixtures use the real pinned WASM, encrypted IndexedDB,
WebCrypto, typed NIP-98 signing and a separately signed simulated witness and
box. They cover registration before Add, lost registration recovery, permanent
registration refusal, exact Welcome routing, route retirement, compromised
holds, transient Remove refusal, failed-to-done catch-up, verified roster reads
and malformed-journal fencing. A complete joined-session case journals removal
of the inviter, observes `UpdateFirst` without a proposal, applies and witnesses
the required own Update, then proposes, applies and witnesses the Remove in
order. The membership panel's confirmation, component states and exact claim
copy run in Chromium, Firefox and WebKit.

These are browser automation results, not a live Bothy room, process-kill,
physical-device or production acceptance claim. The production app's MLS room
lifecycle and automatic driver rounds remain open, as do the P3-08
member-to-keeper request channel and dedicated endpoint lifecycle. Abandoned
Welcome cleanup and the joined-session `UpdateFirst` -> Update -> Remove
automation case are covered. Production MLS stays off until the remaining gates
and the production review are complete.

An uncertain grant withdrawal can also remain `revoking` past its signed
expiration: renewal deliberately refuses to overwrite it, and expiry is never
treated as evidence that Bothy accepted the tombstone. Production activation
needs an explicit recovery or rotation ceremony for that state.

## Retained member requests in the development preview

The account's MLS settings offer **Check retained requests** as a separate
foreground witness action. Opening the settings reads local enrolment only;
it does not read the outbox, discover a keeper or publish a request. A verified
outbox read lists the exact device, authenticated keeper and retained room/box
hints, even without an open room or a local MLS device.

Each unsent record has its own **Send request to keeper** action. It needs the
current account's event signer and private-message encryption, uses the bounded
unauthenticated keeper-directory and relay transport, and repeats the witnessed
outbox checks before marking success. Public-relay recipient, address, timing
and volume disclosure is shown before the action. Relay refusal stays retryable;
the displayed success says only that a request reached a keeper relay. Keeper
receipt, MLS removal and grant revocation remain unconfirmed.

Account, mode, room or panel lifecycle invalidation clears displayed evidence
immediately and holds late results. Quiet and Tor-only modes disable the
network actions. Reopening settings requires another explicit witness check;
a previously witnessed sent marker suppresses another send. This account
action uses the existing development-only preview gate; production room
composition, the keeper inbox and acceptance flow remain open.
