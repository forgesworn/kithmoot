# Delivery ticks: sent and delivered, no read receipts

Status: design, not implemented. Owner decision of 28 October 2026: sent and
delivered ticks; no read receipts. Signal is the simplicity reference.

## Why

A tester said they had lost confidence that KithMoot tells them whether their
messages are arriving. Today the sender sees a pending row (`Sending…`,
`app/src/pending-sends.ts`, `app/src/outbox.ts`) until the first relay
acknowledges the event. After that the message looks like every other message
and nothing says another device received it. Real loss has happened:
expired-credential sends that relays accepted and every reader refused (fixed
in c05b9d4d), and the Android receive-buffer overflow (fixed in Android
0.6.120). See `docs/message-delivery-investigation-2026-10-27.md`. Both are
cases where the sender's screen said nothing was wrong.

## Summary of the design

- **One tick, "Sent"**: a relay acknowledged the event and that relay is known
  to return chat it accepts (read-back evidence). No new wire format.
- **Two ticks, "Delivered"**: at least one other person's device decrypted and
  verified the message, proven by a delivery receipt.
- **Delivery receipt**: new regular kind **1465**. Signed by a per-event outer
  key derived from the device key (unlinkable, but deletable by the device),
  NIP-40 `expiration` seven days out, riding the chat stream's
  existing `d` tag, content NIP-44 v2 under a key derived from that stream's
  key, carrying the receiving device's signature and credential inside. One
  event per device per stream per batch, listing short hashes of the message
  ids it received. No high-water mark (see "Why not a high-water mark").
- No read receipts, no "seen", no colour change for read.

## Definitions

- **Message**: a kind 1460 chat event that decodes to a row (see "What is
  acknowledged"). Identified by its inner `id` (`ChatMessage.id`, 16 random
  bytes as hex from `ChatLog`), not the Nostr event id.
- **Stream**: one `(d, key)` pair from `deriveChannel` over an epoch root and a
  channel name (`chatStreamsOf` in `src/chat.ts`). The main chat and each named
  channel are separate streams; each epoch has its own.
- **Person**: a participant pubkey (account). Devices are grouped under the
  participant named by their verified device credential.
- **Agent**: a participant whose receipts carry `agent: true`, or who has been
  seen in the roster with `agent: true` (sticky for the session).

## One tick: "Sent"

A relay `OK` alone is not enough: `RelayPool` already detects relays that
accept and then do not return events (`#scheduleReadBack` in
`src/relay-pool.ts`, shown in relay settings as "accepted a message, then did
not return it"). That check runs once per relay per kind per session, 3 s
after a write, as a fresh `REQ` by id.

A message gets one tick when any of these holds:

1. A relay acknowledged it, and that relay's chat (kind 1460) read-back has
   passed in this session and it is not marked `unreturned` for 1460.
2. A relay acknowledged it and the read-back scheduled by that write found it.
   This covers the first message after start or reconnect, before any relay
   has passed a check.
3. This device received its own message from a relay before that relay's
   EOSE on a history subscription (a stored copy, not a live echo). This is
   how another device of the same person, or this device after a reload, shows
   one tick without a new request. Per-relay EOSE tracking in the pool's
   subscription path is needed for this (unverified that the current
   `subscribe` callback can distinguish it; if not, fall back to rule 2 for
   own messages without a tick).
4. A delivery receipt for it arrived (two ticks supersede one).

If every acknowledging relay fails the read-back (a real EOSE without the
event), the message shows **"Not kept"** with Retry. Retry republishes the same
signed event with `allRelays: true`, which a relay that already holds it
deduplicates.

No per-message read-back: rule 1 makes the common case free, and rule 2 limits
the extra `REQ` to the cases the pool already checks. One tick never meant
"readable": the expired-credential case was accepted by relays and refused by
readers. Only two ticks prove a reader accepted the message.

Not on the internet: a message offered over nearby Bluetooth on Android never
gets one tick (no relay). It can get two if a receipt comes back the same way;
that path is out of scope for the first cut.

## Two ticks: delivery receipts

### Kind choice: 1465

- **Regular (stored)**, because a sender who was offline must learn delivery
  when they return. Ephemeral 2046x kinds would be lost to an offline sender.
- **Not addressable (30078 or similar)**: replaceable events need a stable
  author per device to replace, which puts a device key on the outer event, and
  a relay would keep only the latest, losing batches. This is why the
  read-position record (`src/read-position.ts`, kind 30078, signed by the
  participant key and encrypted to self) is not reused as transport; only its
  sync shape is reused (debounce, merge, `publishedAt` replay guard, `dropped`
  handling in `app/src/read-positions.ts`).
- **1465**: the next number after KithMoot's regular block 1460 to 1464 (chat,
  invitation retirement, rekey, group invitation, call bell). Not in
  `src/kinds.ts`, `docs/protocol/kind-registration.yaml`, any `*_KIND` constant
  in `src/`, `app/src/`, `server/` or `packages/`, or the Android `origin/main`
  Kotlin sources. Not checked against the public NIP kind list at the time of
  writing (unverified); add it to `kind-registration.yaml` and `.json` beside
  1464. Note that `ASSIGNMENT_KIND` in `src/assignments.ts` reuses 1464 for an
  inner-only event; 1465 must not be reused that way.

