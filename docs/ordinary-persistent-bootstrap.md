# First-member protected bootstrap

`OrdinaryPersistentBootstrap` now constructs a fresh incoming member's device,
seal key and actual Fold credential, and retains them together with verified
admission evidence in one acknowledged native browser/tab candidate. This source
is **not mounted in the production entry flow**. Bootstrap itself creates no
relay transport or default pool. Its explicit [member-session factory](ordinary-member-session.md)
now owns a genuine initial-credential session and native relay carrier. Neither
component provides current production MLS membership, keeper, rekey or independent
antirollback authority.

## Captured intent and custody

Open captures the actual participant identity object, public key and sign method,
account or visitor-null choice, exact invitation, link, keep choice, credential
expiry and current/live callbacks before native waits. A visitor must already
have its exact global participant in protected browser custody. Neither this
adapter nor a caller's decoded admission invents a participant or first root.

An account selection requires the actual native `OrdinaryForegroundSigner`;
a generic account `ParticipantIdentity` is refused before device entropy.
Its borrowed signer rechecks this bootstrap's exact owner instances, invitation
scopes, selected source bytes/revisions, keep choice and credential lifetime in
the **same** native read as every real SDK attempt, retry and result handoff.
Visitor credentials are signed synchronously from the matching acknowledged
native participant key, with exact room/device/seal/expiry tags. The caller's
generic sign method is not invoked. Both paths join whole component work with
both owner lifetimes, including unabortable SDK operations.

The dedicated invitation-query carrier uses these same account/visitor signing
boundaries for NIP-42. Shared SDK signers serialise relay authentication, and a
refusal cancels queued relay attempts. This implements these source consumers;
general room transports and the production root are still unmounted. See
[native visitor signing](ordinary-native-participant-signing.md).

The native pair must have completed migration and pass the complete composer.
Open pins the selected operation, or exact absence with full browser/tab record
bytes and both native revisions. A stale instance cannot adopt or forget a
successor written by another instance. Native revisions also distinguish a
writer which commits identical record bytes; record equality alone misses that
race. Scope generations and deletion fences must match at every read/write.

The producer captures both scopes as `invitation:<participant>:<invitationId>`.
V2 proofs explicitly carry those exact names. Historical V2 global invitation
names remain readable with their original meaning; browser and tab names must
match, and Bootstrap refuses to adopt a global-scope proof. V1 browser-device
semantics stay unchanged. Actor scoping lets forget revoke this participant's
custody without invalidating another participant's proof for the same invitation.
The device scope still binds the actual `room:<roomId>` generation and fence.

## Construction and retention

`bootstrap(evidence)` accepts only actual bounded completed-query Fold evidence.
It independently verifies the signed source and derives the first root.
`queryEvidence` now provides a dedicated native guarded carrier for explicitly
selected destinations (see `ordinary-invitation-query.md`). The caller still owes
actual transport consent and current lane authority. EOSE
is a local query observation, not global absence or current authority.

Before first-use randomness, the complete pair must match the opened image and
have no conflicting room device, epoch, bookmark, owner, admission, proof, fixed
route or other account's room metadata. An exact own `keep:false` link may remain
from an expired tab; rejoin cannot extend a known end, revoke destruction or
resume an ended room. A link previously bound to another room cannot redirect
this invitation's root.

Capacity projection is synchronous and available only within the live opaque
native pair callback. It checks exact source bytes, actual headers, both next
revisions, migration and fences, including reservation of both authenticated
actor invitation names at their current fence values. Only native Maps in data fields are accepted;
no callback-backed or thenable proposal, mutable image, key or mutation authority
escapes. Both proposed images are sized before device/seal entropy or signing.

The reservation uses the exact future record names and real metadata/admission
writers, fixed-width device/seal values, a 4096-byte credential ceiling and the
existing 1 MiB proof/envelope ceiling. Canonical JSON text has no raw control
characters or lone surrogates, so its native tuple encoding costs at most twice
its raw UTF-8 bytes; one quote per reserved byte bounds that escaping. Actual
values must satisfy those bounds again before retention. This conservative
reservation may refuse a nearly full image whose eventual values would fit. It
proves profile capacity, not browser quota or memory availability.

Actual `deviceKeyFor` sees only this room's logical name in a private provisional
view; its pruning cannot observe other browser or tab rooms. Exact helper
readback is checked. The actual Fold seal generator supplies the independent
seal key. No partial native identity is written before signing.

