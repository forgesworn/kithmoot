# Browser MLS pending Add and keeper intent

Development-only composition of candidate admission, witnessed proposal,
keeper approval and genuine process readback. Production browser MLS and
terminal no-live lapse remain disabled.

`Session.add` produces a proposal before its prospective member appears in
the roster. Every new proposal now atomically retains the genuine capability
identity, device, credential reference and expiry, binding expiry, package
route and exact initial CommitSlot carrier inside the sealed room. The
initial generation and record ID form a stable proposal identity shared by
its candidates. Redeposition updates a separate carrier tuple after a genuine
`CommitRedeposited` event and unique matching outbound slot; it cannot alter
the initial candidate/proposal identity. These details are not exposed in
`driverState` or a plaintext database.

Keeper review scans every saved keeper room, independently of grant room
uses. A prospective device belonging to another person refuses review. An
authenticated prospective leaf freezes an explicit `pending-add` intent;
it cannot become ledger-only just because the roster is still empty. Approval
holds Send/Add while urgent node-wide withdrawal proceeds. Restart, request
expiry, Later, route disappearance, missing member and uncertain transport
do not clear the retained intent.

A genuine accepted `process()` transaction needs a matching `MemberAdded`
event and exact roster binding before recording readback. `CommitAccepted`
of kind Add additionally proves the browser's stored proposal won; every
candidate in that proposal must match. Another accepted commit can establish
`current-observed` presence without claiming the stored proposal won. Both
require Remove before completion. A lost proposal without matching presence
stays unresolved. Readback reached only through another engine entry point
is conservatively unresolved in this slice.

Execution can promote a frozen pending intent to required Remove from this
witnessed readback. It validates the exact retained candidate/proposal and
current member again before creating the request-bound removal journal.
Completion requires the exact genuine Committed Remove journal, including
its grant scope. Absence alone is insufficient, even after a witnessed Add.
Send/Add require that same request-bound journal before the pending intent
can release its mutation hold. Execution always checks every frozen candidate
record remains retained, even after Remove committed. Every approved/done
device also holds fresh keeper rosters outside the frozen room list; a later
legacy admission cannot bypass the hold through an earlier empty-room approval.
No pending record is evicted or cleared; the 64-record limit refuses another
Add before package registration. Safe retirement needs separate proof and
remains future work.

Legacy package routes without authenticated candidate records freeze an
explicit unresolved-room fact in approval. Urgent withdrawals can proceed,
but completion and Send/Add remain held even if the route later disappears.
No migration invents missing identity metadata.

Proposal, readback and review serialise through the existing witnessed
persona transaction. Device gates remain outside persona transactions;
this slice does not acquire device or node locks while holding a persona.
Strict optional room and approval fields make older parsers fail closed,
but that is not an old-writer quiescence barrier. Production still requires
the old-tab/schema writer barrier, pruning and renewal contracts, recovery
and P7, operator UI/endpoint composition, live interoperation, handset and
physical acceptance, and independent production acceptance.
