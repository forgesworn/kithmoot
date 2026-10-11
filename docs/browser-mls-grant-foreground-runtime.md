# Development grant foreground composition

The development preview exposes a dedicated grant panel when
`VITE_BROWSER_MLS_PREVIEW=true`. The production build removes its entry point,
dynamic import and lifecycle hooks. Opening the panel performs no preparation,
storage access, signing or network work; every workflow starts with an explicit
button. The panel uses saved MLS rooms. Creating, joining and delivering their
outbox remain a separate development room composition requirement.

`BrowserMlsGrantDevelopmentOwner` accepts account context and the actual signer
capabilities only. It privately constructs the foreground custody, grant
endpoint, witnessed persona coordinator, vault, rooms, ledger, inbox and keeper
controllers. Callers cannot replace those components or supply readiness. The
same concrete grant custody serves installation, membership and keeper work.

Each named grant workflow snapshots its inputs and captures the exact account,
generation, privacy mode, signer owner and signing/encryption functions. It
prepares the native version-2 grant database before entering nested device,
persona or node locks, signing or networking. A blocked upgrade retains native
ownership through actual termination; retries cannot bypass it. Reads, writes
and result release check the exact foreground scope again.

The grant endpoint has a separate sealed seed/routes database and native
single-writer lock. It uses the pinned default Link WASM runtime. The ordinary
account/persona endpoints are not accepted as its replacement. Quiet and
Tor-only contexts hold network workflows; local reads do not open a connection.
Endpoint, native storage, signer and socket work remain owned until their
actual promises settle. Failed engine shutdown retains the endpoint lock until
page exit rather than permitting a second engine.

## Verified installation

The UI selects a saved room, verified member leaf and paired grant route.
Installation discovers the device, then validates the exact room and roster
again under the witnessed persona lock. `withConfirmedEffect` exposes only a
read-only transaction view, disposes plaintext and native session/core objects,
and closes the witness connection before its external effect. It retains the
persona writer lock through actual signing, publication and ledger settlement.
The lock order is device, persona, node/device, then custody. Competing persona
writers wait; same-coordinator recursive effects are refused.

Admission checks the current keeper, installation, device credential, retained
approval/removal holds, active genuine WASM session, exact target leaf and home
Bothy. Both keeper and target bindings must remain unexpired through the effect.
The pinned engine constrains binding expiry to credential expiry; member roster
metadata does not expose a separate credential expiry. A retained Remove
covering the selected leaf/person conservatively refuses installation even if
the identity later reappears. Interrupted publication can leave an `installing`
record; that is retained uncertainty, not successful remote access or withdrawal.

## Lifecycle and consent

External account, room, visibility and page lifecycle invalidation closes the
panel and clears its account, status, review and selection data synchronously.
The foreground is invalidated before awaited shutdown. Explicit reopening is
required; opening alone never resumes work. Selection-only retirement keeps
the panel open but invalidates the previous workflow and review.

Installation confirmation discloses the keeper/member public keys, device key,
grant identifier/scope, expiry and capacity sent to the paired Bothy. Room names
and identifiers are absent from that grant. Public DM checks separately disclose
recipient, address, timing and volume; relay identification requires explicit
permission for the selected relay and check.

## Acceptance boundaries

Native browser regressions use real Web Locks, IndexedDB, WebCrypto, signed
credentials and genuine MLS WASM rooms. Dedicated-endpoint timing/framing tests
use a low-level simulated Link engine; witnessed room tests use a deterministic
offline witness. Those are not default-WASM live Bothy acceptance. Source review,
automated browser checks and exact production build parity remain separate from
deployment, historical-client/process/profile/backup restore, handset and
independent operator acceptance.

This composition does not close create/join/driver UI, the broader old
room/persona writer or cached-engine boundary, safe candidate retirement,
pruning/renewal, P7 recovery or complete P3-08. Terminal no-live lapse and
production MLS remain disabled.