### Outer event

```text
kind:       1465
pubkey:     a key used for this one event only, derived as below, zeroed after signing
created_at: unix seconds when the batch is signed
tags:       [["d", <stream d>], ["expiration", <created_at + 604800, or the room's end if sooner>]]
content:    NIP-44 v2 of the envelope below, under the receipt key
```

- `d` is the stream's existing chat `d` tag. A relay already groups that
  stream's chat events, so a receipt under the same `d` adds no new linkage a
  relay could not get from timing, and the receiver already knows every stream
  it reads (including left epochs), so an offline sender needs no new tag
  derivation. A daily rotating rendezvous (as the call bell uses) was
  considered and rejected for that reason; it would cost a second tag set per
  epoch for no gain against a relay that sees timing.
- Outer key: `HKDF-SHA256(device secret key, salt empty, info "kithmoot/v1/delivery-receipt-outer:<d>:<created_at>:<n>", 32)`,
  where `n` is the decimal index of the receipt within that second (0 unless
  a flush splits). Derived, not drawn, for the reason chat envelope 2 derives
  its outer key (`chatOuterSecretKey`): the device can later sign NIP-09
  deletions of its own receipts. Nobody without the device key can link two
  receipts to each other or to the device. The device keeps a per-room list of
  `(d, created_at, n)` for seven days, and leave-and-delete, tidy-up and
  self-destruct (`deleteSignedEvents` in `src/self-destruct.ts`) delete them
  with the rest of what the device wrote. A keeper-closed self-destruct room
  has no known end for `withExpiration` to cap against, which is why deletion
  matters and expiry alone is not enough. A random throwaway key (the call
  bell's choice, fine for a 120 s event) was rejected because it would leave
  up to seven days of receipts behind after a person deletes a room.
- `expiration` uses `withExpiration` from `src/expiration.ts`, so a conference
  room's end lowers it. Readers refuse a receipt without `expiration`, so no
  receipt can be made permanent.
- Receipt key: `HKDF-SHA256(stream key, salt empty, info "kithmoot/v1/delivery-receipt-key", 32)`,
  used as the NIP-44 conversation key. Separate from the chat content key so a
  receipt ciphertext can never be read as chat.

### Envelope (the NIP-44 plaintext)

```json
{"v":1,"body":"<body JSON as a string>","sig":"<128 lower-case hex>"}
```

`body` stays a string so the signature covers the sender's bytes, as in chat
envelope 2 and roster envelope 2. The device signs (BIP-340) SHA-256 of UTF-8:

```text
kithmoot/v1/delivery-receipt:<room id>:<d>:<outer pubkey>:<created_at>:<body>
```

Hex fields lower case. Binding the outer pubkey and `d` stops a member lifting
a body into another event or stream.

### Body

```json
{
  "v": 1,
  "room": "<room id, hex>",
  "participant": "<participant pubkey, hex>",
  "device": "<device pubkey, hex>",
  "credential": { "...": "the device credential, as chat carries it" },
  "proof": { "...": "optional, the admission proof chat carries in closed tiers" },
  "agent": true,
  "got": ["<16 hex>", "..."]
}
```

- `credential` is carried, not looked up, for the reason chat carries it: the
  roster is ephemeral (20 s heartbeat), and a sender who returns a day later
  cannot attribute a device through it.
- `agent` is present only as exact boolean `true` (the roster's sanitising
  rule); any other value reads as absent.
- `got`: 1 to 256 unique entries, each the first 16 hex characters of
  `SHA-256(UTF-8 "kithmoot/v1/delivery-receipt-id:" + message id)`. Hashing
  gives a fixed size whatever id format a client or agent uses
  (`validMessageId` allows up to 128 characters). A sender matches entries only
  against its own messages in that stream, so 64 bits is ample.
- Canonical writer output: keys in the order above, no whitespace. Readers do
  not depend on order (they verify the string as received).

### Reader acceptance

A reader refuses (silently, never throws) unless all hold:

1. Kind 1465; at most 4 tags, unique names, string values; exactly one
   two-value `d` equal to a stream this reader follows; exactly one canonical
   `expiration` with `created_at < expiration <= created_at + 604800 + 60`;
   event at most 16,384 UTF-8 bytes. Bounds checked before verification or
   decryption, as roster envelope 2 does.
2. Outer signature verifies (`verifyEventUncached`).
3. Decrypts under the receipt key; envelope `v` is 1; `body` parses; body `v`
   is 1; `room` equals the reader's room.
4. Inner signature verifies against `device` over the digest above.
5. `credential` binds `device` to `participant` for this room and is valid at
   `created_at` (`verifyDeviceCredential`), the same rule chat applies at
   `sentAt`. Expired-credential receipts are refused.
6. Admission: the same `evaluateAccess` check chat decode applies, with
   `proof` when present. The participant is not blocked or removed.
7. `created_at` is no more than 60 s ahead of the reader's clock and no older
   than 604,800 s.
8. `got` is well formed as above.

Every check except the stream match and access policy is pure and belongs in
the vectors.

### Why not a high-water mark

Chat has no sequence numbers. A device that has message 9 cannot know it has
message 8. A mark saying "everything up to message 9" would put two ticks on a
message a relay or a receive buffer dropped, which is exactly the class of
failure behind the tester's report. Receipts therefore name messages.

## Writer rules

### What is acknowledged

A device acknowledges a message when all of these hold:

- It decoded and accepted the message into its log (decrypted, credential and
  access checks passed). Receipt means received and decrypted, not that
  attachments were downloaded and not that anyone looked.
- The message's participant is not this device's participant. A person's own
  other devices never count as delivery.
- The message renders as a row: ordinary messages, replies, transcripts,
  directives, messages with files or artwork. Not reactions (including the
  agent `receipt: 'received'` reaction), not `replaces` edits, not `retracts`,
  not assignment-channel operations, not room logo envelopes.
- **Replay rule**: `sentAt >= joinedAt - 60` where `joinedAt` is when this
  device first joined the room (`rooms-store.ts` has `joinedAt`; Android needs
  the equivalent, unverified), and `now - sentAt <= 604800`. A new device of an
  existing person acknowledges nothing it read from history. A device that was
  away acknowledges its backlog, which is what the sender wants.
- Not already acknowledged by this device: a per-room local set of
  acknowledged message ids, entries dropped after seven days. An id enters the
  set only after a relay acknowledged the receipt carrying it, so an unsent
  receipt is retried. If the set is lost the device may re-acknowledge up to
  seven days of messages; duplicates are harmless. No rule of the form "newer
  than my last receipt", because a message recovered late (the Android replay
  fix) must still be acknowledged.

