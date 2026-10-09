# Browser MLS integration (P3-03c)

This branch implements the browser portion of Vennel's approved witness and
MLS contract, following the existing Android integration. It is not yet wired
to MLS rooms or enabled in production. Account controls are available only in
an explicit development preview. Ordinary Bothy text routing remains separate.

The [independent agent security review](browser-mls-security-review.md) found
no blockers for merging the production-disabled foundation at `b19508c`.
The owner authorised the reviewer substitution required by P3-03. This scoped
review does not authorise production enablement or close browser integration.

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
- `mls-persona-store.ts` supplies one sealed, versioned persona container with
  active and staged vault/session ciphertext, coordinator bytes, writer seed
  and witness route. A Web Lock spans the caller's witness trip; each atomic
  IndexedDB write also compares an opaque revision. No transaction spans
  cryptography or network I/O. No local-mutex fallback is allowed. Browser
  transaction completion is the weaker durability boundary, not native fsync.
- The storage schema uses non-extractable outer/inner AES keys and HMAC record
  names. An unsealed, bounded marker prevents a missing record from becoming
  an implicit new persona; missing naming/seal keys and bad tags fail closed.
  Inner AAD binds persona, installation, record or session and generation.
  Unchanged inner ciphertext stays identical across stage/promotion. The
  manifest is recomputed from actual ciphertext through the Rust object hash.
  Limits are 64 vault records, 1,024 sessions, 8 MiB per sealed object and
  64 MiB per container including both active and staged sets; quota failures
  abort the transaction without exposing the candidate.
- Browser storage acceptance covers reload/promotion, stale and simultaneous
  writes, forced transaction abort, two-tab lock ownership, non-extractable
  keys, missing data/keys and ciphertext corruption. All 24 coordinator and
  storage cases pass across Chromium, Firefox and WebKit, including the real
  Rust coordinator refusing a changed object under its saved manifest. This remains a storage
  primitive: callers must not release plaintext or network effects merely
  because a local write succeeded.
- `mls-persona-coordinator.ts` now connects the shared Rust decisions to that
  store. Every operation opens actual durable objects, checks their seals and
  freshly reads the witness under the persona lock. It persists the exact
  staged candidate before sending an advance, and atomically promotes it
  before returning any effect or session mark. Lost responses retain the
  candidate; subsequent operations reconcile it before constructing another.
  There is no cached confirmation that can authorise a later mutation.
- Typed transaction helpers open, seal or remove vault/session objects without
  exposing the writer seed. Seals run in invocation order; session generations
  increase; unchanged vault plaintext retains its exact ciphertext. Provisional
  plaintext buffers are wiped on exit. Mutating callers supply an account
  context check, repeated after witness work and lock-release cleanup. A stale
  account receives no successful effect, including after a durable promotion.
- Terminal local fences persist separately from recoverable sealed records.
  The commit transaction refuses a fence that arrived while its outer seal was
  being computed. Missing/corrupt state never triggers enrolment. A restored
  witness behind the client receives the Rust retiring advance, and its duty
  remains recorded until explicit installation replacement; a signed retired
  reply alone does not end that duty while the old installation remains.
- The orchestration fixture uses the real Rust WASM, WebCrypto and IndexedDB
  with an independent disposable receipt signer in the test runner. It covers
  interrupted stage/promotion, a transaction aborted during promotion, a lost
  committed reply, persona database rollback (records, keys and markers), missing candidate/key/record,
  fresh-read outage, wrong signatures, replay, refusal, retiring a witness
  restored behind, concurrent seals and obsolete account contexts. The initial
  retirement assertion incorrectly expected the duty to end before replacement;
  the Rust engine retained it correctly and the assertion was repaired. These
  reload and fault-injection cases are not full browser-process kill tests,
  real Bothy W01–W12, physical-device tests or room acceptance.
  All 81 browser cases pass across Chromium, Firefox and WebKit; the 44
  existing vault/witness unit tests, typecheck and production build also pass.
- Explicit clear and replacement now follow Android's approved retirement
  boundary. Clearing a healthy enrolment atomically erases its file and keys,
  retaining a fence and exact subject until the keeper confirms that subject
  retired. That confirmation is the keeper's assertion, not a signed proof,
  and cannot override a known retiring duty. An unregistered preparation can
  be discarded without witness traffic, while retaining its installation id.