A second authenticated pair read repeats the complete composer, full-byte and
revision comparison, room scope, conflicts, identity/current choices, lease,
admission end and credential expiry. It invokes the captured provider method
with its original `this` synchronously, through actual Fold credential creation,
then awaits the result outside the origin lock. The credential must have the
exact room, device, seal, issuer, expiry, kind, empty content and requested
`created_at`, plus its verified signature and strict historical shape. This
bootstrap currently refuses remote timestamp restamping, although Fold's general
room credential API permits it; physical signer/provider compatibility remains
unaccepted. No global sign-once claim is made: two tabs may sign before one loses
the native source comparison.

One paired write retains the exact device/owner/credential/seal writer records,
room link and choice, actual admission and V2 proof. `keep:true` places primary
identity, admission and proof in browser custody. `keep:false` places primary
identity, admission and private proof only in the tab; the browser retains only
the global participant, if present, and inert room metadata. Signed relay evidence
stays in the private tab proof; no browser fixed row is created for opt-out.

The same final candidate reserves both actor invitation fence entries without
advancing them. A full fence table refuses before entropy; later forget advances
existing entries without needing additional slots or evicting old fences.

The complete final candidate passes the composer before encryption. Credential
and admission deadlines remain part of native effect liveness during crypto and
commit. Unknown acknowledgement retains the same candidate and exact pair frames;
`retryRetention()` never re-signs or generates a replacement. The adapter pins
its new operation only after native acknowledgement. A definite abort grants no
destructive cleanup ownership.

## Return, revocation and forget

A final fresh native read repeats the composer, exact selected operation,
identity/link/keep choice, scope fences, current credential and lifetime before
returning owned device, seal and root buffers with the actual credential. Late
refusal wipes those copies. The caller must wipe all released buffers with
`wipeOrdinaryPersistentBootstrapResult` when its session ends. Immutable JavaScript
strings and public signed credential values cannot be reliably erased.

Each instance attempts bootstrap once. Exact-owner reopen can load the retained
operation without entropy or signing. A failed attempt requires explicit reopen;
an uncertain write instead requires retry of the same pending acknowledgement.
Old browser-only device adapters refuse V2 browser proof custody and creation of
a browser fallback behind an empty opt-out link. V2 renewal must use the full
paired actor-scoped lifecycle, which remains separate work.

`revoke()` closes the effect guard synchronously. `close()` then joins pending
native work and the exact unabortable signer, clears private source references
and wipes the captured bearer. A signer callback may call `revoke()` and return
or reject. It **must not await `close()` from the signer promise that close is
joining**; that creates a promise wait cycle. Call close after the provider has
settled. Reentrant live/current/identity getters cannot bypass closed/forgetting
latches because those latches are checked again after external callbacks.

Forget deletes rows only for an exact currently selected operation this instance
opened or committed. It removes this actor's V2 identity/proof/admission together,
clears its exact metadata only when no remaining same-actor custody needs it,
preserves other actors and invitation custody, and keeps a shared fixed row when
remaining verified member or selected creator evidence supports it. Both actor
invitation fences advance in the same native commit. When no operation is owned,
forget only advances those fences and deletes no pre-existing rows. A later
successor holds rather than being adopted or deleted. The shared room fence is
not bumped: that would invalidate other actors' retained device bindings.

## Remaining integration and acceptance

First-use incoming-member custody is implemented here. Production still needs
the V2 tab device/epoch renewal lifecycle, creator-member bootstrap, production
mounting of the guarded query carrier, actual protected startup and foreground/background consumers, complete
old/new-client and capacity fencing, recovery/quiet/Tor transitions, current
admission/keeper/rekey authority and independent continuity. Browser/Android MLS,
physical signer/device/Tor acceptance and protected client release deployment
remain open. The dependency and lockfile now pin published
`signet-login@0.19.1`; [SDK provenance](ordinary-sdk-provenance.md) distinguishes
its registry release from the earlier local test overlays and these client gates.

Native browser checks use actual Fold signatures/evidence, IndexedDB, Web Locks
and non-extractable AES-GCM owners. They cover profile refusal before entropy,
provider reentry/late close, both keep choices, two-tab races, full-byte/revision
cuts, scope/end/lease changes, malformed signers, exact-owner reopen, pending
signer forget, failed/aborted and stale-instance forget, cross-actor preservation,
unknown acknowledgement, final handoff wipes and crypto expiry. Explicit extra
actor custody in preservation tests is a signed native fixture, not a second
production bootstrap or current-authority shortcut. Fresh-tab rejoin proves the
remaining browser topology; it does not prove physical expiry pruning of the
old owner row.
