# Production owner for live admission

The requester and initial root epoch gate are implemented. Before enabling the
responder, enforce the wire profile's aggregate budget: at most eight active
rooms, 16 new challenges, 64 KiB of answer offers and 64 pre-crypto request
checks per rolling minute for the authority process. Requester keys are not
quota identities. Per-room journal limits continue to apply.

One explicit, exclusively held durable ledger is shared by all enabled rooms.
Only one ledger owner may be open in this JavaScript runtime. Reopen the same
ledger across process restart; creating another file is an operator reset, not
recovery. Use the existing owner-only encrypted local store and SQLite lease,
in a separate file with its own storage key. Keep strict versioned budget data,
a random ledger identity, high-water wall time and bounded reservations. Refuse
missing/corrupt data on reopen, rollback, competing ownership and ambiguous
saves. A failed save poisons the owner. No public relay or default route is
constructed by this owner.

Reserve global verification work before decoding a bounded request. Reserve
challenge/answer bytes before the journal commits its signed answer and before
handoff. The ledger and room journal are separate transactions: a crash between
them can waste a reservation, never give it back or increase the allowance.
An ambiguous handoff retains the journal's exact reply ID and charges each later
offer again. The ledger stores counters/timestamps, not invitation capabilities
or peer identities. Bound pending requests globally as well as per room; closed
room registrations remain occupied until their queued work drains.

`RoomAgent.create` must opt in with both a live journal and this ledger. Register
at most one responder for each root room, subscribe only to kind 20466 and the
exact invitation selector, and call the existing journal answer transaction.
The room's transition guard remains authoritative at handoff. Stop subscription
and reject queued handoffs on leave, retirement or closure. Never turn the
requester's reply key into membership; the existing authenticated epoch desk
still applies removed/unknown policy. Legacy invitation hosting remains off.
The host owns its registration; the caller closes the shared ledger only after
all agents have left. Default live-journal creation stays non-serving.

Acceptance: two actual rooms share the new-challenge and byte ceilings; invalid
signatures spend global pre-crypto work; replay/three-offer/expiry rules survive
ledger+journal reopening; eight-room and queue limits cannot be reset by close
while work is pending; failures before save and after rename produce no extra
handoff; wall rollback refuses; runtime and filesystem ownership exclude rivals.
An actual `RoomAgent.joinLive` must reach this responder without a fixture
subscription, pass epoch zero, chat both ways and recover from encrypted-store
restart. This remains distinct from app UI, complete client process death and
physical BLE/LoRa acceptance.

## Explicit Node host setup

Keep the budget and room journal in separate owner-only encrypted files with
separate keys. Provision them once with `create`; on every later run use `open`
and fail if either file is missing. An operator must not reset the budget by
changing its path. All room agents in the authority share that same owner:

```ts
const budget = LiveAdmissionBudget.open(
  new EncryptedLiveKeeperStore(budgetPath, budgetStorageKey),
)
const journal = LiveKeeperJournal.open(
  new EncryptedLiveKeeperStore(roomPath, roomStorageKey),
)
const root = await RoomAgent.create({
  name: 'Room keeper', base: roomAppBase,
  liveKeeper: journal, liveAdmission: budget,
  transport: explicitlySelectedTransport,
})
// After all agents sharing this budget have left:
await root.leave()
budget.close()
```

These are explicit source/library modules, not a new default CLI route. The
owner qualifies one JavaScript runtime and one local filesystem. Do not split
an authority across worker runtimes, copied ledgers or multiple hosts; those
need coordinated ownership. SQLite lease and process-local registration do not
protect against a hostile process running as the same OS account. The existing
store envelope is reused with a distinct, strictly validated budget payload;
substituting a room journal for a budget is refused.
