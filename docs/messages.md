# The message layer

Everything a message needs that Slack has, designed together because each
is a wire change, and the wire freezes in the next milestone. Every shape
below is an optional field inside the existing encrypted kind-1460 chat
payload, so a client that has never heard of it shows the message's text,
which the sender wrote to be readable on its own. Relays see nothing new.
This is the same discipline `docs/chat-reactions.md` set, and reactions are
the model for all of it.

The reference implementation is `src/messages.ts` (resolution),
`src/chat.ts` (the codec), `src/read-position.ts` and `src/dm.ts`. The
interop vectors are the groups `chatThread`, `chatEdit`, `chatRetract`,
`chatMention`, `chatInvite` and `readPosition` in
`vectors/kithmoot-vectors.json`, and `accessEvaluation` gains the
members cases.

## Naming a message

A message id is chosen by its sender, so an id alone is anybody's to reuse.
Every field that points at another message names it by **both** its id and
its author, the pair no third party can forge:

```json
{"messageId":"<1-128 characters>","participant":"<64 hex, the author>"}
```

`participant` is normalised to lower case. A reference to a message that is
not loaded is kept, not dropped: the reader shows what it can and fills in
when the target arrives. Reactions already name their target this way.

## Replies and threads

```json
{"reply":{"messageId":"m1","participant":"ada…"},"thread":{"messageId":"m1","participant":"ada…"}}
```

- `reply` names the message this one answers, its parent.
- `thread` names the root of the thread this one belongs to.
- A reply to a root carries both, equal. A reply deeper in a thread names
  the root in `thread` and may name the specific message in `reply`.
- `thread` absent and `reply` present means the parent is the root.
- A message carrying `thread` is shown under its root, not in the main
  stream. When the root is not loaded, the message is shown in the main
  stream marked as part of a thread, and moves under the root when it
  arrives. The archive milestone makes that rare.
- A threaded message may carry attachments and mentions. It cannot carry
  a reaction, an edit, a retraction or an invitation, which are not
  messages.
- A malformed reference is dropped and the message stays, which is what an
  older client shows anyway.

## Edit

```json
{"replaces":"m1","text":"the corrected text"}
```

- `replaces` is the id of the **original** message, never of an earlier
  edit, so every edit of one message points at the same place and no chain
  has to be walked. A reader that receives an edit naming another edit
  treats it as naming that edit's original.
- Same author: the edit's `participant` must equal the original's, or the
  edit is ignored. Same channel is implicit, since the channel is the key.
- The edit is the whole new message: its `text`, its `attachments` and its
  `mentions` replace the original's. Its placement in a thread, its kind
  and its sender are the original's; `reply`, `thread` and `kind` are
  refused on an edit.
- Latest wins: the greatest `sentAt`, then the greater id, exactly as
  reactions resolve. Readers show the latest and keep the chain, so what
  was said before can be shown on request.
- The text is required and is the new text, so an older client shows the
  correction as a new message from the same person, which is honest.

## Retract

```json
{"retracts":"m1","text":"Retracted a message"}
```

- An author-signed tombstone for the original. Same author, or ignored.
- Once retracted, always retracted: a retraction beats every edit whatever
  their times, and the original and all its edits are shown as a single
  "retracted" placeholder. Replies to a retracted root stay.
- Cooperative, like every deletion here. Every admitted device already
  holds the plaintext, relays hold the ciphertext, and nothing can make
  either forget. The interface says so.
- A retraction carries nothing else: no attachments, references, kind or
  mentions.

## Mentions

```json
{"mentions":["rowan…","everyone"]}
```

- The sender's declaration of who this message addresses: participant
  pubkeys, plus the literal `everyone`. At most 32, deduplicated,
  normalised. Invalid entries are dropped; more than the cap is refused.
- A reader marks the message as addressed to it when its participant is
  listed, or `everyone` is. An agent answers when it is listed. What shows
  as a mention is exactly what an agent answers to, because both call the
  same function, `mentionedBy` in `src/messages.ts`.
- The text still carries `@Name`, inserted by the composer when a name is
  picked, so an older client shows who was addressed.
- A message with no `mentions` field is read by name, matched as a whole
  word against the roster, which is how every message before this field
  existed was read. That fallback is legacy and goes when the wire freezes.
