# The room board over a message port

A room's board can run on a page that holds none of the room's keys, kept in
step by an app that holds them at the other end of a message port. An
Android WebView is such a page: the app transfers it one port, as it does for
the attachment cleaner, and exposes no object of its own.

The page's half is `src/room-board-port.ts` (`openRoomBoardOverPort`), over
`RoomBoardSync` (`src/room-board-sync.ts`), the same board the web runs. This
is the other half: what the app (here, "the app") must do. It is checked
against the web's own board in `src/room-board-port.test.ts`, whose stand-in
for the app does only what follows.

## Who holds what

| The page | The app |
|----------|---------|
| The board (a Yjs document), the stream's document, what is owed | The room's key and epoch, this device's key and credential |
| Girnel's room view, when it is on screen | The relays, and the subscription to the board's stream |
| Nothing it keeps: its copy is the app's | This device's copy of the board, sealed as the app seals anything at rest |

No key, credential, relay address or account crosses the port.

## Messages

Every message is a JSON string of at most 48,000 characters with `"v": 1`
and a type `t`. Either side ignores a message it does not understand, of
another version, or too long. Binary data is padded standard base64, at most
30,000 bytes (40,000 characters) to a message.

Requests carry `re`, a name chosen by the side that asks, and are answered by
`{"t": "reply", "re", "ok": true, ...}` or `{"t": "reply", "re", "ok": false,
"error"}`. `error` is shown to the person, so it is a sentence in their words
(at most 500 characters).

### Starting

1. The page sends `ready`.
2. The app sends `start`: `self`, this person's key as 64 lower-case hex
   characters, and `invite`, `assign` and `files`, which say whether the room
   offers those buttons (a private chat cannot be invited to; a room routed
   through Bothy does not carry tasks yet).
3. The app sends `members` whenever the room's members change: `members`, a
   list of `{pubkey, name}`, as the room knows them. A list too long for one
   message is cut short; a member left out shows by key.
4. The page reads its copy (`copy.read`), then starts reading the stream.

### Reading the stream

- The page sends `listen` with `gen`, a number that grows with each reading.
  The app subscribes to the board's stream: kind 1460 events whose `d` is the
  channel `board` derived from the room's current epoch (`deriveChannel`), as
  the web does. It ends any reading of an older `gen`.
- For each event the app opens it exactly as chat is opened
  (`decodeChatEvent` with channel `board`): a member's, in this room, this
  epoch and this channel, with a credential good at the time it was sent. An
  event that does not open, or carries no board part, goes no further. One
  that does is handed over as `part`: `gen`, `event` (its id), `device` (its
  authenticated device), `sentAt` (the time it was sent, Unix seconds) and
  `part`. Handing over the same event twice is harmless; the app may skip
  events it has already handed over in this reading.
- When the relays have sent everything they held, the app sends `caughtUp`
  with `gen`. Until then the board says it is still being read.
- When the room moves to a new epoch, the app sends `rekey`. The page sends
  `unlisten` for the old reading and `listen` for a new one, and hands the
  new stream whatever it lacks. Anything the app still sends under an old
  `gen` is dropped.

### Sending

- `seal` (`re`, `part`): the app makes the part an event of the board's
  stream, as `RoomBoardLog` does. It checks the part is one in its one honest
  shape (`validBoardPart`) and refuses anything else. It uses this device's
  credential, asking for a fresh one once if it has run out, and the text
  `Board update`. It carries the name, proof, owner and expiry the room's
  chat carries, and seals and signs it in the current epoch. It then opens it
  again as a reader would, and refuses it if a reader would. It keeps the
  signed event, and answers with `event`, the event's id, and `createdAt`, its
  `created_at`.
- `publish` (`re`, `event`): the app publishes that event to the room's
  relays. It answers `ok` only once a relay has accepted it, and refuses in
  words otherwise. Until then the page counts the change as not yet the
  room's, and tries again.

### This device's copy

- `copy.read` (`re`): the app sends each record it keeps as one or more
  `copy.record` messages (`re`, `record`, its name; `index`; `count`; `data`),
  then answers with `unread`, the number of records it could not open. A
  record it could not open is left exactly as it is.
- `copy.add` (`re`, `index`, `count`, `data`): one record in `count` pieces.
  Once it holds them all the app keeps the record, durably, and answers with
  `record`, the name it gave it.
- `copy.remove` (`re`, `records`): forget these. A name it does not keep is
  not an error. The page removes only records it has read or written.

### Where the board stands

The page sends `status` whenever it changes: `ready` (the stream has been
read), `pending` (this device holds changes the room is not known to hold)
and, until it is put right, `error`. The app shows it beside the board, as the
web does: "Reading the room's board…", "Sending your changes to the room…",
"Shared with everyone in this room.", or the error followed by "Your changes
are kept on this device and sent when they can be."

### The view's buttons

- `discuss` (`card`: `id`, `title`, `description`): take the card into the
  room's conversation, its title into the draft.
- `invite`: the room's own invitation.
- `assign` (`card`): the room's task form, filled in from the card.
- `file.add` (`re`, `name`, `type`, `size`), then `file.chunk` (`re`,
  `offset`, `data`), one at a time: the app answers each with `file.ack`
  (`re`, `offset`). Once it holds `size` bytes it cleans, seals and uploads the
  file as the room shares any file. It says how it is going with `file.said`
  (`re`, `words`), and answers with `file`: `hash`, `key`, `name`, `type`,
  `size`, `encryptedSize` and `servers`. It may refuse at any point, in words.
  `file.cancel` (`re`) means the person stopped: nothing is uploaded.
- `file.open` (`file`, `how`: `open` or `download`): show a card's file as
  the room shows any file, fetched only when the person asks, and checked.

### Asked by the app

- `flush` (`re`): send now whatever the room lacks; the page answers
  `flushed` (`re`) when that try has finished.
- `pendingEdits?` (`re`): whether text is typed into the view and not yet
  saved; the page answers `pendingEdits` (`re`, `value`). Ask before taking
  the page away.
- `close`: the page stops reading and sending, finishes with its copy, and
  says `closed`.

## Trust

The page shows what members write. Treat every message from it as untrusted.
At worst a page could write to the board, as any member can: the app seals
nothing but board parts, never sends it a key, and checks a file reference
with the room's own reader before fetching anything. The app sets the page's
bounds itself: an origin of its own, every request intercepted, no network,
no file or content access, and a content security policy.

## The board while its screen is closed

On the web the board runs for as long as a room is open, not only while it is
on screen. It sends an edit made offline once the network is back, and hands
the board to a new epoch's stream. A page that runs only while the board is
on screen does both only then. To match the web, the app keeps the page
running, without the view, for as long as the room is open.