### Batching and timing

- Per device, per stream: the first unacknowledged message starts a timer of
  2 to 6 s, drawn from the CSPRNG (`randomFraction` in `src/random.ts`, see
  `docs/2026-09-10-timing-randomness.md`). When it fires, one receipt carries
  every pending id.
- After a receipt, the next one for that stream waits at least 30 s while
  messages keep arriving. A busy room costs each reading device at most two
  receipts a minute per stream, against a roster heartbeat every 20 s.
- Over 256 pending ids: split into several receipts in the same flush.
- Leaving, forgetting or tidying up a room cancels pending receipts, including
  one being signed (the `dropped` rule from `read-positions.ts`).
- Receipts go to the same relays the stream's chat is written to.

### Web and desktop

Any open room and any watched room (`roomWatches` in `app/src/main.ts`,
which decrypt for unread counts) sends receipts under the same rules. A tab
that closes with a pending batch loses it; the messages are acknowledged on
the next open because they are not yet in the acknowledged set.

### Android

The foreground room sends receipts as on the web. Background receive (the
notification path in `notifications/ChatNotifications.kt` and
`MessageNotices.kt`; exact receive path unverified) flushes one receipt per
stream at the end of the wake it is already handling, with no jitter wait and
no extra wake scheduled for receipts. The phone never subscribes to kind 1465
in the background: reading receipts happens only when a room is open.

