# Browser MLS account and consent integration

This development-preview slice connects the app's signed-in identity to the
coordinated vault. Production MLS remains disabled. It does not create MLS
rooms, send box requests or deliver messages.

Opening restore-protection settings reads only local enrolment metadata.
**Check MLS device** explicitly asks the witness and reads the coordinated
vault. An empty vault offers separate **Create new MLS device** and **Migrate
existing preview device** actions. Creation asks the current account signer
for a 30-day credential. Migration freezes the legacy source and retains its
ciphertext; missing keys never cause an empty import or implicit replacement.
Neither route falls back to standalone signing.

The settings display the public device identifier, credential, expiry and
revocation state. Replacement confirms the exact displayed device, checks it
again before prompting the signer and during commit, and retains tombstones.
Revocation names the exact credential. Signing permissions identify the app
origin, account, device, Bothy node and operation. Leaf-binding permission and
box authentication are separate, witnessed and individually withdrawable.
Approvals are scoped to the entered box identifier; the UI does not claim to
have paired with or verified that box merely because its identifier was entered.

`BrowserMlsAccount` derives the principal from the app origin and binds vault
operations to the account, room generation, privacy mode and pause generation.
The current signer is captured on each account-context read. A signer reply
after sign-out or departure cannot create or replace a device. Quiet and
Tor-only contexts refuse network operations. The settings clear identifiers
and cancel their signing prompts on invalidation. The account wrapper checks
reply provenance and expiry after its final awaited enrolment read, and refuses
an earlier success if that read discovers a fence or a non-enrolled state.
Caller-owned consent scopes are copied before the first await.

The room adapter can use typed leaf/box-signing entry points and the same
consent prompt once MLS rooms are implemented. These functions release only
vault-produced replies. They do not expose a device scalar or arbitrary event
signing. This slice does not implement the box client's replay/lost-reply
reconciliation or the MLS session coordinator.

## Validation commands

```sh
npm run typecheck
npm test
npx playwright test -c playwright.mls.config.ts
npx playwright test -c playwright.mls-app.config.ts
BOTHYD=/absolute/path/bothyd LAB_RELAY=wss://your-loopback-lab-relay/link \
  npx playwright test -c playwright.mls-live.config.ts -g 'typed account'
BOTHYD=/absolute/path/bothyd LAB_RELAY=wss://your-loopback-lab-relay/link \
  npx playwright test -c playwright.mls-account-live.config.ts
```

The live suites use fresh disposable daemon data and independently retained
witness state. Pairing codes remain in memory, with traces, screenshots and
video disabled. The full-app lab accepts the development server's self-signed
HTTPS certificate; the Link relay uses its existing WebPKI certificate, with
no Link TLS bypass. A development-server middleware serves only the four
pinned Link/MLS runtime filenames unchanged, because Vite's source transformer
otherwise rejects dynamically imported public WASM modules. Production builds
and the production gate are unchanged by that middleware.

Offline tests cover witnessed device creation, migration refusal/recovery,
consent denial, repeated box signing, withdrawal, revocation, stale replacement,
late signer replies, privacy/account transitions, mutable consent input and
key loss between signing and final release. They complement the existing
coordinator/vault durability suite. Final results and the independent review
are recorded in the delivery checkpoint.

Still open: MLS room storage/driver/box-client integration, membership and
revocation administration across peers, Android/browser composition, physical
device acceptance and independent production enablement review.

## Production liveness gate discovered in the live lab

The full-app journey passes, including device management, reload, witness
outage, late signing after sign-out, account switching and quiet-room departure.
The extended repeated-signing journey is incomplete: Link shutdown can retain
the writer lock for minutes after a successful receipt. Secret-free lab timings
separate endpoint open, read, advance and close; no pairing capability, key or
request body is logged. The account correctly withholds the result while close
is pending. This is not acceptable production liveness.

The extended reproducer is opt-in in addition to the ordinary live suite:

```sh
BOTHYD=/absolute/path/bothyd LAB_RELAY=wss://your-loopback-lab-relay/link \
LAB_SHUTDOWN_STRESS=1 npx playwright test -c playwright.mls-live.config.ts \
  --project=chromium -g 'typed account creation'
```

The default suite explicitly skips these extended cases. Focused creation,
migration and signing/persistence cases are separate evidence; passing them
must not be described as closing the shutdown gate. The independent reviewer
allows merging the disabled app slice with this limitation, and rejects
releasing writer ownership before transport termination as a workaround.
