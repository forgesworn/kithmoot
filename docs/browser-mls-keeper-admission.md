# Keeper grant admission and approval

Development only. Production MLS remains disabled. This composes the device
installation gate with witnessed keeper admission and approval. It does not
enable lapsed completion or persisted `done/no-live` records.

Every `BrowserMlsGrantLedger.install()` requires a concrete
`BrowserMlsKeeperAdmission` owner. Inside the shared device gate, admission
fresh-reads the validated membership journal through the persona coordinator.
An unavailable, pending, fenced or stale witness refuses the install before
ledger reads, signing, persistence or publication. An omitted owner refuses as
well. Admission captures the keeper account and foreground vault binding; the
ledger checks that binding through the subsequent asynchronous installation.

Approved and completed inbox requests retain a device hold. Request expiry,
Later, an empty roster, a withdrawn grant and restart do not retire it. The
hold blocks ordinary renewal, room expansion, replacement of a revoked grant
and installation at a previously unknown node. Reusing the device key for a
different person also refuses. Recovery requires a new device key. Pending
and dismissed requests do not acquire an operator-approved hold. This uses
the existing validated journal without a new schema or pruning policy.

Approval requires a concrete grant ledger whose store is the exact object used
by the decision owner. It takes the device gate exclusively before the fresh
persona transaction, retains it through actual witness settlement, and checks
the complete reviewed plan again. An installation already in progress settles
first; if it changes the selected grant authority, the old approval plan refuses
and the operator must review again. An install queued behind approval acquires
the shared gate afterwards and sees the durable hold. Dismissal does not need
the exclusive installation gate.

Lock order is device gate, persona admission or approval, then (after admission
releases the persona transaction) node/device and encrypted-store locks. The
exclusive approval callback must not install or re-enter the device gate.
Different-node installations still share the device gate; different devices
remain independent. The gate stays held until the callback really settles.

The concurrency guarantee covers callers using this gate and admission owner.
Direct store writers, cross-process clients and old tabs that predate it remain
outside that guarantee. Prospective MLS Add does not yet bind the candidate's
persona and device to this admission check. Runtime composition must use one
coordinator and the intended keeper context. No production UI imports or
enables these development owners in this change.

All completion paths still need exclusive verification and an old-client
quiescence barrier before terminal lapse can be enabled. Atomic pruning,
retained tombstone ordering, expired revoking renewal, historical missing-record
recovery, persona replacement, operator UI, live Bothy, handset and independent
production acceptance remain open. Real-browser locks, encrypted storage and
genuine MLS engines with simulated witness and carrier transport do not prove
those live acceptance gates.
