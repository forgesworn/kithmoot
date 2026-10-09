# Browser MLS session host (P3-03c)

This is the session persistence boundary for browser MLS rooms. It has no app,
room or network caller and is not production enabled. It follows the shared
[Vennel driver contract](https://github.com/forgesworn/vennel/blob/main/docs/vmls-driver.md)
and uses the existing pinned WASM and coordinated persona store.

## What is covered

`BrowserMlsSessionHost` opens a fresh engine handle for every operation. Under
one persona Web Lock, the coordinator reconciles any uncertain candidate and
freshly checks the witness before the host opens a snapshot. The saved snapshot,
opened engine and witnessed session generation must agree exactly; the witness
subject's sequence is not a session generation. No live session is cached.

A synchronous engine call supplies its next snapshot and provisional result.
The host checks the session id and generation, seals the snapshot through the
persona transaction, then waits for stage, witness advance and promotion. Only
after promotion does the coordinator's synchronous activation hook check the
exact mark and call `commitAck`, still under that writer lock. The hook must
not publish effects, call another transaction or start asynchronous work.

The result remains private through witness-channel shutdown and lock release.
The host frees the engine before returning, and rechecks the captured account /
room / privacy context and its own invalidation epoch. A stale context, failed
activation, storage error or cleanup error releases nothing. Committed state
is never rolled back after an activation error: the next call reopens its
exact durable snapshot and outbox. All opened and generated snapshot buffers,
original result byte arrays, and withheld result copies are wiped on exit.
JavaScript cannot promise physical erasure of runtime copies or strings.

Explicit creation requires generation one, not yet acknowledged, and rejects
an existing id. A single sealed vault record, `mls-session-ids`, remembers every
adopted id alongside the witnessed first snapshot. Dropping a session is also
witnessed and retains that id, so an old ratchet cannot be adopted again. The
record allows 1,024 lifetime session ids per persona installation and refuses
further creation at the bound; it never evicts tombstones. Discovery is a fresh
witness operation, so an uncertain creation can be found after restart.

The host's callbacks are trusted engine code, not a sandbox or protocol parser.
They transfer ownership of snapshots and structured-cloneable result data to
the host, must not retain handles or publish, and must not reenter the persona
vault. A no-snapshot call must leave the session id and generation unchanged;
its value can contain existing outbox/read data or an engine duplicate result.
The host cannot authenticate arbitrary data fabricated by such a callback.
Future concrete room callers need their own review of effect classification.

## Acceptance boundary

The browser fixture runs the shipped Rust WASM, WebCrypto and IndexedDB with a
disposable independent witness signer. It uses real group creation, ratchets,
capability exchange and Add proposals, not fabricated session snapshots. It
checks separate session generations, exact ciphertext on reads, missing and
duplicate sessions, witnessed drops, old-id refusal, uncertain creation,
concurrent calls and two tabs. It also exercises interrupted stage/promotion,
accepted lost replies, activation/free/channel-close failures, stale contexts,
invalid step ids/generations, missing snapshots, witness outage/refusal,
profile rollback, replayed receipts, wrong keys and changed box installation.

The outbox cases propose a real Add (a one-member send has no recipient
outbox). They compare exact recovered record ids and envelope bytes across
reopens, then witness delivery acknowledgement. OpenMLS validates KeyPackage
lifetimes against the runtime clock, so the fixture uses the current test time.
No test uses a production identity, box, route or data.

These are automated browser fixtures. They are not a real-Bothy room journey,
an OS process-kill test of MLS sessions, authenticated production-room
acceptance, Android/browser composition or physical-device acceptance.

## Remaining before browser rooms

- Connect current device credentials and typed signing to owned, one-shot
  pending create/join/update operations; revalidate account, device and exact
  snapshot after asynchronous signing. The generic host does not provide that
  ceremony or an arbitrary snapshot import API.
- Add the room store, including accepted plaintext/history and room metadata
  committed with receive snapshots before acknowledging fetched records.
  Provisional event returns alone do not recover chat history after a crash.
- Implement the strict box client and driver: capabilities on open and every
  reply, installation comparison, Gap fetching, exact outbox ordering, signed
  receipt checks, lost-reply/status reconciliation, and privacy/offline policy.
- Add explicit encrypted drafts and locally accepted offline history reads.
  This host never runs a fresh send or receive ratchet without the witness.
- Complete room UI, peer membership/revocation, real-box and cross-client
  acceptance, physical tests and the production enablement review.

The session-host review does not close P3-03c or enable MLS rooms. The existing
`import.meta.env.DEV && VITE_BROWSER_MLS_PREVIEW` gate and both WASM pins remain
unchanged.