- Clearing an installation with a retiring duty atomically removes all active
  and staged objects and destroys the inner key, retaining only the outer-sealed
  writer, route and coordinator state. It works even when the inner key was
  already lost. Reopen continues that duty offline or online. Only after
  replacement and a fresh signed retired receipt does it delete the remaining
  keys and retain the subject/installation tombstone. No fresh preparation is
  allowed before that point. A readable but unsupported container format is
  kept for recovery rather than treated as proof that the writer key is lost.
- Replacement acceptance adds interrupted clear intent, transaction abort
  during erasure or key destruction, a restart after key destruction, offline
  retirement/reconnection, lost inner keys, exact-subject confirmation,
  re-preparation with fresh ids, immutable tombstones and unsupported formats.
  These remain fixture tests using real browser storage and the pinned engine.
  The expanded suite passes all 108 cases across Chromium, Firefox and WebKit;
  all 3,373 unit tests, typecheck and the production build pass as well.
- `mls-persona-link.ts` supplies dedicated per-operation Link endpoints using
  the persona writer, with explicitly saved relay choices. One channel serves
  the operation's fresh read and any advance/retiring exchanges. Shutdown is
  awaited under the persona Web Lock, including after errors and late startup;
  no endpoint remains cached after unlock. The caller supplies its connection
  policy and account context, and must pause the service on account/mode changes.
  Quiet/Tor-only policy prevents startup; late replies release no effect. An
  account change after staging now retains the candidate without dispatching
  the advance, and a later current operation reconciles it.
- `mls-persona-enrolment.ts` provides explicit preparation, pairing and genesis
  operations. Preparation saves the installation and writer before pairing;
  pairing uses a disposable dedicated endpoint and saves the returned verified
  route only after shutdown. The keeper must supply a witness-only pairing code;
  actual authority comes from Bothy's secret slot, not a client URI claim.
- Genesis covers empty objects. Its subject, writer, witness and initial digest
  are sealed with the coordinator state and atomically committed with the marker
  before returning the keeper's enrol command. Reopening an interrupted return
  yields that exact genesis. It does not claim witness acceptance. The signed
  paired card is re-authenticated at its recorded verification time; the full
  Link engine remains responsible for card/hint policy. The marker must agree
  with sealed enrolment fields, the writer seed and the paired witness identity.
  Enrolled route/identity metadata cannot change through an ordinary write.
  Missing or invalid inner key handles refuse even an empty genesis.
- The draft-only container now requires sealed enrolment metadata (null before
  genesis) and explicit relays on a saved route. Earlier draft containers missing
  these fields fail closed and remain retained for repair; there is no silent
  reset or migration. No deployed application has used this persona store.
- Enrolment/lifetime fixtures cover explicit sequencing, restart, transaction
  abort, interruption after genesis persistence, marker substitution, changed
  witness routes, missing/invalid key handles, late startup/shutdown, seed-copy
  wiping and obsolete account contexts. Pairing here uses an injected Link
  endpoint with a disposable signed card; it is not a real Bothy pairing run.
  All 147 acceptance cases pass across Chromium, Firefox and WebKit; all
  3,399 unit tests, typecheck and production build pass. A pre-existing unit
  assertion matched kind digits inside random key hex; it now inspects the
  kind field directly. That service-only checkpoint preceded the controls below.
- The development preview now exposes local preparation, witness-only pairing,
  keeper enrolment, explicit fresh checks, clear and exact-subject keeper
  recovery through Settings → Connections → MLS restore protection. Opening
  reads local state without loading MLS WASM or contacting the witness. Pairing
  capabilities are removed from inputs immediately; commands are freshly read
  before copying. A saved genesis is never labelled witness acceptance.
- Account sign-in/out, restored sessions, room changes and pagehide invalidate
  displayed data and pause dedicated connections. The host supplies account and
  room generations; quiet rooms hold witness traffic. The controller's Tor-only
  hold is fixture-tested, not evidence of a browser Tor carrier. UI checks are
  informational: future MLS room effects still require coordinator transactions.
- Cross-tab notifications contain only `{ type: 'changed' }` and invalidate the
  other panel, including open confirmations. Clear also checks the reviewed
  installation under the writer lock, independently of notification delivery.
  A stale confirmation cannot erase a replacement. Sealed retirement subjects
  are distinguished from markers whose seal is unavailable; readable malformed
  state is retained for repair. An unregistered preparation with a lost inner
  key can still be explicitly cleared. Browser forgetting refuses retained MLS
  state or retirement duties across all accounts; retired tombstones are kept.
