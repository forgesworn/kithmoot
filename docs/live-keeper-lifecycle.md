# Durable authority for live persistent admission

This is the storage/authority owner for the opt-in live persistent wire profile
in fold-kit. It does not turn an ordinary keeper v2 export into evidence that an
invitation is active. New lifecycle journals create a fresh persistent room;
opening requires that exact existing journal. No automatic legacy import exists.

## Durable boundaries

One encrypted journal binds the epoch-zero room, root inviter, bearer, signed
invitation and fixed relay policy. It keeps the current keeper snapshot, active/
retired/closed lifecycle, pending signed transition, request replay cache and
rolling control budget together. A pending transition contains the exact signed
event(s) and next keeper snapshot, including the next secret. Save it before
any handoff. While pending, answer no admission request and prepare no competing
transition. A failed/ambiguous handoff retains those bytes. After restart,
reoffer those same IDs; never mint another epoch secret or re-sign a replacement.

A retirement becomes durable before its tombstone leaves. A closing rekey stages
closed state and the retirement/rekey pair together. A successful local handoff
allows committing the next state; it is not delivery to all members. A storage
failure poisons that owner, even if the write might have reached disk. Opening
again validates whichever complete record is present. Known retirement and
closure cannot be undone by a refreshed invitation or a later keeper snapshot.
Rekey preparation checks the root signature, next epoch, epoch-secret commitment,
removed/member sets, room identity and unchanged/sticky lifetime policy.

Answer requests under the same serial queue. Check active state and the signed
invitation on every attempt. Cache one root-signed answer per request ID, commit
it and reserve budget before publication, then retry only those bytes while the
request and answer remain live. Never turn a requester key/name into membership.
The client still needs an authenticated epoch desk response even at epoch zero.

Keep at most 128 request guards, and at most three answer offers per request.
Retain guards to request expiry. Refuse at capacity instead of evicting live
ones. At most 16 new challenges and 64 KiB of control offers per rolling minute
per journal, persisted across restart. At most 64 bounded requests enter
cryptographic verification per rolling minute; reserve that check before doing
it. Invalid requests consume this work allowance too. The in-memory operation
queue refuses more than 128 waiting calls. A process hosting multiple authorities
must additionally enforce the shared process budget from the wire specification;
the journal's per-room limit cannot prove that aggregate. Wall-clock rollback
below the saved high-water time refuses output until time catches up. These are
control-work bounds, not an RF airtime allowance.

## Local Node storage

Use a private, owner-only directory on a local filesystem. Keep an AES-256-GCM
encrypted journal under a separate caller-supplied 32-byte storage key, with a
fresh nonce and fixed associated-data domain for each save. Bound reads/writes
to two MiB. A temporary owner-only file, file fsync, atomic rename and directory
fsync form a save. Clean temporary files on normal errors; a process-killed
temporary file is ciphertext only. The caller owns backup and key deletion.

An adjacent SQLite lease file holds `BEGIN IMMEDIATE` on a dedicated connection
for the owner's lifetime. The journal is a separate file so saves do not release
that lease. Contenders fail rather than deleting a supposedly stale lock. Process
death releases the database lock; the lease file is never unlinked. Canonicalise
the private directory and refuse symlink/hardlink files. Check the lease inode
before each store operation. This protects cooperative owners of one local
journal, not copied keys/journals, writable directory replacement, broken
filesystem locks or a hostile process with the same account.

Node 22.13 makes `node:sqlite` available without its earlier flag; no later
constructor options are required. SQLite permits a single reserved writer.
Sources: [Node 22.13 SQLite](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html),
[SQLite locking](https://www.sqlite.org/lockingv3.html). No network filesystem
or multi-host root ownership is qualified by this adapter.

## Integration and acceptance

The owner exposes a snapshot for a room session, but the session must route all
root rekeys/retirements through its prepare/offer/commit boundary before live
admission is enabled. The existing RoomAgent post-publication `onState` callback
does not satisfy that contract. Do not install the live responder beside an
unmodified writable root session. Browser/Android durable storage needs its own
adapter; the Node lease is not a portable storage API.

Acceptance must cover encrypted cold reopening, duplicate answers after process
death, retirement surviving SIGKILL before handoff, pending rekey preserving its
exact ID and next secret, competing processes, failure before write and after
rename, altered/corrupt state, budget/clock rollback and authority substitution.
Actual RoomAgent lifecycle wiring, first-time RoomSession admission, offline
epoch recovery and physical BLE/LoRa remain separate end-to-end gates.

## Local implementation evidence

Seventeen focused tests pass, including four real child-process SIGKILL scenarios:
exclusive ownership, pending retirement, pending rekey and uncertain answer
handoff. A separate filesystem fault after rename and before directory fsync
poisons the owner and then reopens the same pending event/secret. Tests also
cover the fixed reply ID across reopen, three-offer cap, persisted challenge
quota, clock rollback, authority/secret/policy substitution, authenticated disk
corruption, symlinks and private file permissions. All fixture directories are
removed after testing. A mesh-only authority needs no relay configuration.
No radio, real room or public relay is involved.

Library build, application type checking and production web build pass locally.
A broader local test run was stopped after failures in existing media annotation
and audio-level/clipping tests; it is not recorded as a passing regression run.
Full hosted CI remains the merge gate.

The implementation is `src/live-keeper.ts`; Node storage is
`src/node/live-keeper-store.ts`. Both are explicit internal modules, with no
production route or existing keeper opting in. The dependency pins merged
fold-kit `e99a348` for its new codecs; it does not publish a package version.
