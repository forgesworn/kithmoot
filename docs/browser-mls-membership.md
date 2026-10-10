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

## Keeper request intake foundation

`BrowserMlsRevocationInbox` accepts an already-fetched foreground batch. It has
no network subscription, signer approval UI, membership action or grant
withdrawal capability. Its caller must supply the current account context and
foreground state; production imports and account UI wiring remain absent.

One pass considers at most 64 candidate wraps and decrypts at most eight
previously unseen, correctly signed, bounded keeper-addressed wraps. The
existing protocol validates the seal, sender, recipient, rumour lifetime and
inner identity. A fresh witnessed transaction checks replay ids before any
signer decryption; account or foreground changes withhold late results.

The encrypted membership record retains up to 256 wrap ids for nine days and
64 stable sender/keeper/device prompts. Unanswered prompts expire with the
seven-day request. Full journals return an ordinary capacity refusal without
eviction or a persona fence. The inbox shares the existing membership vault
slot and does not reduce the 60-room quota.

Only the keeper's own signed grant ledger can identify affected grants;
request-supplied session and box hints confer no authority. Every retained
room owned by this keeper is checked against its genuine witnessed WASM snapshot,
even when the signed grant's saved room list is empty or stale.
A device currently bound to another person is silently excluded. Missing
room state must be restored before a prompt can be displayed. A signed grant
without any remaining room use can still yield a ledger-only prompt.
Different target devices requested by one sender are flagged as conflicting.
Reading a prompt revalidates both the ledger and roster; it never means that
the keeper has accepted or performed anything.

Unit checks cover malformed/forged wraps, issuer/person/device mismatches,
signer work limits, expiry, clock rollback, capacity, duplicate grant rows,
unavailable witnesses and account/foreground changes during decryption.
Real-WASM Chromium, Firefox and WebKit cases cover a signed ledger entry
conflicting with the actual roster, a valid request, ledger-only intake and
retention across coordinator restart. These use simulated witnesses and
local NIP-44 identities. Network fetching, the operator prompt and explicit
acceptance, live relay and authenticated production-browser acceptance remain
open. Intake cannot clear the existing compromised-device hold or mark a
grant revoked; production MLS remains disabled.

## Keeper decision and advancement foundation

`BrowserMlsKeeperDecisions` separately reviews the actual keeper-owned room
snapshots and all matching signed grants. Explicit approval freezes exact
active and withdrawal event ids, canonical box routes and grant references,
room rendezvous bindings and device leaves in the witnessed membership record.
An explicit dismissal stores no approval and causes no external effect. A
fresh transaction must reproduce the reviewed plan before either decision is
saved. Pending and approved requests for different devices of one sender are
flagged together; this channel cannot prove which device sent the request.

An approval survives request expiry and restart. Every advancement rechecks
all current keeper-owned rosters and resolves only the frozen grant authority;
new grants or leaves, changed credentials and missing snapshots refuse the old
scope. Retained approvals have a separate witnessed listing so failed work
stays visible even after grants are revoked. That listing confers no authority
to perform an effect.

`BrowserMlsKeeperRequestController` composes explicit approval or retry with
the existing room and grant journals. Receiver-side Remove creation verifies
the saved approval in the same witnessed transaction as the engine journal.
Send/Add is held from approval while the device remains in an affected roster,
including before a Remove journal exists, after expiry or a box failure, and
if a ledger-only room later becomes active. Own Update and normal delivery
remain possible so the existing driver can progress an engine-required Update.
The room driver still delivers and acknowledges the persisted MLS outbox.

Each exact device grant is marked `revoking` before its saved signed withdrawal
is published, without the normal 24-hour grace. A refused or uncertain reply
retains the approval and exact statement for retry. Account or foreground
changes stop further work and withhold terminal claims. A failed MLS Remove
does not delay these withdrawals. Room commits, ledger-only handling and box
withdrawals are reported separately; a journal update cannot invent a revoked
grant. Completion requires a fresh witness, exact retained grant outcomes and
committed engine journals where they exist. Confirmed terminal grants are not
republished.

Local signed-ledger tests cover witness refusal, exact retry, restart after
expiry, duplicate retry coalescing and account changes during publication.
Real-WASM cases cover approval and dismissal, send holds before journalling,
refused withdrawal followed by committed Remove and restart, failed Remove
with immediate withdrawal, and a ledger-only request with no fabricated Remove.
Box publication uses an injected local carrier and the witness is simulated.
There is no relay fetcher or operator UI in this foundation. Scope replacement,
pruned-grant completion, forgotten-route terminal handling, deferred prompts,
live relay, authenticated app, process-kill and physical acceptance remain open.
Production MLS remains disabled.