### Agents

`RoomAgent` (`src/agent.ts`) is a member and sends receipts with
`agent: true` when it runs a driver that reads chat (a brain, an MCP or stdio
host). A keeper-only process sends none: a box that is always on would turn
every message into "Delivered" without telling the sender anything about
people. Option `deliveryReceipts?: boolean` on `RoomAgent`, default on for
joins with a driver and off for keepers.

The existing agent request-received reaction (`reactions.ts`,
`docs/agents.md`, "Request receipts and failures") is unchanged: it says an
addressed request reached the agent's connection and gates the waiting and
missing-receipt status. A sender counts it as delivery evidence for that
agent too, so older agent drivers contribute without upgrading.

### Quiet rooms

Not in the first cut. A quiet room's chat rides dead drops on a cadence
(`src/quiet.ts`, `QUIET_KINDS = [CHAT]`); a bare kind 1465 would say in the open
that a device in the room had just received something, which is what quiet
rooms exist to hide. Quiet rooms show one tick only, defined as the drop being
accepted, and never publish 1465. Later: add 1465 to `QUIET_KINDS` so a receipt
replaces a filler in the device's next slot, at no extra events and up to one
slot (300 s) of delay. Whether older quiet readers ignore an unknown rumour kind
in a drop is unverified and must be checked before that change.

## Groups: who counts

- **Known participants** of a room on this device: participants seen in the
  roster this session, authors of messages in the loaded history, and
  participants whose receipts were accepted, minus removed and blocked
  participants and minus this device's own participant. This set drives the
  agent rule below and the receipt `since` rule; it is never shown as "of N".
- Delivery is per person: a person counts as delivered when any of their
  devices sent a qualifying receipt. Devices are deduplicated by participant.
- The sender's own participant never counts.
- Agents are listed but do not light two ticks while any other non-agent
  participant is known in the room. When every other known participant is an
  agent (a person and their own agent), an agent receipt does light two ticks.
- Removed and blocked participants never count and are not listed.
- **Denominator**: only `RoomPolicy.members` is a durable member list (direct
  messages, closed groups). There the detail says "Delivered to 3 of 4" and
  lists who has not confirmed. In link rooms nobody holds the guest list, so
  there is no honest denominator; the detail says "Delivered to 3" and names
  them. Showing "of N" in open rooms from people seen recently is an owner
  decision (below).

## What an offline sender sees

- While offline, unsent messages stay in the pending row as today.
- On return, each stream's existing chat subscription gains one more filter in
  the same `REQ`: `{kinds:[1465], '#d':[the streams it reads], since}` with its
  own `limit` (1,000) so receipts never displace chat history
  (`ChatLog.#listen` uses `limit: MAX_CHAT_MESSAGES` per chat filter). `since`
  is the `sentAt` of this person's oldest message in the last seven days that
  is not yet delivered to everyone known, so a fully delivered room asks for
  nothing old.
- Delivery state is kept on the device per message: the one-tick result
  (kept or not kept) and, for two ticks, who and first confirmed time. Own
  messages replay from the local archive after a reload, not from a relay, so
  without the persisted one-tick result they would fall to "no evidence". A
  reload therefore refetches nothing. New storage keys must be registered in
  `app/src/ordinary-physical-snapshot.ts` (the classifier test fails
  otherwise).
- A message older than seven days with no receipt seen keeps one tick. The
  receipts that would prove it have expired; the UI does not guess.

## UI

Ticks sit beside the time under the sender's own messages only, in the muted
metadata colour, never a highlight colour (two ticks must not read as "read").
Outline glyphs only; there is no filled or "read" variant. The ticks are a
focusable button; changes are not announced to screen readers.

