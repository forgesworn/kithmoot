# Ordinary renewal journal and startup custody

This is an unmounted source implementation. Browser evidence uses actual native
IndexedDB, Web Locks, cryptography and the private room factory with synthetic
signing providers. It does not prove production deployment, physical-wallet
behaviour, current independent MLS admission or rollback-protected allocation
history. Active-phase recovery and production startup mounting remain required.

## Fixed renewal flow

The private member factory now uses six journal phases:

| Phase | Native pair | Retained private body |
| --- | --- | --- |
| `prepared` | E | Fixed request; no seal or nonces |
| `provider-started` | E | Request, seal and candidate nonces; no result |
| `provider-returned` | E | Exact verified result, request, seal and nonces |
| `candidate-prepared` | E | Same result/material plus frozen C digests/revisions |
| `candidate-committed` | C | Request/result and history; journal seal/nonces removed |
| `settled` | S | Immutable history and digests; no request/result/seal/nonces |

P is the complete acknowledged predecessor. E revisions are P+1, C revisions
P+2 and S revisions P+3. Enrollment writes both E frames and prepared control
atomically before any signing effect. The producer retains its actual outer
promise on the quiescent root, both native owners and the foreground signer.
The origin write lock and durable barrier cover the signing continuation.

The request freezes original source headers, complete P semantic and frame
commitments, actor/room/device/credential/proof/lease references, authority,
exact scoped fences and prior settled marker/control history. The inverse
restores only enrollment's marker/fence/revision changes on owned E copies and
checks the complete semantic commitment. It never reproduces an old AES nonce.
All six control packets and E/C/S owner-image budgets are reserved before entropy.

The provider receives one fixed statement produced by the pinned Fold-kit.
The actual raw fulfilment is captured and freshly verified synchronously before
any asynchronous handoff. Its seven fields and exact tag arrays are copied to
one canonical bounded result. Verification cache metadata grants no trust.

Result-only custody uses its own preallocated AEAD nonces. A valid result can
therefore be retained after controller, owner or foreground revocation without
new entropy, mutable selector checks, another provider attempt or C preparation.
Unknown native acknowledgement retains that exact candidate until explicit
reconciliation. An invalid/refused response leaves started custody unresolved.

C and S each use a fixed atomic three-record write. Every attempted transition
is reconciled against complete exact prior/target store facts. Mixed or
unavailable facts retain the original bytes and joined ownership; confirmed
prior can retry only with the required current authority. Exact target
recognition is custody evidence and does not permit Session adoption.

S markers carry an immutable binary SHA-256 commitment to operation id,
sequence, P/E/C digests and revisions, request/result digests, scopes and
ceilings. Ordinary mutations preserve them. Settled expiry uses its dedicated
atomic browser-marker removal and tab/control deletion after authentication.
Active or malformed history holds before ordinary callbacks, migration,
allocation and tab expiry.

## Live controller adoption

After S acknowledgement the private factory takes fresh ordinary native reads.
An opaque receipt must match the selected browser/tab S rows and complete
control/marker set. Unrelated owner rows can advance after S; this receipt
remains custody evidence only. Copied, stale, foreign-owner or mutation custody
cannot substitute for the actual read.

A separate role check validates the selected proof, current credential/lease,
metadata, exact factory binding, quiescent root, visitor key or foreground
authority, and remaining lifetime. The Session and carrier replacements are
prepared before assignment and checked again in the final native callback.
The final authority check precedes pure private guard/view/material swaps.

Failures after S, during partial assignment, in the post-adoption read or final
member-live check terminally close the controller. A fresh controller may reopen
from durable S after independently validating current authority. Restatement
belongs to a new generation after the adopted-state read; no activity resumes
between C and S.

## Startup inspection

`OrdinaryStateOwner.inspectRenewalStartup` is a separate fixed native inspector.
It takes the origin lock, opens one coherent read transaction, authenticates
paired controls and every owner/control/marker, and publishes no ordinary-owner
cache or pair-custody token. An absent database upgrade is aborted, leaving no
new database or keys.

