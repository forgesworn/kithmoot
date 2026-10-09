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

## Shutdown liveness follow-up

The repeated-signing lab exposed Link shutdown stalls lasting minutes after
successful witness receipts. Link `2fa7f232625ef1394bea66c9fd80668573b8310f` repairs browser timer
reset starvation and waits for relay drivers and all browser WebSockets to
terminate after QUIC drain. It also makes repeated stops await completion.
The writer lock remains held throughout shutdown; no timeout releases it early.

Both extended creation and migration journeys now pass across Chromium,
Firefox and WebKit, including lost replies, identical retries, withdrawal,
outage, restart and reload. Each returned operation checks that all observed
relay WebSockets are CLOSED. These cases run in the ordinary opt-in live suite;
`LAB_SHUTDOWN_STRESS` is no longer needed. Six cases passed in 2.9 minutes.
Normal local closes were around 100–150 ms; the deliberately offline witness
used the request timeout plus a roughly three-second QUIC drain.

This closes the observed transport liveness gate for the disposable lab. MLS
room integration, physical-device acceptance and production enablement remain
separate gates. The Link source review found no blocking security/lifetime
issues; its timer, cancellation and socket-ordering regressions are recorded in
Link's `docs/browser-shutdown.md`.
