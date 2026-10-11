# MLS admission purpose proof in the coordinated vault

This is an internal browser-vault prerequisite for v4 admission. It produces
cryptographic proof evidence only. MLS production remains disabled. It does not
join a room, confer keeper role, construct a capability, or consume admission.

The separate `@forgesworn/fold-kit/mls-admission` codec is pinned to reviewed
FoldKit main `eaa3495127e55242cf8a09e4c57963c570d68e8d`. This change does not update
the shared VMLS WASM build or claim its newer expected-group guard is deployed.

## Purpose API

`CoordinatedMlsVault.signMlsAdmissionProofV4(context, input, consent)` accepts
exact data properties `{v:4, role, fragment, core}` for `engine-device`, or that
shape plus a codec-issued nominal `request` for `keeper-device`. The engine role
selects the request's engine-device template; the keeper role selects only an
Allow answer's keeper-device template. Deny and arbitrary signing templates are
refused. Canonical core strings are validated by FoldKit before reservation.

The core's complete credential event, including signature and ordered tags,
must equal the sealed current credential. Current VMLS credential policy,
revocation, device identity, expiry and account context are checked both before
reservation and within the signing transaction. The private device scalar is
copied only to sign the exact validated template and that byte copy is wiped.
There is no scalar getter or generic event-signing API.

Consent receives a frozen scope containing method, principal, persona, role,
device, credential id, operation, core digest, event id, exclusive deadline and
complete canonical public core. It receives no invitation fragment. Existing
broad leaf/box approvals cannot authorise this proof. Explicit `deny` persists a
denied operation. A rejected consent promise or unsupported result leaves the
reservation pending and returns `busy` (or `stale` after context invalidation);
it never records an invented user denial. Cancellation/timeouts must reject the
promise to release the local prompt gate.

## Witnessed replay boundary

A separate fixed persona vault object, `kithmoot.admission-proof-journal.v1`,
contains exact version/persona/installation/schema checked rows. Unknown objects
are retained by older coordinated-vault writers and by device replacement.
Rows are unique by `(role, operation)`, bind the original principal, device,
credential, digest, event id, deadline and boot/generation/revision, and persist
an unpredictable reservation token plus pending, denied or completed outcome.
The journal retains at most 1,024 rows and 4 MiB of serialised plaintext. It has
no eviction, reset or wrap path; capacity exhaustion returns `busy`.

The first witnessed mutation reserves before prompting. One local operation per
persona may enter this API at once. The durable journal also prevents another
vault/tab from reserving while an unexpired pending operation exists. An
abandoned reservation therefore holds other operations until its deadline.
Identical pending retries never re-prompt; changed tuples or principals are
refused. After restart the old boot/revision remains a permanent stale tombstone.

Approval signs and stores the complete canonical seven-field Nostr proof in the
same witnessed mutation that completes the row. A pending witness advance or
interrupted promotion releases no reply. Reconciliation may return the exact
stored, freshly signature-checked proof without signing or prompting again.
Explicit denials replay as denials. Completed replay requires the recorded
context to remain current and the exact ceremony and credential to remain valid.

Only a promoted frozen reply receives private WeakMap provenance. Synchronous
`acceptAdmissionProofReply(input, reply)` checks that exact reply object, current
local context/revision, the validated ceremony/template, role, operation and
exclusive deadline. Copies, casts and substituted tuples hold. It is not a fresh
witness/store read and does not establish current keeper role. Replacement,
revocation, withdrawal and account invalidation invalidate prior replies.

The vault retains neither fragment nor bearer in its journal, consent or reply
provenance. The input fragment is a caller-owned JavaScript string and cannot be
wiped by this API. It exists transiently while the operation is running. Stored
proof digests and ceremony identifiers are private persona metadata, not public
relay publications.

## Remaining composition and acceptance

The private owner must verify actual saved-room identity, held child custody and
current active non-Pending keeper membership before invoking the keeper signer.
Account signing must settle inside the corresponding held persona custody.
Admission still requires a separately reviewed live keeper witness encoding,
exact authenticated installation/box binding, a fresh conditional authoritative
keeper revision at the effect boundary, and a durable one-shot admission journal.
Existing storage grants and continuity receipts are not a keeper-roster witness.

Browser fixtures exercise actual IndexedDB, Web Locks, the checked-in WASM
coordinator and signed synthetic witness receipts. Synthetic ceremony peers
verify both proof roles through the FoldKit wire codec. This does not establish
actual Bothy/Link keeper-witness service acceptance, production invitation/join,
two real accounts, installed PWA/phone behaviour, or physical acceptance.