Active E requires exact enrolled frame/revision bindings and an exact inverse P,
including historical selected proof/device/credential/lease and room metadata.
Retained results must match the pinned Fold statement and a fresh signature
check. Committed C requires exact target rows and matching current and
predecessor proof/lease, scope, credential, epoch and metadata references.
Decrypted packets, owned images and copied seal arrays are cleaned up locally.

The returned frozen disposition is `empty`, `ordinary` or `recovery-required`,
with bounded phase identifiers. It supplies no key, image, body, signing
permission, writable continuation or authority to reset allocation history.
Ordinary startup operations still run their own native barrier and role checks.
Expiry does not turn an active operation into permission to erase or re-sign.

Page reload tests discard all JavaScript tokens while preserving native storage.
Separate clean browser-process restart tests reuse the exact persistent profile
and serialized CryptoKeys, with no plaintext export or replacement key.
These are software restart checks, not abrupt power-loss or physical acceptance.

## Fixed startup settlement

`OrdinaryStateOwner.recoverCommittedRenewalAtStartup` performs only historical
C-to-S custody maintenance. Its input is a native tab purpose and fresh startup
owner liveness. It independently authenticates the exact committed pair, result,
historical role and complete origin before constructing the stripped S body.
Historical tab or foreground expiry does not grant activity or prevent this
neutral settlement. Current room authority is checked separately on reopening.

The semantic projection preserves every non-marker record and immutable history.
After checking owner-image and control budgets, it uses the existing native
CryptoKeys and four fresh AEAD nonces for the two frames and control copies.
It allocates no signing key, credential or seal, calls no provider and performs
no Session or carrier adoption. The coherent write transaction reauthenticates
the complete C predecessor before atomically putting both S frames and control.

One encrypted S cohort is retained for every uncertain acknowledgement. Exact C
can retry that same cohort only while the fresh startup owner remains live.
Exact S is recognised as custody even after close; mixed or unavailable facts
hold the actual outer promise and origin lock until explicit reconciliation.
Close joins pending native cryptography and unresolved writes. An already
settled result follows a fresh whole-origin classification and grants no activity.

## Remaining recovery work

The startup inspector does not advance an active phase. Fixed startup recovery
of an unstarted prepared intent still needs a separately validated current
authority and signing boundary. The retained-result producer described below
completes only historical custody and does not reopen a controller.
A recorded provider start with no durable result remains unknown and must never
invoke the provider again. Recovery must authenticate the whole current store
and current role independently of any diagnostic disposition.

Actual entry mounting, all-consumer source inventory, old-client fences,
registry dependency reproducibility, current independent MLS authority,
rollback-protected allocation history and physical/mixed-client acceptance
remain open. None is established by a local source commit or a browser test.

## Fixed retained-result startup custody

`OrdinaryStateOwner.recoverRetainedRenewalAtStartup` handles only an authenticated
`provider-returned` or `candidate-prepared` journal. It reopens the existing
database under the origin lock, authenticates the complete E cohort and store,
restores exact P on owned copies, validates its complete historical composition,
and freshly verifies the retained canonical result against the pinned Fold
statement. No recorded provider start without a durable result is retried.

The shared pure constructor reproduces the exact proof, lease and C images from
P, the canonical request/result and retained seal. It derives lineage authority
and source from authenticated historical data, without a current foreground
lookup, clock, signing effect or fabricated ordinary read-custody token. The
complete C projection and phase budgets are checked before cryptography.

The two C frames use only their persisted nonces. Reopening the encrypted frames
confirms the complete projected plaintext. A prepared journal must reproduce its
recorded frame digests and revisions exactly. A returned journal first persists
`candidate-prepared` with those digests before any C row write. Each distinct
control body gets two fresh AEAD nonces after fresh native phase authentication;
frame nonces and earlier control nonces are never substituted for them.

Each attempted control or C write retains one immutable encrypted cohort and
the actual outer promise. Complete exact prior/target reconciliation decides
the outcome. Mixed or unavailable facts hold the lock until explicit repair;
confirmed prior can retry identical bytes only while the startup owner is live.
Close joins cryptography and unknown custody, and can recognise an already
committed target without granting activity or allocating the next phase.

Committed C can then use the separate C-to-S settlement entry. Both entries
return frozen status data only. Current authority, controller construction,
Session/carrier adoption, production startup mounting, abrupt power loss and
physical acceptance remain separate requirements.
