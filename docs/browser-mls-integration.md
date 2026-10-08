# Browser MLS integration (P3-03c)

This branch implements the browser portion of Vennel's approved witness and
MLS contract, following the existing Android integration. It is not yet wired
to rooms or enabled in the app. Ordinary Bothy text routing remains separate.

## Foundation verified

- Self-hosted WASM built from Vennel `d91a23d1978ef08c22709181e16ab158d95c98cd`
  with Rust 1.94.1 and wasm-bindgen 0.2.129. The manifest pins exact asset
  hashes; the build checks them. Loading is explicit and excluded from PWA
  precaching. WASM: 2,023,494 bytes, 630,341 bytes with deterministic gzip.
- The witness carrier matches Android's `WitnessLink`: a dedicated pinned
  route, empty authorisation, bounded read/advance bodies, 20-second timeout,
  and receipt/status matching. Only a Link-marked witness 403 is a refusal.
  The Rust coordinator verifies signatures, challenges, subjects and digests.
  A timed-out advance retains an uncertain outcome; it does not authorise reset.
- Fourteen carrier unit cases pass. Chromium, Firefox and WebKit load the
  pinned browser WASM under the production script policy, recover a committed
  candidate after a lost response, fence a restored copy and hold while the
  fixture witness is unavailable. This is adapter evidence with a disposable
  signing witness, not real-box integration or browser room acceptance.

## Remaining integration and acceptance

1. One sealed, versioned persona state under Web Locks and IndexedDB revision
   CAS. Recompute manifests from actual durable vault/session objects. Stage
   and promote atomically; preserve uncertain candidates and retiring duties.
2. Move all typed vault mutations, consent, credentials and journals under the
   coordinator. Add the contracted typed box-request signer. Keep account
   generations, cross-tab invalidation and retired-key tombstones enforced.
3. Explicit witness-only pairing/enrolment using a distinct persona writer
   seed; pinned witness identity; pending, fenced and retirement/replacement UI.
   No implicit enrolment or shared app transport identity.
4. The MLS room store, driver and box client: installation checks on open and
   every reply, watched Gap mailboxes, exact witnessed generations before
   commit acknowledgement or network/plaintext release, and offline drafts.
5. Run W01–W12 against real Bothy, including full profile rollback, clones,
   lost stage/key, witness outages and wrong/replayed receipts. Obtain the
   client security review required by P3-03 before merging/enabling this work.

Browser membership administration follows under P3-05c. Android/browser room
composition and upgrade/restore acceptance follow under P7. Neither the asset
bundle nor a passing adapter test closes those gates.

Focused commands: `node scripts/check-vmls-wasm.mjs`,
`npx vitest run app/src/mls-witness-link.test.ts`,
`npx playwright test -c playwright.mls.config.ts`, and `npm run typecheck`.
