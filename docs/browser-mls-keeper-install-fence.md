# Keeper grant-install hold

Development only. Production MLS remains disabled. Lapsed requests still stay
approved and keep Send/Add held; this change does not relax the witnessed
completion gate or permit persisted `done/no-live` records.

Every `BrowserMlsGrantLedger.install()` holds a shared Web Lock for the affected
device, then its existing exclusive node/device lock. The shared device lock
spans ledger reads, signing, encrypted persistence, publication and its actual
settlement. Installs at different nodes can run concurrently; different devices
have independent gates. A node not present in an old approval uses the same
device gate and cannot evade a hold.

`withDeviceInstallHold(store, keeper, device, current, work)` takes that device
gate exclusively. It requires the exact ledger-store object and current keeper,
rechecks after waiting, and supplies a current predicate to its callback. The
caller must await the actual witnessed transaction inside the callback. The
lock stays held until that promise settles, including unavailable or rejected
witnesses. There is no cancellation or timeout race that releases it while the
callback continues. Account and foreground changes prevent a successful return.

Lock order is device gate, node/device lock, encrypted-store lock. A completion
callback must not install or re-enter the device gate, or wait for work that
requires it. It must not acquire node/device locks while holding a persona
witness if another caller can hold those locks while waiting for that witness.
Read-only terminal verification inside a future completion transaction must
avoid pairing/withdrawal paths that acquire those locks.

The hold is local concurrency control, not a signed receipt, persisted approval
or no-live proof. Direct store writers do not participate in it; runtime
composition must route all grant installation through the ledger. Existing
withdrawal paths cannot create replacement signed authority and retain their
node/device locks. Cross-process clients using a different lock namespace and
older open tabs predating this gate are outside this browser-local guarantee.
Before completion can be enabled, installations/admissions must also fresh-read
and enforce the durable affected-device hold inside the shared gate; a new
install after an exclusive callback releases must not bypass that hold. A
client-version barrier or equivalent must address older open tabs. If exact
record stability is required, withdrawals also need the shared outer gate.

Completion composition, atomic pruning, retained tombstone ordering, expired
revoking renewal, historical missing-record recovery, operator UI, live Bothy,
handset and independent production acceptance remain open. Browser Web Locks
and simulated transport evidence do not satisfy those live acceptance gates.
