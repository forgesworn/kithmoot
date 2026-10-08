# Browser Link carrier

The browser carrier is rebuilt from published Link source. Settings → Bothy
connection explicitly starts or resumes it and pairs a current `bothy:` code.
The account, random transport seed, relay addresses and returned route records
live in one sealed IndexedDB record under a non-extractable AES-GCM key. No
pairing capability is persisted. Sign-out and account changes stop the engine;
Forget this browser removes its local pairing as well.

This prepares a carrier. It does **not** change any existing room's transport.
Room activation, persistent grant installation/withdrawal, cross-tab closure of
public room pools and browser MLS/witness coordination remain follow-up work.
The UI states that limitation. A connection is not a claim that a room is
sheltered, anonymous or using MLS. The Link relay can observe network addresses,
connection timing and volume. This vault is not rollback protection.

## Lifecycle and transport boundary

`BrowserLink` holds an exclusive Web Lock for the entire endpoint lifetime.
Another tab refuses promptly. Repeated resume calls share the active engine;
stopping invalidates callbacks immediately and holds the lock until shutdown
and pending mutations finish. The release promise waits for the browser's
actual lock release, including Firefox. Browsers without Web Locks refuse.

`BrowserLinkRelay` uses only the exact event address derived from a verified
paired card. Its callback socket feeds the existing NIP-42 signer gate and
never creates a native WebSocket to that virtual address or a fallback relay.
Each instance has one room and bounded kinds. Requests require exact `#d` and
kind filters, including event-ID readback. Writes await the box's `OK`; a
disconnect refuses pending writes. Subscriptions retry the same route with
backoff. A declined signer is latched until an explicit new connection.

`BrowserLink.request` passes the typed request to the Rust route allowlist.
The engine owns route/method, body, authorization, content-type and response
bounds. Binary bodies, bare refusal status and `witnessRefused` survive intact.
Late responses are refused after the browser carrier stops.

## Pinned browser assets

`app/public/link-web/manifest.json` records the full source commit and SHA-256
of the generated JS, declaration and WASM. `npm run build` verifies those hashes.
The runtime is served by this app's own origin and loaded only on connection;
versioned URLs avoid mixing JS and WASM from different releases. It is excluded
from service-worker precaching so ordinary app use does not download it.

To rebuild, use a clean checkout of the manifest's Link commit and its
`scripts/build-link-web.sh --target web` with wasi-sdk 34.0 and wasm-bindgen
0.2.129. Copy the three named files from `dist/link-web`, regenerate their hashes
in the manifest and update the runtime source version. No CDN is used.

## Validation

- `npm test`, `npm run typecheck`, `npm run build`.
- `npx playwright test -c playwright.link.config.ts`: real IndexedDB and Web
  Locks, two tabs, release/reacquire, page closure and local forgetting, in
  Chromium, Firefox and WebKit. CI runs these alongside the MLS vault checks.
- `LINK_BOTHY_CONTROL=http://127.0.0.1:… LINK_TEST_RELAY=wss://… node
  test/browser-link-live.mjs`: Vennel's claimed G5 Bothy fixture and real Link
  relay. It uses a disposable fixture keeper and a fresh guest signer, not user accounts.
  Pairing, authenticated event roundtrip, a scoped guest grant and revocation,
  bare witness-route refusal, and resume after a Bothy restart are asserted.
  The native-WebSocket frame monitor has a positive control before measuring
  zero Nostr `REQ`/`EVENT` frames during both participants' carrier traffic.
  Only booleans, counts and status numbers are printed; no capability, route
  secret, key or message content enters a receipt.
- `LINK_TEST_APP=https://localhost:…/j/` with the same fixture variables and
  `node test/browser-link-app-live.mjs` drives the built app's visible extension
  sign-in, Settings pairing, code clearing, close and reload/resume controls.
  Ordinary profile/account WebSockets are blocked in this local UI test. The
  local Vite certificate is accepted by its test context; the carrier test
  above separately retains normal TLS checks.

The live test serves a real loopback page: intercepted synthetic test origins
trigger Chromium's local-network access checks when their WebSockets reach a
loopback relay. TLS certificate checking remains enabled. This is desktop
Chromium lab evidence, not real-device, production, cross-client MLS or the
withdrawn September built-room acceptance.
