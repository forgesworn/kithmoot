# The room name

Built 2026-10-03. Any member may rename a room, and the name changes for
everybody in it. There is no private nickname beside it: the rename control
that used to change only this device's copy now renames the room for
everyone.

The reference implementation is `src/room-name.ts` (the op, the order, the
book of renames, `followRoomName`) and `src/control.ts` (the codec). The
interop vectors are the `roomName` group in `vectors/kithmoot-vectors.json`.

## Where it rides, and why not a new kind

A rename is a control message: a `name` op in the text of an ordinary chat
message on the room's `control` channel.

```json
{"op":"name","name":"Book club","id":"0123456789abcdef0123456789abcdef","at":1800000100250}
```

That puts it inside an envelope that already exists and already says
everything a rename has to:

- **Who.** The chat message is signed by the sender's device and carries the
  device credential binding it to the participant, checked by
  `decodeChatEvent` with the room's admission policy. A rename from outside
  the room, or in somebody else's name, does not decode.
- **Readable by members only, and only for their epochs.** The control
  channel derives from the current epoch's id and key
  (`deriveChannel(epochId, epochKey, "control")`), so its `d` and its key
  move at every rekey like every other channel.
- **Nothing new on the wire.** A relay sees a kind-1460 event, a `d` tag it
  cannot link to the room, a device key, a second-resolution `created_at`
  and a NIP-44 ciphertext, which is exactly what it sees of the control
  traffic every room already has (`catalogue?`, `nudge`, `relays`). The name
  is inside the plaintext, padded by NIP-44 as all chat text is, so its
  length is hidden to the padding bucket and no further.

The main chat was the other candidate, as a statement field like a reaction.
It was turned down for two reasons. The main chat holds at most 500 messages
and 30 days, so in a busy room a rename falls out of what a newcomer reads
within the day; the control channel is quiet. And carried copies (below)
would show as messages on every client that has not heard of renames; on
the control channel an older client drops an op it does not know, as
`decodeControl` returns null for one.

`docs/decisions.md` says nothing a chat message says may change membership,
roles or structure, which is why the channel list and the admin list are
signed by the authority. A name is none of those: it is a label, like a
display name, and any member may set it. That is a product decision, made
deliberately, and the reason a rename needs no signature beyond the
sender's own.

## The op

- `name`: a string of at most 32 code points (`MAX_DISPLAY_NAME_LENGTH`),
  sanitised as a display name and a link's `n` are (`sanitiseDisplayName`).
  Longer is refused rather than cut; one that sanitises to nothing is
  refused. A writer sanitises and cuts before sending, where the person can
  see it.
- `id`: 32 lower-case hex characters, chosen at random by whoever renamed.
- `at`: unix milliseconds, when the rename was made. A safe integer above 0.
- `carried`: absent, or `true` on a copy posted again by any member. Any
  other value is refused.

A reader also refuses a rename whose `floor(at / 1000)` is later than the
`sentAt` of the message carrying it, so a member cannot date a rename into
the future and pin it above every later one: the most `at` can do is what
renaming now would do.

The renamer is the carrying message's participant. A carried copy names
nobody, because the member who posted it again only repeated it, and a
reader shows "<who> renamed the room to …" only for a rename that is not
carried, once per `id`.

## Which name wins

Newest wins, in the message order of `docs/messages.md`: by `at`, then by
`id`, then by the name itself, each compared as plain values (`compareRoomNames`).
Every device holding the same renames shows the same name, whatever order
they arrived in.

The winning name replaces this device's copy of the room's name everywhere:
the title, the saved room, the rooms list, and every link the device hands
on, whose `n` is the current name. A device keeps the winning rename with
its order key (`kithmoot.room-name.v1.<roomId>` in the web client), so a
link written before a rename does not put the old name back.

## Epochs

A rename is readable only by members holding the epoch it was posted under.
A member removed at a rekey cannot read the next epoch's control channel,
so no name set after their removal reaches them.

The name survives a rekey because members carry it: a device in a new
epoch whose control log holds no copy of the current name posts the same
rename again, with `carried: true` and the original's `name`, `id` and `at`
unchanged. The copy orders exactly where the original does, so it can never
outrank a later rename made meanwhile, and a duplicate from two members is
harmless. A member admitted at a later epoch, who never held the earlier
keys, reads the name from that copy. The web client tries a few seconds
after each rekey, with a random delay so members do not all post at once.

The same rule keeps the name inside the relays' window: a device that finds
the newest copy in the current epoch older than 20 days, or none at all
while it holds a kept rename, posts it again a while after opening the room.
That is the room relays record's rule, at the same interval.

A device that missed a rekey and reads under the epoch the room left may
see renames that a removed member posted there after the rekey. Once it
catches up, a rename read under a left epoch counts only if its `at` is no
later than the rekey out of that epoch (its signed `created_at`) plus 300
seconds, the codec's clock-skew bound (`RoomNameBook.current`). What is left
is honest to say: a removed member can backdate a rename to before their
removal and so show it to devices that had not yet heard of the rekey, and
a later rename by anybody in the room beats it. It is the most they could
have done while they were a member.

## What the vectors pin

`roomName` in `vectors/kithmoot-vectors.json`, each vector carrying what it
needs to decode: a rename under epoch 0 and under epoch 1, the epoch-1 event
read with epoch 0's keys (no decode), a carried copy, a hostile name
sanitised, and the refusals (empty, over length, stamped after its message,
an upper-case id, `carried: false`, a device signing in another's name).
Three order vectors pin the tie-breaks, and `left-epoch-cut` pins the rule
for renames read under a left epoch. Timing - when a device carries the
name - is not pinned, as no timing is.
