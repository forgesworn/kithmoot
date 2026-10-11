# Keeper withdrawal device gate

Development only. Production MLS remains disabled. This follows the
[completion gate](browser-mls-keeper-completion-gate.md), extending its local
concurrency boundary to both public grant withdrawal methods.

`withdraw()` and `withdrawRequestedDevice()` now hold the device gate shared
before their exclusive node/device lock. The shared gate spans ledger reads,
room-use/grace updates, `revoking` persistence, publication, actual carrier
settlement and cleanup, and final `revoked` persistence. An exclusive approval
or completion waits for an already-running withdrawal to settle. A withdrawal
queued behind an exclusive holder cannot mutate or publish until release.
Different nodes can still withdraw concurrently; the node/device lock prevents
duplicate same-node publication. Different devices remain independent.

Both methods validate primitive canonical node/device keys before acquiring
the gate and recheck the captured keeper after waiting and asynchronous reads
or writes. The request-specific path retains its foreground/current predicate.
The room-specific path retains its account-bound API and verifies the signed
record and issuer before returning even a previously revoked result. It does
not introduce a new signer, replacement grant, expiry policy or grace policy.

Publication uncertainty keeps `revoking` and the exact retryable tombstone;
neither a released lock nor completion manufactures a confirmed withdrawal.
The gate remains held through an unresolved publication, including when a
concurrent completion is waiting. Completion still requires the genuinely
committed MLS removal journal independently of node withdrawal.

The fixed order is device gate, node/device and short encrypted-store work.
Withdrawal never enters a persona transaction while holding those locks.
Room/controller journal updates occur after withdrawal returns. Completion
takes the device gate exclusively before its fresh persona transaction; its
callback must not call either withdrawal method or re-enter the gate.

This supplies stability against participating ledger mutations, not old tabs,
cross-process clients or direct store writers. Missing routes remain unconfirmed
remote access, and witnessed lapse still cannot complete or persist
`done/no-live`. Old-client/schema quiescence, prospective MLS Add binding,
atomic pruning, retained tombstone ordering, expired revoking renewal, persona
replacement/recovery, UI/composition and live/handset/independent acceptance
remain open. Browser locks and simulated transport do not close those gates.
