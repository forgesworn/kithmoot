# The room's own board

Every room has a board, and so has every private chat, which is a room of
two. Nobody creates it, shares it or joins it: being in the room is having
the board, and being removed from the room is losing it at the same rekey.

It is Girnel, whole: the board, table and calendar views, cards with
descriptions, checklists, labels, due dates, comments, files and people to
assign, the activity log, filters, search, archive and restore, delete, undo,
export and the keyboard shortcuts. The frame runs the same board screen and the same
commands as Girnel's own app, on the room's document instead of a circle of
its own ([how](https://github.com/forgesworn/girnel/blob/main/docs/room-board-view.md)).

**A room has one board, and it is this one.** It is separate from the boards
described in [Girnel Boards in KithMoot](girnel-boards-delivery.md). Those are
a person's own boards, kept outside any room, each a circle of its own with a
keeper, an invitation and its own membership. They are reached from **Your
own boards** under the other tabs of Boards, and are as they were, with one
exception decided on 25 November 2026: **a room is no longer offered one.**

- Nothing offers to share such a board with a chat, and a new one no longer
  takes the open chat as its own. The app's means of sharing are kept in the
  code and are not offered (`offersRoomSharing` in `app/src/boards-panel.ts`).
- A board shared with a chat before that is still there: the chat's list of
  them is still read, they are in the strip above its conversation, and they
  open and are edited as before.
- A person may still keep one of their own boards beside a chat, with their
  own label. That puts it in the strip for them alone and tells nobody.

The room's own board has none of that machinery because it does not need it:
the room already has a key, an epoch, a roster and relays.

## What a person sees

**Boards**, in the rail, opens on the board of the room that is open. It is
the first tab there, named after the room, beside **Needs you** and **All**.
There is no account to sign in to and nothing to set up: a visitor with only
the room's link and a name has the board on the same terms as somebody
signed in, and it opens at once from this device's copy.

From inside the room the same place is reached from **Board** in the ⋯ menu
and in Room info, which is also the way on a phone, where a room hides the
rail. Once anybody has put something on the board, the room has a **Board**
tab beside Chat, for everybody in it, whether or not they have opened the
board themselves. A room nobody has put anything on keeps its whole screen
for the conversation. **Back to chat**, on the board, returns to it.

The line over the board says where it stands:

- **Shared with everyone in this room.** The room's relays hold everything
  this device holds.
- **Sending your changes to the room…** An edit is on its way.
- An error, followed by "Your changes are kept on this device and sent when
  they can be." Nothing is lost; it goes when a relay takes it.

Four things on the board reach into the room, because the room already has
them:

- **Invite people** opens the room's own invitation, since coming into the
  room is how somebody comes to have the board. A private chat, which nobody
  can be invited to, has no such button.
- **Discuss in chat**, on a card, puts the card's title into the
  conversation's draft for the person to finish and send.
- **Assign to agent**, on a card, opens the room's task form filled in from
  the card: its title as what needs doing and its description as what will
  count as done. The person chooses who and shares it. What comes of it is
  in the room's tasks, not on the card.
- **Add file**, on a card: see Files on cards, below.

The chat list stays beside the board, so another chat is one click away.
If something is typed on the board and not yet saved to it, the room asks
before it is left.

## Where the board lives

Three places, none of them a server that keeps it:

1. **Each member's device.** An encrypted copy, so the board opens with no
   relay and survives every relay forgetting it.
2. **The room's relays**, as stored events in the room's board stream. They
   see opaque ids, sizes and timing, as they do for chat.
3. **Nowhere else.** There is no keeper, no board server and no list of
   boards.

## On the wire

The board is a [Yjs](https://github.com/yjs/yjs) document. Its changes are
Yjs updates: they merge in any order and any number of times.

**Stream.** The channel named `board`, derived from the room's current epoch
root exactly as any channel is (`deriveChannel`). A new epoch is a new
stream.

**Envelope.** An ordinary chat envelope (kind 1460, envelope 1) whose single
statement is `board`. Everything the chat envelope checks is checked: the
event's signature, the device that signed it, that device's credential for
the participant in this room as at the time of sending, and the room's
access policy. `text` is `Board update`. A `board` statement is refused
outside the `board` channel, beside any other statement, or beside
conversation fields.

**Part.** The statement is one part of one blob:

| Field | Meaning |
|-------|---------|
| `v` | `1` |
| `kind` | `update` (some changes) or `snapshot` (the sender's whole board) |
| `blob` | 32 lower-case hex characters, random, naming the blob |
| `index` | this part's place, from 0 |
| `count` | parts in the blob, 1 to 96 |
| `data` | this part's bytes, padded standard base64, at most 22 KiB (22,528 bytes) decoded |

Exactly these fields. A blob is at most 96 parts, about 2 MiB. A full part
makes an event of about 45 KB, inside the 64 KB that common relays stop at.
Parts of one
blob join only when they come from the same authenticated device, in any
order; a part that contradicts the others under its id drops the blob. Both
kinds merge. Neither replaces what a reader holds: a snapshot is a place for
a late arrival to start, not an authority.

**Starting state.** Every member applies the same 402 bytes before anything
else (`ROOM_BOARD_GENESIS`): three columns and the board view, written by a
fixed Yjs client with fixed ids and no clock reading. Two people who open an
empty room at the same moment therefore hold one set of columns, not a set
each. It is never sent, because everybody already has it.

Vectors: [`vectors/room-board-v1.json`](../vectors/room-board-v1.json),
assembled by hand in `vectors/generate-room-board.mjs` and checked in
`vectors/room-board-v1.test.ts`. The starting state there is built straight
from the document format, independently of Girnel's board model, and is the
same bytes.

## Keeping in step

A device holds two documents: the board, and everything the room's stream is
known to hold in this epoch (what it has read from the stream, and what it
has sent and a relay accepted). One rule covers the rest:

> Whatever the board holds that the stream does not, send.

That is the outbox for an edit made offline, the repair when a relay forgets
the board, and the hand-over when the room moves to a new epoch and its
stream starts empty. A device sends after a short pause for edits (1.2 s of
quiet, 5 s at most) and, once it has read a stream to its end, after a
random 1.5 to 6 s, looking again before it sends so that several devices
holding the same board do not all send it. What is sent is the difference,
or the whole board as a snapshot when the stream has none or has gathered
100 updates since the last.

A failed send is retried, 5 s doubling to 60 s, for as long as the room is
open. A device that already holds a copy of a room's board opens it with the
room, so work written offline goes without the tab being opened.

**Knowing the board is in use.** A client that has not opened the board asks
the room's relays for one stored event of the board stream and listens for
the first (`RoomSession.watchBoard`). It decrypts nothing and loads no
document; any event there means somebody has written to the board, which is
what puts the Board tab in the room. The watch moves with the room at a
rekey.

## Removal and rekey

A removed member is not given the new epoch, so cannot read or write its
stream. They keep what they had already read, as with chat.

Members who remain hand the board to the new stream by the rule above. A
newcomer who knows only the new epoch gets the whole board from whichever
remaining member's device sent it. If nobody who holds the board has been
online since the rekey, a newcomer sees the starting state until one of them
is; what the newcomer adds meanwhile merges when they are.

This log reads the current epoch's stream only.

## This device's copy

A set of records, not a file. Each is some of the board's changes, sealed as
NIP-44 ciphertext under a key derived from the room key
(`kithmoot/v1/room-board-cache:<room id>`), in pieces of at most 30,000
bytes, and named by the SHA-256 of its text. In the browser each is one
storage entry, `kithmoot.room-board.v1.<participant>.<room id>.r.<name>`.

Records merge in any order, so the copy has no head, no chain and no single
writer. Two tabs of one browser in one room write side by side, and neither
can undo the other: after 32 records a writer writes the whole board as one
and removes only the records it had itself read or written. A record another
tab added meanwhile is not among them and stays.

A record that cannot be read is left exactly as it is and is never removed,
because it may hold work that was never sent. The rest of the board opens,
from the other records and from the room, and the board says that part of
this device's copy could not be read. If saving fails, the board stays open
and in step with the room, says that it could not be saved here, and tries
again.

Forgetting a room, a room that self-destructs and **Forget this browser**
each remove the records. A self-destructing room also asks the relays to
delete what this device signed there, which includes its board events.

## Files on cards

A file on a card is the same thing as a file shared in the room's
conversation: sealed on the device under a fresh key, with its metadata
removed, and uploaded as an opaque envelope. **Add file** sends it down the
very road a chat file takes, and the upload is recorded with everything else
this device left in the room. Only the last step differs: the reference (the
server, the envelope's hash, the key, the name, type and size) goes onto the
card, in the board's document, and not into a message. It is written only
once the upload has succeeded.

Where it goes is where a file shared in that room goes:

- **To the file server this person uses** (`shareDroppedFile`). Somebody who
  has never sent a file is asked on the card what a chat asks beside Send,
  once and in the same words, because a card has no Send to be the act.
  Agreeing writes the choice down exactly as Send does; declining uploads
  nothing. The card names the server the file was sent to, since a Blossom
  server answers for a file at its hash whatever address its reply gave.
- **To the room's own storage**, where the room lists some
  (`shareDroppedFileToGroup`): the first of the group's computers that takes
  it, with this device's token, and no announcement on any relay. The card
  names that computer by its origin, and the room's signed list says where on
  it the file is, so another member reads it with a token of their own.

While a file is on its way its row says which stage it has reached. One that
did not go stays on the card, for that person only, with the reason and
**Try again**: nothing is put on the card for anybody else until a file is
somewhere. That is also what happens when none of the group's computers can
take a file just now. A chat would hold it and send later; a card does not
wait.

Opening is the room's too. **Download** or **Open** on a card's file shows
it in the card a message's file has: nothing is fetched until the person
presses, the bytes are checked against the hash before the key touches them,
and what the file says it is is never taken on trust. Any member can write a
reference onto a card, so it is read as a stranger's would be, and the board's
frame never fetches one.

A card's reference is an https server and a hash. A room whose files go
through Bothy has no such address for one, so **Add file** there says so and
uploads nothing. So does a device with uploads turned off, with the way to
turn them on.

Taking a file off a card removes the reference for everybody. It does not
delete the upload. The upload goes when its sender leaves the room and asks
for what they left to be deleted, as a chat file does.

## Who can change what

Everybody in the room, agents included, edits on equal terms. A change is
authenticated as coming from a member. What it says inside the board, such
as who wrote a comment or who moved a card, is that member's claim and is
not separately signed. Any member can change or delete any card. There is no
undo across devices beyond what the board's own archive keeps.

## Limits

- **Not in quiet rooms or quiet chats.** A quiet room writes nothing but what
  somebody says, in its own slots, and suppresses even delivery receipts for
  what their timing gives away. A board would write a stream of its own
  there, and a relay would see when somebody was working on it. So a quiet
  room has none, by decision: its menu offers no Board, and Boards says
  that the room is quiet, that it has no board of its own, and why. It keeps
  its tasks, and any board that was shared with it before 25 November 2026.
  It is offered no new one, like any room, so a quiet room that had none has
  none. A board that rode
  the quiet slots would keep the promise; it is not built.
- **Web and desktop.** The desktop app carries the same web build, and has
  been run with the board from source: see What has been checked. A packaged,
  signed build installed from a release has not. The Android app does not
  show the board. The vectors are what a native client follows; it needs a
  Yjs-compatible document library.
- **Agents hold the board, with no tools for it yet.** `RoomSession.board()`
  gives an agent the same document on the same terms, and an agent that
  edits it is saved and sent like anybody. `kithmoot-agent` has no board
  tools, so its brains cannot read or write cards.
- **No files on cards in a room whose files go through Bothy.** See Files on
  cards. A card's file shows which stage it has reached, not how many bytes
  have gone.
- **Export is the board's text.** It names the files on cards and does not
  include them; nothing in the frame can read a file, so no bundle is offered.
- **An agent's work is not written back to the card.** Assign to agent makes
  a room task from the card; the two are not linked afterwards.
- **A card in the chat is its title**, not a link that opens the card.
- **Boards opens on the room's board** even when something under Needs you
  is waiting for this account, by decision; that tab is one click along.
- **The stream is read whole on opening.** A long-lived busy board reads as
  many events as its relays return; snapshots keep a place to start inside
  that.
- **A relay still decides what it keeps.** A room with an end time carries
  that end as the events' expiry, as chat does. The board outlives its
  relays only on devices that hold it.
- **Protected startup.** The records above are a new storage name.
  [The storage inventory](ordinary-storage-inventory.md) lists it; the
  protected-startup classifier does not recognise it yet and must before
  that startup is mounted. `RoomSession.board()` also loads its code before
  it builds the log, so an embedding that fences protocol work
  (`ProtocolExecution`) needs a boundary of its own around it, as channels
  have.

## What has been checked

- **Unit and protocol** (`src/room-board-log.test.ts`,
  `vectors/room-board-v1.test.ts`): convergence, a late arrival after every
  author has gone, edits made offline and after a restart, a relay that has
  forgotten the board, removal and rekey, parts, refusals, two writers on one
  copy, an unreadable copy, deletion with everything else a device signed.
- **Browsers** (`test/room-board.spec.ts`): the same journeys with separate
  browsers for each person, in Chromium, Firefox and WebKit and in the desktop
  build; the whole of Girnel between two visitors (one click from Boards,
  table and calendar, filters, an activity line under the name the room
  knows somebody by, undo across somebody else's change, export, delete,
  Invite people, Discuss in chat, Assign to agent); a first file on a card
  asking where files may go, declined, kept on the card and tried again; a
  file put on a card, said to be uploading while it went, opened by somebody
  else after its sender had gone, and deleted by the sender's tidy-up;
  half-typed text kept through a switch of chat; the board
  on a phone, from the room's menu and back to the conversation; an axe scan
  of Boards with the board showing; two tabs of one browser on one room;
  forgetting a room. The view
  under the production content security policy, export included, is in
  `test/boards.spec.ts`.
- **Where a card's file goes** (Chromium and the desktop build). The public
  server a new device would use, agreed to on the card, for two files with
  one question, and written down as Send writes it
  (`test/files-public-first.spec.ts`). A room with storage of its own: the
  file goes to the node with a token and no announcement, another member
  opens it from the card, and with the node down the card says so, names
  nothing, and takes the file on Try again; a device the keeper has not yet
  let in says so, asks the keeper, and sends the file on Try again once it
  has been (`test/group-storage.spec.ts`).
- **The desktop app itself** (`desktop/test/room-board.spec.ts`, run by hand
  on a Mac, not in CI): two copies of the Electron app from source, each with
  a profile of its own and a visitor with only the link. Boards opens the
  room's board; a card written in one is found in the other, which arrived
  afterwards; a move is seen with its author's name; the frame has no Node
  and no service worker; export saves a file through the app's own download.
- **A private chat** (`src/room-board-log.test.ts`): the board on the same
  terms for the two, read by the second after the first has gone, and a
  well-formed change from anybody else refused. In a browser
  (`test/contact-messaging.spec.ts`): two signed-in people in a private
  chat, a card put there by one and found by the other, each under the name
  they know the chat by, and no Invite people.
- **Public relays** (`test/live.test.ts`): a board of several full parts
  written by one session and read whole by another.

Not checked: a desktop app installed from a release, a phone, a room whose
files go through Bothy, a room whose storage is listed with a path after its
host (the card names the host, and the room's list is relied on for the
rest), a board of more than a few hundred kilobytes, or a room whose only
relays refuse 45 KB events.

## In the code

| File | What it is |
|------|------------|
| `src/room-board-wire.ts` | Channel, part, limits, splitting and joining, the starting state |
| `src/room-board-log.ts` | `RoomBoardLog`: the two documents, the stream, the local copy |
| `src/session.ts` | `RoomSession.board(storage)`: one log per session, rekeyed and closed with it; `watchBoard` |
| `src/chat.ts` | The `board` statement in the chat envelope |
| `app/src/room-board-panel.ts` | The board's surface in Boards, and the frame it hands updates to |
| `app/src/workspace-work.ts` | Boards, the destination: the room's board is its first tab |
| `app/src/main.ts` | `addRoomBoardFile`, `openRoomBoardFile`: a card's file, by the room's own file sharing |
| `desktop/test/room-board.spec.ts` | The board in the desktop app itself, two copies of it |
| `forgesworn/girnel` `src/embedded-room.ts` | The view: Girnel's board screen on the room's document. It holds no key, signer or relay and stores none of the board |
