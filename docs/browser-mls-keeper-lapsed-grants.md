# Witnessed keeper grant lapse

Development only. Production MLS remains disabled. This follows the independent
box-clock probe and forgotten-route recovery. It introduces no operator UI or
production imports and performs no ledger deletion or grant renewal.

An explicit caller first probes an independently owned, verified endpoint with
`BrowserMlsKeeperBoxClock.probe(record)`, outside the persona transaction. It
then calls `BrowserMlsKeeperDecisions.lapse(operation, record, evidence)`.
The decisions instance must resolve that node to the same concrete clock owner.
Missing providers and copied observations hold; they cannot supply expiry.

On witnessed reentry, the decisions class verifies the frozen approval, every
actual keeper roster and the retained ledger, compares the complete probed
signed record, and consumes the clock owner's exact immutable observation.
The signed expiration must be no later than **both** the authenticated positive
fetch's box time and the phone time captured by that probe. The later local
audit time cannot expand this conservative expiry test. Account, foreground
and nondecreasing phone time remain required through witness commit. Every
attempt after the concrete clock owner resolves invalidates its observation,
including unavailable or aborted witnesses; a further attempt needs a fresh
explicit probe. The caller must invalidate its owner if resolution fails.

The sealed `no-live` outcome contains the exact node/reference, audit time,
bounded clock facts and a domain-separated digest of the complete serialized
record. It is distinct from `revoked` and `route-unavailable`. The clocks assume
honest, sufficiently accurate phone and box clocks; the observation is not a
signed remote revocation receipt. No tombstone is published and the retained
record's active/revoking status is unchanged.

After restart, execution reports `lapsed` separately. The controller reports a
`no-live` row and does not publish a withdrawal or mark the engine grant
`Revoked`. Real MLS Remove journals must still reach `Committed`. Lapsed requests
then remain approved, with `completion: awaiting-grant-install-hold`, and keep
the compromised-device hold. `complete()` refuses them and persisted `done`
lapse outcomes are rejected. No terminal no-live notice is exposed yet.

Grant ledger reads and persona witness commits are different atomic domains.
A replacement could be installed between the final ledger read and witness
commit. Detecting changes at a read does not close that window. An
affected-device grant-install hold spanning completion is therefore mandatory
before terminal completion or runtime composition. The current development
slice deliberately keeps that gate closed.

An absent old record is accepted only with its exact sealed lapse outcome.
Absence without that fact remains held. This accommodates future authorised
cleanup and crash recovery; it does not classify legacy missing records or
implement pruning. Before a deletion API ships, it must atomically compare and
delete inside the encrypted store lock, preserve concurrent other-node changes,
require the witnessed fact first and retain sufficient tombstone ordering
material for safe renewal after clock regression. Expired revoking renewal,
completed-grant pruning, and historical pruning therefore remain open.

Operator UI, dedicated endpoint/account/room composition, live Bothy acceptance,
handset acceptance and the broader production gates remain open. Simulated
transport and browser/WASM evidence do not count as those acceptance gates.
