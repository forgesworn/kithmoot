# Changelog

What shipped, by release. Releases are cut from `main` and published as
[GitHub releases](https://github.com/forgesworn/kithmoot/releases); the
Android client has [its own releases](https://github.com/forgesworn/kithmoot-android/releases)
and is noted here when the web release depends on one. Dates are the
release dates. Wire changes are called out as such, because a second
implementation reads this file to know what moved.

## Unreleased

### Vectors

- 136 interop vectors across 21 groups, up from 101 across 15: `chatThread`,
  `chatEdit`, `chatRetract`, `chatMention`, `chatInvite` and `readPosition`,
  with a two-member policy in `joinUrl` and `accessEvaluation`.

### Positioning

- KithMoot is an open Slack with agents, and it has Jitsi-grade calls. The
  site, the README and the app's tagline now say workspace first; calls are
  a feature, listed after rooms and agents. Why the group layer is not
  NIP-29 and not Marmot is recorded in `docs/decisions.md`. This changelog
  starts here.
- The site says what shipped: threads, edits and retractions, private
  conversations, mentions on the wire and read positions that follow a
  signer, with the limits beside them. Its hero image is taken from the
  real app by `test/tools/hero-screenshot.spec.ts` rather than kept by hand.

### Added

- **The message layer, on the wire.** Six shapes, each an optional field of
  the encrypted kind-1460 chat payload, so an older client shows the text
  and nothing breaks. Wire change, with vectors for every shape and the
  Android client reading all of them. See `docs/messages.md`.
  - **Replies and threads.** `reply` and `thread` name a message by id and
    author. Replies sit under their root; a reply to a reply says which
    message it answers.
  - **Edit.** `replaces` names the original, same author. Readers show the
    latest and keep the chain, marked edited.
  - **Retract.** `retracts`, an author-signed tombstone that beats every
    edit. Cooperative, and the interface says so.
  - **Mentions.** `mentions`, participant keys and `everyone`, so what shows
    as a mention is exactly what an agent answers to. `@everyone` addresses
    the room and not the agents.
  - **Direct messages.** A DM is a room whose policy lists two `members`;
    the link travels sealed between the two participant keys as an `invite`
    inside a room both are in. Started from a person's row in Room details.
  - **Read positions.** A kind-30078 record per room, signed by the
    participant key and encrypted to it, `d` derived from the room key, so
    unread is the same on every device that holds the identity.
- **Persistent groups without a keeper.** A new room is a group by default
  and admits the next arrival with every member offline. Wire change: a v3
  invitation link (`v: 3`, bearer, pinned inviter, no traffic secret) and a
  stored kind-1463 group invitation, signed by the inviter and encrypted
  under a bearer-derived key, retired by the existing kind-1461 tombstone.
  A meeting the creator made can be kept as a group. See
  `docs/persistent-groups.md`. (#28)
- **Room bookmarks on a Nostr identity.** Sign in with a signer and the
  rooms you open are saved as kind-30078 records encrypted to your own key,
  so they follow you between browsers. Visitors keep shortcuts locally and
  are asked before any are added to the account. (#20)
- **Projects.** Rooms can be grouped into projects on the front page, and
  the agents' conversation in a room is a tab rather than a thing you had
  to know about. (#23)
- **A room a stranger can read on a phone.** The conversation is the first
  thing on the page; the roster, calls and details sit behind three
  controls; the name is at the top; the name picker stays clear of a raised
  keyboard.
- **Chat that looks like chat.** Expanded screen shares, timestamps,
  avatars, an emoji picker and encrypted reactions; search inside a
  conversation by words, person or file name; a draft kept per
  conversation. (#22)
- **Task models with caret shortcuts.** Type `^` in the composer to pick,
  from a clerk's own signed catalogue, the model it should use for that
  message. See `docs/model-shortcuts.md`. (#25)
- **Channels and directives.** A room can carry several named conversations,
  a keeper creates them, and a spoken directive in the chat reaches an agent
  without a new event kind. A donor ring on the front page, with the three
  checks that keep its number honest.
- **A paid TURN endpoint**, gated by L402, with a client that answers a 402
  and caps what it will spend.
- **One forwarder process serves several rooms**, keyed apart so they never
  share a pubkey.
- **A speaking indicator**, grouped by person, so a tile lights when either
  of somebody's devices makes a sound.
- **Verification words.** Three words spoken aloud confirm that the person
  on the other end holds the key they claim, frozen as interop vectors.
- **A reload banner** when an open PWA has an update, and recovery when the
  new worker never takes control. (#24, #30)
- **Android 0.4.0** (debug-signed preview) reads and creates v3 groups,
  with encrypted membership recovery on the device. (#29)

### Fixed

- What the first stranger test of the message layer tripped on, run on a
  phone-sized cold profile against the live site on 6 September: your own
  name in your own message lit as a mention of you; a private conversation
  was titled by the other person's key rather than their name, and said
  everybody in the room could read it; "Message privately" made a second
  room when one existed, and left you where you were; and "it is in your
  rooms" came with no way there. Now a private room is titled for the other
  person, says "Only you and them can read this", is reused when it exists,
  and the line announcing it has an "Open it" button.

- An agent host obeys its principal, not everybody who ever held the link:
  a room member can no longer start an agent from another host's catalogue
  without that host's rule allowing it.
- An agent answers to its name, not to a word its name sits inside.
- Rooms switch directly without leaving to the list. (#21)
- A room that refreshes no longer announces removals that happened
  before it opened. (#26)
- A Nostr identity is restored before a room is joined, so a bookmark
  opened from a cold start joins as the right person. (#27)
- A device says goodbye before it reloads, so the roster does not show a
  ghost for the presence window.
- The donation address was removed as a stranger's and then restored once
  it was shown to be the project's own; the ring is dark until an operator
  names a recipient.

## 0.3.0, 2026-09-03

The standing-room release: a call became a room that stays open.

### Added

- **Keepers.** A process that holds the root inviter key and admits people
  for as long as it runs, installed per room as a systemd instance by
  `deploy/keeper-deploy.sh`, with state that survives a restart on the same
  link. A primary device re-mints its credential halfway through its
  twelve-hour life; a joined page refreshes its TURN credential every forty
  minutes; the front page lists the rooms this device has been in.
- **Member removal by epoch.** Wire change: kind-1462 rekey, a successor
  secret sealed to every device that stays and none that does not, from
  which the roster, chat, channels, descriptor and media keys derive; kinds
  20468 and 20469 for a device that missed a rekey to ask for the current
  epoch. A room is closed by giving the successor to nobody.
- **Agents as members.** `kithmoot-agent` joins from the same link a person
  was sent, marked as an agent in the roster, on a channel of its own that
  every person can read, and, when a person allows it, on the end of their
  microphone with WhisperX writing a transcript channel. A principal signs
  once that an agent is theirs and every reader checks it. An agent asks the
  room for approval before it acts, and only an admin the authority signed
  for can answer. One click in the browser invites one.
- **Agents can hear me**, a switch on the sender, off by default. Off means
  this device's media is never handed to anything that says it is an agent,
  and a device keeping media from anybody never uses a forwarder.
- **Files.** Drop one on the chat and the browser seals it, uploads it to a
  Blossom server behind the app's origin and announces it; the key rides in
  the room-key ciphertext, and nothing is fetched until asked for.
- Interop vectors: 95 across 14 groups, up from 55, covering epochs, agent
  ownership, attachments and approvals.

### Fixed

- Presence is judged by when this device last heard from another, not by
  the sender's clock; a device whose media is flowing is present whatever
  the relay has carried; an entry replayed from before the presence window
  is refused.
- Two ends of a pair meet on the same rung of the route ladder; a pair that
  cannot connect rests longer each time rather than renegotiating for ever;
  a stalled audio output no longer silently stops the microphone.

## 0.2.3, 2026-08-31

- Delegated responders keep admitting arrivals but serve quietly: only the
  root creator reports link-use activity, so a replayed request from a
  lenient relay cannot overwrite a member's own admission confirmation.

## 0.2.2, 2026-08-31

- One-tap bearer links never contain the room traffic secret, and every
  admitted member can answer the next arrival, so the creator may leave.
- Creator-rooted, room-bound, depth-limited delegation with a twelve-hour
  horizon; creator-only cooperative rotation and durable retirement.
- Access enforcement across roster, chat, descriptor, signalling and assist.
- Bounded durable chat, and honest language about what a relay sees.
- One captured signal timestamp across the inner and outer gift-wrap
  layers; self-request suppression on relays that replay ephemeral events.
- Vite 8 and Vitest 4, with no npm audit findings.

## 0.2.1, 2026-08-31

- Android 0.2.1 published at the live URL.
- A one-second timestamp race between signed inner signals and their outer
  gift wraps.

## 0.2.0, 2026-08-31

- A shared invitation becomes a short-lived admission capability instead of
  the room traffic secret. Wire change: kinds 20466 and 20467 for the
  invitation request and grant, kind 1461 for retirement.
- Creator-rooted delegated responders, so an admitted member keeps the link
  alive if the creator leaves.
- Admission enforcement across roster, chat, descriptor, signalling and
  peer assist; bounded chat history, text length, sender rate and query
  horizon.
- Security boundary, stated: rotation retires the public invitation among
  cooperative clients; it cannot revoke a room key already disclosed to an
  admitted member. Relays still observe opaque identifiers, event keys,
  timing and traffic volume.

Earlier work, from the first commit to 0.2.0, is described by the README's
history and the private reviews it was verified against, not here.
