# Changelog

What shipped, by release. Releases are cut from `main` and published as
[GitHub releases](https://github.com/forgesworn/kithmoot/releases); the
Android client has [its own releases](https://github.com/forgesworn/kithmoot-android/releases)
and is noted here when the web release depends on one. Dates are the
release dates. Wire changes are called out as such, because a second
implementation reads this file to know what moved.

## Unreleased

### Fixed

- **A connected Nostr extension is the way in.** The door never looked
  for one: with an extension present and no account signed in on this
  browser, it showed a visitor with the typed name and a small "Already on
  Nostr?" link, which read as the app about to invent an account. An
  installed PWA has its own storage, so a sign-in done in a tab is not
  there in the app; the extension is. Now the filled button is "Join with
  your Nostr extension" and the visitor way in says so.
- **A stored extension sign-in survives the extension arriving late.** An
  extension's script lands after the app's, so a sign-in stored as
  "extension" was restored while `window.nostr` did not exist yet, read as
  the extension being gone, and the door asked for a reconnect from a
  person whose extension was right there. The restore now waits up to
  three seconds for it. And when a reconnect comes back as a different
  account, because the extension had another one selected, the app says
  so and names both, instead of quietly showing an empty room list.
- **The words, once.** Invite link, never invitation; room, never group;
  people, never participants; "with just a name", never visitor; and the
  browser is no longer mentioned on the home and door screens. Per
  `docs/glossary.md`.
- **Comings and goings.** "Rowan came in." and "Rowan left." as lines in
  the conversation, read off the roster after a settle window, so a person
  reading the chat knows when the room changed. Nothing on the wire.
- **A stranded joiner is told why.** When a temporary room's link finds
  nobody online to let you in, the door says so and names the fix (Keep
  this room open, in Room details) rather than "the room has not answered".
- **Less furniture on the home and switcher.** The switcher only mentions
  drafts when there are some; a room row no longer says it is "listening
  for who is here"; the home fold is called Settings; search boxes use
  the reading face rather than the code face.

## 0.4.1, 2026-09-09

### Added

- **A word in private with an agent.** "Message privately" on an agent's
  row in Room details, shown to the agent's owner and the room's admins.
  `kithmoot-agent join` accepts the invitation (`--dm owner`, the default,
  `anyone` or `off`) and opens the room of two beside its room with the
  same persona and a brain that answers everything said there, remembered
  under `--state` across restarts. `RoomAgent.onInvite` in the library. Nothing on the wire changed: the
  invitation is the one in `docs/messages.md`.

### Fixed

- **Profiles are found where they live.** A kind-0 profile was looked for
  on the room's relays only, so in a room on your own relay a person who
  signed in with a real Nostr account still showed as a short code. The
  lookup now also asks the public profile relays (purplepag.es and the big
  general relays), read only, and only while the profiles switch is on. A
  relay the browser refuses to open no longer takes the door down with it.
- **A screen share that ends comes off everybody's screen.** Stopping a
  share removes the sender, and no browser ends the receiver's track for
  that; it mutes it, so the last frame, or a black box, sat on every other
  tile for the rest of the call. The roster advert is now the truth: a
  picture or sound the roster no longer names is taken down within three
  seconds, and the recovery poll no longer puts it back.
- **Expand screen share is reachable.** The button appears the moment the
  roster says a screen is on, disabled until the picture lands, and one
  tap on the preview opens the viewer; it used to need a double-tap and
  went missing entirely when the picture arrived under a receiver id the
  browser minted on a rebuilt connection.
- **No more flashing video.** Every roster change, which is every
  heartbeat from every device, rebuilt every tile and detached every
  `<video>`; Chromium kept playing but dropped the compositing layer, a
  black flash on a beat. Tiles now persist and only the words around a
  picture are rebuilt.
- **Call controls stay up.** Pressing "On call" folded the microphone and
  camera away; now it only brings them into view.
- **Never your own voice.** A person on two devices was sent their own
  microphone from the other one and played it, a beat late. Audio from any
  device of your own is never played, and after Leave nothing is played
  and no pictures are shown until Join.
- **Your other device's camera in your tile.** The "me" tile only ever
  showed local media, so a phone's camera never appeared on the same
  person's desktop.
- **The call stage fills the window.** Tiles size by how many faces there
  are, a shared screen spans the row, and a phone in landscape gets two
  columns; pictures used to be 320 px boxes in a grid built for cards.
- **"connecting via TURN" was sometimes a lie.** The last rung is called
  TURN whether or not a relay credential was obtained; the chip now says
  "no relay server, still trying…" when there is none.
- **History loads in one pass.** Every replayed event repainted the whole
  conversation, thread resolution and search index included, so a busy
  room or an agent's channel took five hundred repaints to open. Now one
  repaint per burst, per conversation.

- **Marks on a screen share reach the person sharing.** Drawing on
  somebody's share was only ever painted inside the expanded viewer, so
  the sharer, who has no reason to open a viewer on their own screen,
  never saw what was being pointed at. Marks now show over every preview
  of the share, the sharer's own tile first of all, and every mark fades
  after a couple of seconds: solid for two, gone by three. Nothing on the
  wire changed; a mark was always transient signalling and never chat.

## 0.4.0, 2026-09-09

### Shape

The stranger test: somebody with a link should meet the conversation, not
the setup. No wire change.

- The door is a name, a filled Join, and "Already on Nostr? Sign in" as a
  line under it. The three paragraphs about visitors, browser keys and
  codes are gone; how you are in the room is said in Room details.
- Enter pressed before the door was ready, or while a sign-in was being
  restored, is kept and acted on. It used to be dropped.
- The code beside a name appears only when two people in view share a
  name, or there is no name. It is the start of the npub, never hex.
  Room rows and the switcher show the name alone.
- Conversation tabs appear only when there is more than Chat to show.
  Agents appears when an agent is in the room; Transcript and Minutes
  when a call has written to them. Room details still lists them all.
- Send and Start a room are filled. The identity chip has moved from the
  composer to Room details, under "You".
- Plus opens the file picker straight away. The paragraph about locked
  lumps is one sentence, and the file store and Wildbloom import are
  under "File options".
- Escape closes the call controls when nothing of yours is live.
- Project and Forget are offered once there are rooms to organise, not on
  a stranger's only room. The switcher and sidebar drop the room id.
- Room details puts Keyboard shortcuts, Nostr relays and Profile pictures
  under Settings at the bottom.
- The lane beside the composer is the chip with the sentence as its
  tooltip; the sentence no longer takes a line above every message box.
- `docs/glossary.md` fixes the words.

### Calls are a thing

**Wire change, additive.** A roster entry may carry `call: { id, since }`:
this device is on the call with that id, since that time. A call is read
off presence and has no kind of its own: it is on while any present device
says so and ends when the last one stops. `id` is 32 lower-case hex
characters chosen by whoever started it; a malformed value is dropped and
the entry kept. A client that has never heard of calls ignores the field.
Vector `rosterEvent/valid-on-call`.

- The Call button starts a call. Everybody else in the room sees "Sam
  started a call" with a Join button; joining switches nothing on. On the
  call, the button reads On call, the controls say who is on it, and Leave
  call turns your media off and takes you off it. Dropping out and
  rejoining is the same Join. Turning on a microphone, camera or screen
  share joins the call if you were not on it.
- A second device of the same person that turns its microphone on does
  not take the speaker: sound keeps playing where it was, and the call
  controls say so, with a button to move it.
- "Use beside another device" and "Let agents hear me" fold under "Two
  devices, agents" in the call controls.
- Two more voice presets, Deep and Bright: the same pitch-and-formant
  trick pushed as far as it goes while every word still lands. More
  disguise, less like a person. Still masking, not anonymity.

### Lane indicator

- Every message shows the lane it actually travelled, public, sheltered or
  direct, worked out from the relay that delivered it and never from what
  the message says about itself. The composer shows the lane the next
  message will take. Sheltered means a relay the client knows to be a box
  of the person's own circle (`RelayConfig.circle`); an onion address on its
  own is public, because the operator is unknown. `lane.ts` fixes the three
  meanings.

### Person credentials

- A device credential (kind 20460) can now be scoped to the person rather
  than one room: `d` is the participant's own pubkey, a `scope` tag says
  `person`, an optional `label` names the device, and it may not run more
  than 30 days. A room accepts one in place of a room credential only when
  it says so (`acceptPerson`); a room credential is never a person
  credential; a room credential carrying a `scope` tag is refused. Never on
  a relay, as before. See `docs/device-credential.md`.

### M2 protocol

- Add inner signalling profile/call tags and a 60-second outer expiry without
  changing the seal-less writer or recipient selectors. Readers also verify
  sealed rumours, deduplicate inner IDs across rewraps and bound work before
  decryption. Existing clients and forwarders keep their current wire shape.
- New web, Android and keeper rooms use v3 durable invitations. Existing v1/v2
  readers, links and keeper state remain supported without automatic migration.
- Publish the protocol draft, prepared kind-registration entries, a separate
  weekly upstream drift check and reserved service pass/policy codecs. No
  service enforces or publishes those reserved events in M2.
- Share 190 vectors across 26 groups with Android, including legacy/sealed
  signals, scoped service keys and canonical audience rejection cases.
- Fix an existing forwarder renegotiation defect: changing a peer's local
  publications no longer removes tracks managed by the forwarding stack.

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
- The site sells the workspace rather than describing it: the hero leads
  with agents as members and nothing to pay per seat, one action, Nostr
  sign-in as a text link, a line on who it is for, agents as the second
  card, caveats moved out of the cards, and a hero image with an agent in
  it, wearing its badge. No trade mark of anybody else's in the copy.

### Added

- **Sign in with a pasted key.** The Nostr picker's Advanced group now
  offers the dangerous option: paste an `nsec`, or a NIP-49 `ncryptsec`
  that the browser decrypts once you enter its password. The key is held
  in memory for the page only, never written to storage, and gone on
  reload. For dogfooding and for people with no signer yet; the picker
  says so. Needs `signet-login` at b2e569b or later. No wire change.
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
    the room, including agents; execution still requires sender consent.
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

- A keeper with no brain no longer enables assignments, which had it
  writing under a home directory its hardened unit keeps read-only. On the
  box that took every kept room down for two minutes on 9 September until
  the fix shipped. Assignments are enabled for an agent with a brain, or
  one handed `KITHMOOT_ASSIGNMENT_ACTIONS`. The keeper deploy now also
  ships the two workspace packages the library imports; without them
  `npm ci` on the box left dangling links and the CLI could not start.
- What the first stranger test of the message layer tripped on, run on a
  phone-sized cold profile against the live site on 6 September: your own
  name in your own message lit as a mention of you; a private conversation
  was titled by the other person's key rather than their name, and said
  everybody in the room could read it; "Message privately" made a second
  room when one existed, and left you where you were; and "it is in your
  rooms" came with no way there. Now a private room is titled for the other
  person, says "Only you and them can read this", is reused when it exists,
  and the line announcing it has an "Open it" button.
- Bounds on what a room link may carry, from a security review on 6
  September: a 16 KiB fragment, at most eight relay and eight ICE hints, a
  public relay must be `wss`, and a policy may name at most 256 keys. The app
  reads every link through the same parser. A hosted agent is handed its
  room link in the environment rather than on the command line, where every
  local user could read it with `ps`, and the CLI no longer prints a link it
  has already written to a file. The review's other proposals were declined;
  `docs/decisions.md` says which and why.

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
