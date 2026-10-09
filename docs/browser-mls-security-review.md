# Browser MLS foundation security review

Review date: 9 October 2026. Reviewed code:
`b19508c9f83bc2d764f02d1d2f5699d756b3be23`, against main
`a641a3dbce0a103f282d47305fa13d5924a565d2`.

**Verdict: no blocking findings for merging this production-disabled
foundation.** This verdict does not authorise production enablement, claim
completed browser MLS integration, or close P3-03c acceptance.

P3-03 requests an Opus or Astra review before merge. Neither was available in
this session; the owner explicitly authorised an available reviewer agent
instead. A separate reviewer agent performed this review independently of
the implementing/releasing agent. This is an agent code review, not an
independent human audit or a review of the entire underlying cryptographic
implementation.

## Scope and findings

The review compared the new browser adapter and its tests with P3-03 and
the implementation contract's witness, coordination and recovery boundaries.
It covered the sealed persona store, coordinator, enrolment and writer
identity, dedicated Link carrier/lifetimes, account controller, preview panel,
host lifecycle wiring, asset pinning and production gate.

No blocking security or correctness finding was identified within that
scope. In particular:

- A persona Web Lock spans fresh witness reads, staging, advances,
  promotion and endpoint shutdown. IndexedDB writes independently compare
  opaque revisions; no IndexedDB transaction spans network or cryptographic
  awaits. Scoped operations drain before releasing ownership.
- The manifest is recomputed from actual ciphertext, and inner seals bind
  persona, installation, object/session and generation. Active and staged
  objects change atomically with coordinator state. Missing records/keys,
  bad seals and unsupported readable formats do not trigger fresh enrolment.
- Advances follow durable staging. Effects and exact session marks return
  only after promotion and cleanup. Lost replies retain the candidate;
  subsequent operations reconcile before constructing another. Account
  context is checked again after awaited cleanup, so a stale account receives
  no successful effect.
- Genesis metadata is sealed and checked against the marker, dedicated
  writer seed and signed paired card. Enrolled identities/routes cannot be
  changed through ordinary writes. Keeper commands follow durable genesis;
  they are not treated as witness acceptance.
- Clear binds the reviewed installation under the lock. Retiring clear
  destroys inner keys and objects while retaining the writer and duty.
  Keeper assertions cannot override a known duty; signed retirement ends
  that duty only after replacement. Damaged or unsupported readable state
  is retained when it could still contain a duty.
- Dedicated Link leases close under writer ownership, including late starts
  and failures. Account/mode changes suppress replies and pause endpoints;
  quiet/Tor-only policies prevent connection startup. Cross-tab invalidation
  messages carry no persona identifier.
- The app requires both Vite development mode and the explicit preview flag.
  Runtime imports sit behind that gate; the entry point is initially hidden.
  MLS WASM is lazy-loaded and excluded from service-worker precaching.

The generic transaction callback remains trusted application code: it must
not publish, acknowledge or expose provisional output before an active
result. That is an explicit API boundary, not something the adapter can
enforce against arbitrary callback side effects. Future vault and room
integration must be reviewed at each of those call sites.

## Evidence examined

The reviewer inspected the storage, coordinator, enrolment, Link and panel
tests, including atomic-write interruption, rollback, missing keys/stages,
receipt replay/wrong-key handling, late shutdown, stale contexts and stale
clear confirmations. The real-witness lab source and its documented scope
were also inspected. Its process/profile cases use synthetic vault/session
records, not MLS room messages.

The reviewer independently ran `node scripts/check-vmls-wasm.mjs` and
`git diff --check origin/main...HEAD`; both passed on the reviewed head.
The reviewer did not rerun browser or daemon suites, to avoid competing with
the releasing agent's validation. The existing 180-case browser suite,
17-check real-daemon rehearsal and their explicit skips are documented in
[the integration record](browser-mls-integration.md) and
[the witness lab](browser-mls-witness-lab.md). Those records were inspected;
their results are not claimed as independently reproduced by this reviewer.

## Remaining gates

Production enablement still requires review and acceptance of coordinated
typed vault mutation/migration, credentials/consent/journals and box signing,
then the MLS room store/driver/client, exact witnessed generations,
installation checks, outbox/plaintext release and offline behaviour.

Full-app account/mode transitions against real Bothy, remaining cross-browser
process/restore cases, physical-device persistence and independent production
peer delivery remain separate acceptance work. The review does not establish
a browser Tor carrier, hardware-protected storage, protection against
same-origin script compromise, or independence when both the browser and
its witness are restored together. Browser transaction completion remains
the stated weaker durability boundary.

Changes to these reviewed security paths, especially production enablement
or new transaction callers, require a fresh review of the changed scope.