- `everyone` addresses the room and does not address an agent: an agent
  answers to its own key, not to a call for everybody.

## Direct messages

A direct message is not a new kind of thing. **A DM is a room**: a persistent
group whose link admits exactly two members, and the key never leaves the
pair.

**The policy.** `RoomPolicy` gains `members`, a list of participant pubkeys.
When present, a participant not listed is refused whatever the tier says,
by every reader of every room event. A DM's link is a v3 group link with
`{"tier":"open","members":["ada…","rowan…"]}`; `open` plus two members is
closed to the pair. Any room may use `members`; a DM is the room that uses
it with two.

**The invitation.** The link travels as a chat message in a room both
people are already in:

```json
{"invite":{"to":"rowan…","room":"<the DM's room id>","link":"<NIP-44 ciphertext>"},"text":"Started a private conversation"}
```

- `link` is the full join URL, encrypted with NIP-44 v2 under the
  conversation key between the sender's participant key and `to`'s. Only
  the two participant keys can open it, and the key is the same from either
  end, so the sender's own other devices open it too. A relay sees a chat
  event; the room's other members see that the sender started a private
  conversation with `to`, and nothing else.
- `to` is explicit so that only the addressee's devices try to decrypt.
  Without it every member's signer would be asked to decrypt every
  invitation in the room, which on a browser extension is a prompt each.
- `room` lets the recipient recognise an invitation it already acted on,
  and lets the sender's other devices recognise the room they should
  expect to find in their bookmarks.
- The text is a fallback for older clients, and names nobody.
- An invitation carries nothing else. It is refused with a reaction, an
  edit, a retraction, attachments, a kind or a reference.

**Who can open it.** A device that holds the participant identity: a local
key, or a signer with NIP-44 support. A paired secondary device holds a
credential and not the key, and cannot open an invitation; it joins the DM
the way it joins any room, by pairing. Signers without NIP-44 cannot send or
receive DM invitations, the same limit they have on bookmarks.

**Two at once.** If both people start a DM with each other before either
sees the other's, both clients keep the invitation with the earlier
`sentAt`, then the lower room id, and leave the other. One DM per pair.

**On screen.** A room whose policy lists two members, one of them you, is
labelled by the other member's name. The room is otherwise a room: files,
calls, agents and everything above work in it unchanged. In the web client
it is started from a person's row in Room details, and the recipient's chat
says who started one and that it is in their rooms.

## Read positions

Where a person has read to, per room and per channel, on the wire once per
participant so that unread is the same on every device that holds their
identity.

**The record** is a NIP-78 application-data event, kind 30078, signed by the
participant key, replaceable per room:

```
kind: 30078
tags: [["d", <HKDF-SHA256(roomKey, info "kithmoot/v1/read-position-id", 32 bytes) as hex>],
       ["l", "kithmoot.read.v1"]]
content: NIP-44 v2 to self of {"v":1,"room":"<room id>","read":{"":{"at":1799999999,"id":"m9"},"minutes":{"at":1799999000,"id":"m3"}}}
```

- The `d` tag is derived from the room's epoch-0 key, which every member
  holds and no relay does, so a relay cannot tie the record to a room id it
  carries. Members of the room can compute it and learn that a participant
  keeps a read position for the room; they cannot read it.
- `read` maps a channel name, `""` for the main chat, to the `sentAt` and
  id of the last message read there. `at` is what unread counts compare
  against; `id` breaks ties.
- Devices merge by taking the greater `at` per channel, and a device whose
  local position is ahead of the record it receives republishes. A record
  older than the local position is never applied backwards.
- Published by devices that hold the identity, the same set that can sync
  bookmarks. A paired secondary keeps its own position locally.
- This is the same kind and label pattern the bookmarks use, and it
  inherits their limit: a signer without NIP-44 keeps read positions in
  the browser only.

## What the vectors pin

Each shape has a positive case that reproduces exact bytes and decodes
through the real implementation, and the negative cases a reader must
refuse: the wrong author on an edit and on a retraction, a reference that
must be dropped, a mention list over the cap, an invitation with a
reaction beside it, a members policy that refuses a stranger, and a read
position under the wrong key. The Android client reads every positive case
and refuses every negative one.