| State | Source | Glyph | Visible text (web title / Android) | Accessible label |
|---|---|---|---|---|
| holding | pending row | as today | "Sending in Ns · Undo" (unchanged) | unchanged |
| waiting | pending row | as today | "Pending: will send when you are connected." | unchanged |
| sending | pending row | clock | "Sending…" | "Sending" |
| refused | pending row | as today | "Not sent: the relays turned it down. Trying again shortly." | unchanged |
| unknown | pending row | as today | "Not confirmed: no relay answered in time. Trying again shortly." | unchanged |
| moved | pending row | as today | unchanged | unchanged |
| acknowledged, no read-back yet | message row | clock | "Sending…" | "Sending" |
| not kept | message row | warning, Retry | "Not kept: a relay accepted it but did not keep it." | "Not kept. Retry" |
| sent | message row | one tick | "Sent. Not yet confirmed on anyone else's device." | "Sent" |
| delivered | message row | two ticks | see below | see below |
| no evidence | message row | none | none | none |

"No evidence" covers own messages this device holds only locally from before
the feature, which get no tick rather than a guessed one.

Delivered labels:

- Two-person room or DM: "Delivered" / label "Delivered to <name>".
- Members-policy group: "Delivered to 3 of 4" / same label.
- Link room: "Delivered to 3" / same label.

Activating the ticks opens a popover (web) or bottom sheet (Android):

```text
Delivered to 3 of 4
<name>          14:03
<name>          14:05
<name>          14:05
Agents
<agent name>    14:02
Not confirmed yet
<name>
Delivered means their device received it. It does not mean they read it.
```

In link rooms the "Not confirmed yet" section is omitted and the footnote
adds: "People not listed may be away, or using an app that does not confirm
delivery." Times are the receipt's `created_at`, not per-message receipt
times (a batch has one time). The popover reuses the reaction-details popover
behaviour that survives chat redraws (`docs/2026-09-10-receipt-details.md`).

Android strings live together in a new `ui/DeliveryWords.kt`, in the style of
`ui/InvitationWords.kt`; `contentDescription` matches the web `aria-label`.
The pending row words in `ChatPane.kt` (`pendingStatus`) are unchanged.

## Privacy statement for the privacy page

Proposed text for `site/privacy/index.html`, in the relay section (beside the
current list of what public relays receive):

> When your device receives a message in a room, it publishes a small
> encrypted delivery confirmation so the sender can see that the message
> arrived. KithMoot does not send read receipts. Relays store each
> confirmation for up to seven days. A relay sees a one-off signing key, the
> room's existing encrypted chat tag, the time, the size and the network
> connection it arrived on; it cannot read which messages, which person or
> which device it is about. Because it arrives on the same connection your
> device uses for the room, a relay operator can still link it to your
> connection, and its timing shows that a device in the room was active.
> Members of the room can read confirmations and so can see when each
> member's device received each message. Confirmations expire after seven
> days; leaving and deleting a room also asks relays to delete yours, though
> a relay may keep copies. Quiet rooms do not send them.

Also add "delivery confirmations" to the local-storage list (delivery state
per message is kept on the device).

## Rollout and compatibility

- Old clients never request kind 1465 (their chat filters name 1460 only), so
  they never see a receipt. Relays treat 1465 as an ordinary regular event.
- A new sender with recipients on old clients honestly stays at one tick, and
  the group detail does not list them. Optional later: a roster capability
  `deliveryReceipts: true` (sanitised like `requestReceipts`) so the detail can
  say "uses an app that does not confirm delivery".
- One tick ships first: it needs no wire change and answers the tester's
  "did it go anywhere".
- Readers and writers can ship together on each platform, since old readers
  ignore the kind; writers sit behind a remote-safe flag (default on once both
  web and Android readers are released) as a kill switch.
- Web, desktop and Android implement the same format from the same vectors.
  Desktop takes it with the web build.
- `@forgesworn/fold-kit`: no change. Receipts are room transport like the call
  bell, not circle membership. They use the kit's `deriveChannel`,
  `verifyDeviceCredential` and `evaluateAccess` as chat does.

## Cost

- Relay writes: at most one receipt per receiving device per stream per 30 s
  while messages flow, zero when quiet. Each about 1 to 2 KB (the credential
  dominates), stored for seven days.
- Relay reads: one extra filter in the existing chat `REQ` per open room; no
  new subscription. Relays cap filters per request; `ChatLog.#listen` already
  folds old epochs into one filter, and the receipt filter adds one.
- Every member decrypts and verifies every receipt in rooms it has open (one
  NIP-44 decrypt, two Schnorr checks, one credential check). Watched rooms on
  the web do not subscribe to receipts; only the open room does.
