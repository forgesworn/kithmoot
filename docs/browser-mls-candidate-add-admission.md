# Candidate Add admission

Development only. Production MLS and terminal lapse remain disabled. This
extends the keeper device hold to new Add attempts whose candidate is absent
from the current roster. It does not close pending-Add or old-client composition.

The adapter snapshots `Capability.info()` through the genuine WASM prototype:
identity, device, credential ID/expiry, binding expiry and all package-route
fields. No caller-supplied identity substitutes for that binding. Invalid or
expired metadata refuses. Only route fields are persisted by this change.

The common device gate retains the existing versioned Web Lock namespace used
by grant installation, withdrawal, approval and completion. Add acquires unique
candidate device gates in sorted order, shared, before any persona transaction.
It captures account/lifecycle scope before waiting. A queued stale operation
cannot restart in the new lifecycle. Missing Web Locks has no fallback.

Inside those gates, a fresh witnessed transaction checks all candidate bindings
and the retained keeper journal before package registration. Any approved/done
device prompt refuses admission, including a different-person credential for
the same key. Request expiry, approved Later and restart do not retire the hold.
Pending/dismissed prompts do not create a hold. The final witnessed Add proposal
transaction reopens the same checks and compares genuine metadata again before
consuming any capability. The gates last through actual registration and witness
settlement; no timeout releases them while work continues. Capability ownership
and cleanup still follow the engine's consume-on-Add contract.

This protects the candidate admission attempt and proposal. An already-proposed
Add has a later box Commit readback through `process()`, outside this method's
gate. Its candidate is not necessarily in the current roster when a keeper
approves a request, and route-only persisted package metadata cannot bind that
future candidate to a retained approval. That interval still needs durable
authenticated candidate tracking and approval/completion composition. Releasing
the proposal's gate is not evidence that MLS Add has committed or that a later
Remove occurred. No claim of complete re-admission protection is made here.

Old clients/direct writers, client/schema quiescence, durable pending Add,
atomic pruning, retained tombstone ordering, expired revoking renewal, P7/persona
replacement, operator UI, endpoint/room composition, live Bothy/relay, handset,
physical and independent production acceptance remain open. Simulated transport
browser tests are local lock/storage evidence only.