- Use `VITE_BROWSER_MLS_PREVIEW=true npm run demo` for the development controls.
  The build also requires Vite's development flag: an ordinary production build
  with that environment variable still hides the entry point and excludes the
  preview runtime. The full-app Chromium journey checks preparation, sign-out,
  reconnect and both sides of the browser-forgetting guard, with an offline
  test signer/relay. A separate production journey checks the disabled entry
  point. Neither test pairs with real Bothy. Narrow-screen layout was inspected.
- The controls checkpoint passes all 180 MLS browser cases, both full-app
  checks, 3,399 unit tests, typecheck and the production build. The generated
  production JavaScript was also checked for absence of the preview runtime.
  CI now runs the app lifecycle/production gate alongside the browser suite.
- The [disposable real witness lab](browser-mls-witness-lab.md) now passes
  17 live checks: real witness-only pairing, the visible keeper enrolment
  controls, signed advances, outage/retirement, receipt replay/damage, missing
  stage/key and restoring Bothy's witness behind the browser. Chromium also
  passes whole-process kills at three durable boundaries, a lost accepted
  reply, database/whole-profile rollback and two cloned profiles contending
  for one successor. Four process-test combinations are explicitly skipped
  on Firefox/WebKit. The live run uses real pinned Link/MLS WASM and a separate
  Bothy process/SQLite witness on a loopback WebPKI relay. Mutations still use
  synthetic vault/session records, not MLS room messages. Typecheck passes.

## Coordinated typed vault follow-up

The [coordinated vault implementation](browser-mls-coordinated-vault.md) adds
explicit legacy transfer, witnessed credential/policy/journal changes and typed
box authentication. Its review and validation are separate from the foundation
review above. It has no production or room caller yet.

## Session persistence follow-up

The [browser session host](browser-mls-session-host.md) now connects real engine
snapshots to the coordinator: exact generations, acknowledgement under the
writer lock, withheld effects through cleanup, durable outbox recovery and
witnessed session-id tombstones. It has no app or network caller. The subsequent
[room operations](browser-mls-room-operations.md) add typed create/Update and
atomic metadata/history persistence. The [strict box client](browser-mls-box-client.md)
adds pinned request signing and bounded reply parsing, with no caller. Typed join,
the box driver and endpoint lifetime, app
wiring and room acceptance remain open.

## Remaining integration and acceptance

1. Complete real witness acceptance and security review before enabling the
   development-preview enrolment/recovery controls in production. MLS room use
   remains unavailable; the controls alone do not close browser integration.
2. Review and accept the coordinated typed vault follow-up, then connect its
   consent and credential flows to the app. Its API now covers migration,
   journalled leaf signing and typed box requests; full-app and real-witness
   acceptance remain open.
3. Expand full-app account/mode-transition acceptance against real Bothy.
   The pairing and pending/fenced controls now have a disposable real-daemon
   lab; the app host's lifecycle wiring still has separate offline acceptance.
4. Complete room operations and connect the driver and box client: installation checks on open and
   every reply, watched Gap mailboxes, exact witnessed generations before
   commit acknowledgement or network/plaintext release, and offline drafts.
5. Complete the remaining real-box/physical acceptance and obtain a fresh
   client security review of vault/room integration before production enablement.
   The foundation-only merge review is recorded separately above.
   See the [real witness lab](browser-mls-witness-lab.md) for the exact boundary
   between live daemon, process-kill, profile-restore and fixture evidence.

Browser membership administration follows under P3-05c. Android/browser room
composition and upgrade/restore acceptance follow under P7. Neither the asset
bundle nor a passing adapter test closes those gates.

Focused commands: `node scripts/check-vmls-wasm.mjs`,
`npx vitest run app/src/mls-witness-link.test.ts`,
`npx playwright test -c playwright.mls.config.ts`,
`npm run build:lib && npx playwright test -c playwright.mls-app.config.ts`,
and `npm run typecheck`.

## Release validation, 9 October 2026

After incorporating the main-branch phone call fix, code head `b19508c`
passes a fresh typecheck, all 3,399 unit tests, all 180 MLS browser cases,
both full-app preview/production-gate checks, 95 desktop boundary tests,
Android publication checks and independent context/library package smoke
checks. The production build contains no preview runtime and does not
precache MLS WASM. The earlier 17-check daemon rehearsal was not repeated
for this unchanged MLS implementation. Hosted CI is tracked on PR #286;
these local results do not imply that every hosted job has completed.