- Android battery: no new wake, no background subscription, one publish per
  wake that already decrypted messages.
- History replay: no receipts for messages sent before the device joined or
  older than seven days.

## Test plan

### Unit, web

- `src/delivery-receipt.test.ts`: encode/decode round trip; every refusal in
  "Reader acceptance"; lifted body into a new outer key; wrong stream key;
  credential for another device, another room, expired at `created_at`;
  `agent` only when exactly `true`; `got` bounds; outer key derived as
  specified, differs per event and is zeroed; deletion of a device's own
  receipts on leave, tidy-up and self-destruct.
- `app/src/delivery-receipts.test.ts` (fake timers): jitter window, 30 s
  spacing, split at 256, replay rule (`joinedAt`, seven days), own participant
  excluded, row-only messages, acknowledged set written only after relay `OK`,
  late-recovered message still acknowledged, room dropped mid-sign publishes
  nothing.
- `app/src/delivery-state.test.ts`: state machine from pending through sent
  and delivered; not kept; read-back rules 1 to 3; agent-only rooms; members
  denominator; blocked and removed participants; agent request-received
  reaction counted.
- `src/chat.test.ts` or `src/session.test.ts`: the receipt filter has its own
  `limit` and does not displace chat history.
- `src/agent.test.ts`: `RoomAgent` sends receipts with a driver, none as a
  keeper.
- `src/labels.test.ts` (new `DELIVERY_RECEIPT_LABELS`) and
  `src/api-surface.snapshot.json` for new exports.

### Vectors

`vectors/delivery-receipt-v1.json`, generated by
`vectors/generate-delivery-receipt.mjs` without importing the codec (the
`roster-envelope-2` discipline), checked by
`vectors/delivery-receipt-v1.test.ts`. A separate file so Android copies it
whole rather than merging groups into its vendored `kithmoot-vectors.json`.
Cases:

- Receipt key from a stream key; outer key from a device key, `d`,
  `created_at` and `n`; message-id hash for a 32-hex id and a 128-character
  id.
- Valid receipts: root stream, later-epoch stream, named channel, with `proof`,
  with `agent: true`, conference room `expiration` lowered.
- Intermediates: body string, digest, inner signature (fixed aux rand), outer
  event id.
- Refusals: wrong kind; missing or duplicate `d`; unknown `d`; missing
  `expiration`; `expiration` too far out or not after `created_at`; too many
  tags; oversize event; bad outer signature; wrong key; envelope or body `v`
  not 1; room mismatch; inner signature over a different outer pubkey; device
  not in credential; credential for another room; credential expired at
  `created_at`; too far in the future; too old; `got` empty, over 256, with
  duplicates or malformed entries; `agent: "true"` read as absent.

### Android

- `protocol/.../protocol/DeliveryReceipt.kt` with `DeliveryReceiptTest.kt`;
  `protocol/.../vectors/DeliveryReceiptVectorsTest.kt` reading
  `protocol/src/test/resources/delivery-receipt-v1.json` (byte copy);
  `VectorCoverageTest.kt` updated.
- Writer and state tests beside `PendingChatOutboxTest.kt`; words tests in
  the style of `NearbyPendingStatusTest.kt`.
- Run `compileDebugAndroidTestKotlin` locally after signature changes.

### End to end, web (offline relay `test/ws-relay.mjs`)

New `test/delivery-ticks.spec.ts`, beside `chat-reliability.spec.ts` and
`agent-receipts.spec.ts`:

1. Two people online: sender sees one tick, then two.
2. Recipient offline: one tick; recipient returns: two ticks.
3. Sender offline when the receipt is published; sender reopens: two ticks.
4. Three-person members-policy group: "Delivered to 1 of 2", then 2 of 2.
5. Recipient adds a new device that joins later: that device publishes no
   kind 1465 for history (count events at the test relay).
6. Relay that accepts and does not return (fixture from `bad-relays.spec.ts`):
   "Not kept", Retry recovers on a good relay.
7. Room with a person and a `RoomAgent`: agent listed, no second tick until
   the person's device confirms.
8. Quiet room: no kind 1465 reaches the relay.
9. Mixed versions (the `m2-interop.spec.ts` baseline harness): new sender and
   previous-release recipient exchange chat; sender stays at one tick; the old
   client is unaffected.
10. Accessibility: tick button names match the table; popover reachable by
    keyboard and survives a redraw.

