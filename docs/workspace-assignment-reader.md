# Read-only workspace assignment observation

`AssignmentLog` accepts `AssignmentReaderOptions` for observing work in a room
the person has already deliberately joined. The PWA Inbox/Work interface uses
this observer alongside a bounded read-only chat reader. Native Android parity,
fresh-device summary delivery and the wider G9 acceptance journey remain
outstanding. This bounded view does not complete G9.

The start page, desktop project rail and phone room switcher expose **Inbox**
and **All work**. Signed-in workspace conversations also have direct phone
destinations for Inbox, Projects and All work. Project filters use the existing
signed project IDs. Inbox
reuses the canonical human-action projection for decisions and resolved chat
for unread human mentions and replies; routine agent progress stays out of it.
Work shows active assignments and their responsible principal. Choosing an
item opens its originating room and task or message; answers and reviews use
the room's existing controls and current head checks.

The view requests recent chat and assignment envelopes with a limit of 128
and a 24-hour window, without paging archives or publishing presence. It reads
only existing admission with a verified account binding and held room keys;
receiving a project
invitation cannot start a room observation. Temporary meetings and scheduled
self-destructing rooms are excluded. Quiet conversations currently require
opening the origin rather than reading their separate transport through this
observer. Closing the view stops its observations. Account changes, forgotten
or ended rooms and access-changing rekeys drop its data; authoritative closure
still follows the room's normal cleanup path.

A device signing credential expiring does not erase deliberately retained
read keys. The view verifies the saved credential's account/room binding at
issuance without renewing it or deleting it on read. The originating room
still checks current admission and credential validity before a signed update.

The observer uses the same signed assignment operations, admission-checked room
envelopes and canonical projection as the originating room. It can load the
origin's existing encrypted assignment journal, then request a bounded recent
replay and follow live updates. It receives neither a signer nor a device
credential. `submit()` and `retry()` fail before any storage or publication.
Its storage adapter exposes only `load()`: navigation cannot overwrite the
origin journal, acknowledge an uncertain send or create a second editable task
store. Live updates stay in memory until the observer closes.

```ts
const reader = new AssignmentLog({
  readOnly: true,
  participant: signedInAccount.pubkey,
  roomId,
  roomKey, // Existing admission only; project membership supplies no room key.
  transport: roomTransport,
  policy: roomPolicy,
  epoch: keptEpoch,
  storage: { load: () => loadOriginAssignmentJournal() },
  historyLimit: 128,
})
await reader.open()
```

The default query requests at most 128 historical envelopes from the last
24 hours; callers may choose a limit from 1 to 512 and an explicit `since`.
Processing also caps initial historical envelopes when a relay ignores its
limit. This bounds replay processing, not bytes sent by an uncooperative relay.
Cached operations still receive signature, schema and room checks. Damaged or
wrong-room envelopes cannot become assignments. Missing causal ancestors are
reported through `pendingHistory`; the observer never infers a task from an
unauthenticated summary.

Every observer snapshot has `historyComplete: false`, including after EOSE or
loading a populated journal. A bounded query can miss older work or its
ancestors. `ready` alone cannot justify saying there is nothing to review.
The full writable room log reports `historyComplete` only after its retained
replay ends with no unresolved parents or error. Even there, a relay can omit
events: EOSE is not a proof of availability or permanent retention.

An interface must show the originating project and room, identify incomplete
coverage, and open that room to hydrate its current canonical head before any
decision. It must obtain room keys through existing admission, use the current
account's journal namespace, follow authorised rekeys, and close and drop
observers when the account changes or the room is forgotten, revoked, ended
or expires. Temporary meetings must not gain retained task history through
navigation. Calling `close()` stops the observer and clears its in-memory work;
the caller owns and closes the transport. No admission, presence, media or
execution is started by the observer.
