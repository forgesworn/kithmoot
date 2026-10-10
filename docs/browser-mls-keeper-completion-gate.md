# Keeper completion installation gate

Development only. Production MLS remains disabled. This extends the
[keeper admission and approval](browser-mls-keeper-admission.md) gate to every
public keeper completion call. Lapsed completion remains refused and persisted
`done/no-live` records remain invalid.

`complete()` requires a concrete installation owner for the exact grant-store
object. It first fresh-reads the validated retained approval to discover the
affected device. That persona transaction fully settles before device-lock
acquisition. A pending or fenced preliminary read cannot enter completion.

Completion then takes the device gate exclusively, opens a new witnessed
persona transaction and requires the retained prompt to match the preliminary
snapshot. Changed request, approval, outcomes or deferral require another check.
The existing verification reopens the frozen grant authority, current keeper
ledger and genuine MLS roster, and verifies committed engine removal journals.
The exclusive gate spans that transaction's actual witness settlement and the
account/foreground checks. There is no unguarded public completion path or
timeout that releases it while the transaction continues.

This serialises completion with participating grant installations. Admission
continues to enforce approved/done device holds after gate release. Neither
completion nor the callback installs or re-enters the device gate. A stale
caller waiting for the gate cannot commit using an earlier persona snapshot.

The gate alone does not quiesce old clients or raw ledger writers. Both
[withdrawal paths](browser-mls-keeper-withdrawal-gate.md) now participate in the
shared outer gate through their actual settlement, before their node/device
locks. They cannot mutate a grant while participating completion owns the gate
exclusively. Direct store writers and old clients remain outside that guarantee.
Lapsed requests therefore remain approved and retain Send/Add holds even after
genuine MLS commit. The old-client/schema barrier, prospective Add binding,
pruning, renewal, UI, persona replacement and live/handset/independent acceptance
remain open. This change does not enable terminal lapse or production MLS.