### Across web and Android

No automated cross-platform harness is known (unverified). Release
qualification adds a handset matrix, recorded in `docs/evidence/`: web to
Android with the app open, in the background, and closed then reopened;
Android to web; Android sender offline then returning; numbered messages in
both directions as in the 27 October field check, with every number reaching
two ticks or an explained one tick.

## Ordered PR list

1. **One tick (web)**: `src/relay-pool.ts` (expose which relays acknowledged an
   event and the per-relay chat read-back result; per-relay EOSE for stored
   copies), `app/src/pending-sends.ts`, new `app/src/delivery-state.ts`,
   `renderChat` in `app/src/main.ts`, styles, unit and e2e cases 1 (one tick
   part) and 6.
2. **One tick (Android)**: `session/RoomSession.kt`,
   `session/PendingChatOutbox.kt`, `ui/room/ChatPane.kt`, new
   `ui/DeliveryWords.kt`.
3. **Receipt codec and vectors (web)**: `src/kinds.ts` (`DELIVERY_RECEIPT:
   1465`), new `src/delivery-receipt.ts`, `src/index.ts`,
   `src/api-surface.snapshot.json`, `vectors/generate-delivery-receipt.mjs`,
   `vectors/delivery-receipt-v1.json`, `vectors/delivery-receipt-v1.test.ts`,
   `vectors/README.md`, `docs/protocol.md` ("Delivery receipts" section and
   kind table), `docs/protocol/kind-registration.yaml` and `.json`.
4. **Receipt codec (Android)**: `protocol/.../DeliveryReceipt.kt`, vectors copy
   and tests.
5. **Reader and writer (web and desktop)**: new `app/src/delivery-receipts.ts`
   (modelled on `read-positions.ts`), `src/chat.ts` (`ChatLog.#listen` extra
   filter and a receipt hook), `app/src/main.ts` (open room and `roomWatches`),
   `app/src/ordinary-physical-snapshot.ts` (new storage keys),
   `app/src/room-tidy-up.ts` and `src/self-destruct.ts` (delete own receipts),
   group detail popover, flag, e2e cases 1 to 5, 9 and 10.
6. **Agents**: `src/agent.ts` (`deliveryReceipts` option, keeper off),
   `bin/kithmoot-agent.mjs` flags if needed, `docs/agents.md`, e2e case 7.
7. **Reader and writer (Android)**: `session/Chat.kt`, `session/RoomSession.kt`,
   notification receive path, `ui/room/ChatPane.kt` sheet.
8. **Quiet rooms guard**: `src/quiet.ts` refuses bare 1465 (as
   `QUIET_BLOCKED_KINDS` does for 1063), e2e case 8.
9. **Privacy page and docs**: `site/privacy/index.html`, `docs/messages.md`.
10. **Later, separate decisions**: receipts inside quiet-room drops; roster
    `deliveryReceipts` capability; "of N" in link rooms.

## Owner decisions still open

1. "Delivered to 3 of N" in link rooms, where N would be people seen recently
   rather than a member list. Recommendation: no denominator there.
2. A setting to stop sending delivery confirmations. Recommendation: none, as
   Signal; delivery is the sender's information and presence already shows
   activity while a room is open. It does reveal background activity on
   Android, which presence does not.
3. Seven-day receipt lifetime. Tunable; longer helps senders away for a week,
   costs relay storage and member-visible history.
4. Quiet rooms: one tick only until receipts can ride drops.

## Unverified points

- Whether the pool's subscription callback can tell a stored copy (before
  EOSE) from a live echo per relay (one-tick rule 3).
- Android's equivalent of `joinedAt` and its background receive path.
- That 1465 is unused upstream.
- That older quiet-room readers ignore unknown rumour kinds in drops.
- That no automated web-to-Android harness exists.

## Owner decisions, 28 October 2026

- Link rooms show "Delivered to 3" with names on tap; "of N" only where the
  member list is fixed (direct messages and closed groups).
- **A setting to stop sending delivery confirmations is added**, against the
  recommendation. Off by default (confirmations are sent). A device with it
  on sends no kind 1465 events. It still shows its own messages' ticks from
  others' confirmations. Wording and placement follow the UI section; the
  privacy page names the setting.
- Confirmations expire after 7 days (NIP-40 `expiration`).
- Quiet rooms show one tick only for now.
