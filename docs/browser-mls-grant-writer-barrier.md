# Browser grant-writer barrier foundation

This implements the dormant grant-storage foundation specified in
[Vennel #213](https://github.com/forgesworn/vennel/pull/213). No application
runtime constructs `BrowserMlsGrantCustody` yet. Wiring the foreground owner
and every grant operation requires a separate reviewed composition change.
Production MLS, terminal no-live lapse and pruning remain disabled.

## Retained storage

The owner uses the existing `kithmoot-vmls-grants-v1` IndexedDB database,
`keys/device`, `records/active` and store Web Lock. The encrypted version-2
payload contains only version, phase, random fence identifier and full grant
records, under distinct AES-GCM AAD. Primitive schema checks precede genuine
signed-event validation. Records retain all active/revocation statements,
timestamps, room uses and installing/active/revoking/revoked states.

The legacy array remains bounded at 256 records and 2 MiB canonical JSON.
A strict 256-byte envelope allowance and 16-byte authentication tag permit
an already full legacy ledger to migrate. Canonical record/event field order
and sorted node/device records make the full labelled fence digest independent
of object insertion order. The digest never replaces retained authority.

An absent record is empty legacy custody. Reuse its existing non-extractable
AES-GCM key, or generate the first key only when both record and key are absent.
Initial key and fenced ciphertext are saved atomically across both stores.
Existing ciphertext with missing/changed/invalid key refuses without repair.
Version-1 data restored into an upgraded database and unknown schemas refuse;
keys, ciphertext and signed withdrawal material are never deleted to recover.

## Preparation and concurrency

`prepare(current, signal)` requires the foreground owner's real AbortSignal
and current callback. Start it outside device/node locks and persona/room
transactions. The future foreground composition must synchronously abort this
signal on its account/session invalidation; a callback alone cannot interrupt
a committing IndexedDB transaction. No read or put implicitly prepares storage.
An interrupted preparation result describes the attempt, not a claim that a
durable fence was necessarily written. The encrypted phase must be freshly
verified; abort before the first write can leave legacy custody unchanged.

Preparation takes the migration lock, then the store lock, validates custody
and writes a durable encrypted fence. It releases the store lock before draining
all retained legacy node/device locks in canonical order, including revoked
records. A fresh unseen-node legacy writer fails its version-1 read; work
already past its saved installing/revoking record must settle and release its
legacy lock. Failure of its final put preserves the frozen uncertain state.
Simulated publication settlement does not prove the box rejected an event.

While retaining those locks, preparation closes its own connection and requests
database version 2. An idle old connection may block that upgrade. A blocked
attempt returns blocked, remains fenced, and aborts any late upgrade transaction;
it never converts a late success into readiness. A subsequent current attempt
may resume after the abandoned request actually terminates. New connections
close and invalidate on version change. Fresh legacy version-1 opens refuse
after a completed upgrade.

After the actual upgrade, preparation reacquires the store lock, decrypts the
exact retained fence with the freshly stored key and compares the full digest.
Only the current owner can atomically change fenced to ready. Lifecycle abort
aborts an in-progress storage transaction. All new reads/puts require the
concrete database's version 2, valid key/ciphertext and ready phase. A cached
ready connection cannot survive a version change. Concurrent preparation
owners serialize through the shared migration namespace.

## Evidence and limits

Browser tests use real IndexedDB, AES-GCM keys and Web Locks in Chromium,
Firefox and WebKit. The legacy version-1 store is the actual implementation;
publication/cleanup ordering is a fixture following the historical node/device
lock order with simulated carrier settlement. It is not a complete historical
app, separate-process or live Bothy acceptance test.

Coverage includes empty/no-key and empty/existing-key storage, initial-key and
record quota rollback, all four retained states, exactly 256 records/2 MiB,
fence-before-drain, an unseen-node writer, idle legacy connection blocking,
abandoned upgrades, foreground abort during the ready transaction, changed
fence evidence, missing/changed keys, restored legacy data, missing records,
concurrent owners and cached-connection invalidation. Unit checks cover hostile
coercions, canonical binding, duplicate/excessive authority and changed genuine
signed statements.

This is exclusion of cooperating browser grant writers in one origin/storage
partition. It does not stop modified clients, old room/persona writers or cached
MLS engines, invalidate backups, or cover another process/profile. It supplies
no remote revocation, rollback or no-live proof. Runtime composition, broader
old-client/schema and recovery boundaries, safe candidate retirement, pruning/
renewal, operator UI, live/handset/physical and independent production acceptance
remain open. No state is pruned, no endpoint is started by preparation, and no
terminal grant outcome is inferred from local migration readiness.
