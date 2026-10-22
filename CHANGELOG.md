# Changelog

## Desktop 0.1.98, 22 October 2026

- Looking up a contact's name and picture no longer asks the relays of the room you have open. A room's relays see lookups only for people in that room, and a name-only key this device made for you is never looked up.

## Desktop 0.1.97, 21 October 2026

- A reply sits at the bottom of the chat in time order, like any other message, with a short quote of the message it answers. Press the quote to jump back to the original, which is briefly highlighted.
- Signet sign-in uses Signet's new relay, relay.primal.net. A sign-in saved while Signet used nos.lol works again without pairing anew.
- In a narrow window, messages keep their left margin and the chat no longer slides sideways.
- Reads a newer message format in which the history kept on relays no longer shows which device wrote each message. Nothing sends it yet: this version is ready for when apps start to.

## Desktop 0.1.96, 21 October 2026

- Opening an invite link takes one press: the room, "What should we call you?" and Join. Microphone and camera stay off, and Hide my IP address on calls sits folded at the bottom. When this device used a Nostr account before, the button is "Continue as {name}", with "Join with just a name instead" underneath.
- Starting a room puts you straight in it. New room asks your name only when the app does not know it yet.
- A room you have joined opens again from its link, with no name to type, as long as it is the same person on this device. Leaving a room makes its link an invitation again.
- Nostr keys no longer show in rooms, Room info, Chats or invitations. Somebody with no name is "Somebody"; a short key appears only when two people share a name.
- Inviting someone to a room shows your rooms with a choice each, says who is already there and who was invited, then Send invite.
- Hide my IP address on calls is now a switch in Settings › Privacy.
- A room can be muted for 1 hour, 8 hours, 1 day or 1 week from its Notifications menu. A muted room, or one set to Nothing, shows a bell with a line through it and leaves the Chats count and the dock badge. Calls in it still show the banner when the room is open, without the ring sound.
- A new notification choice, Only mentions and replies.
- On macOS the grey title bar gives way to a slim strip in a slightly different shade, with the window buttons in it: drag the window from there. The window remembers its size and position on every system.
- Decline and block for invitations, Block on a contact's page, and Settings › Privacy › Blocked on this device. Blocks stay on this device and the sender is never told.
- Settings › Account can send and reply to ordinary encrypted Nostr messages with people on other Nostr apps, signed in with a browser extension. Incoming messages wait until you choose to open them. Older NIP-04 messages can be read, one at a time, and are never sent.
- The file panel no longer suggests a ForgeSworn file server; it lists servers run by other people and your own.
- New default relays: relay.primal.net, nostr.oxtr.dev and relay.ditto.pub, replacing nos.lol and nostr.mom, which stopped answering.

## Desktop 0.1.95, 20 October 2026

- A call has one row of buttons, each with its word under it: Mute, Camera, Share, Chat, More and Leave, with Full screen on a wider window. Leave is the only red one. More is a short menu: Effects, Layout, Record call, Run as a meeting, Use beside another device, Mirror my view, Let agents hear me and Invite people, each only when it applies.
- When somebody starts a call in the room you have open, a banner says "Priya is calling" with Decline and Answer. Answer joins with your microphone on and your camera off. The ring stops after a minute, and opening a room where a call has been going for a while does not ring.
- The first time you unmute in a call with an agent in the room, the call asks whether agents may hear you. They still hear nothing unless you say so.
- On a call while you read another room, the call is one line with its clock, "On a call in Release workshop · 12:03", with Mute, Return and Leave.
- The call shows names, never Nostr keys; somebody with no name is "Somebody". Two people with the same name still get a short key to tell them apart.
- The divider between a call and its chat no longer covers a finished recording's buttons.
- A contact's page in People lists the rooms you share with them and the rooms you invited them to, with "Sent, not joined yet" or "Joined" and the day it went. It is worked out from rooms already on this device, so the page asks no relay anything.
- Check words together on a contact's page opens your private chat with them and the same word check a room member's row offers. Under it: when you checked, "Checked in Signet", a warning when a different key was checked under the same name, or "Not checked yet". A check made there also marks the person in People's list.

## Desktop 0.1.94, 20 October 2026

- Room info replaces the long Room details sheet. It opens from the room's name or ⋯, as a panel beside the conversation on a wide window and full screen on a phone, and fits in about one screen: the room and who can join, Call, Invite and Search, the members with agents marked, then Conversations, Invite link, Privacy and connection, Name and picture, your phone, how you appear and your contact cards, each as a page inside the panel.
- Leave room asks first, naming the room. A tick box, "Also ask relays and the file server to delete what I left", replaces the separate Leave and tidy up button.
- Settings is its own place, opened from the rail or with Cmd or Ctrl+comma, with pages for Account, Profile, Notifications, Messages, Display, Privacy, Connections, Keyboard shortcuts, and About and help. Text size, notification and profile settings, keyboard shortcuts and Forget this browser no longer appear inside a room.

## Desktop 0.1.93, 20 October 2026

- A room's header is its name, Start call, Search and ⋯, and nothing else sits above the first message. The agents strip and the Search, Invite and Invite by QR buttons are gone.
- ⋯ opens a short menu: Room info, Invite people, Add an agent, Notifications (Every message, Nothing, or your default), New task, Pin, Add to project and Leave room, with End room for everyone for whoever started the room. Cmd or Ctrl+I opens Room info. A private chat leaves out the invite, agent and project items.
- Tabs appear only when there is more than the chat: Agents when an agent is here, Board when the room has tasks or a board. A room's first task or board starts from ⋯, New task.
- A room with nobody else in it shows "Nobody else is here yet." with Copy invite link and Show QR code.
- A chat's menu in the list adds Mark as read and Notifications.
- The desktop app's menus carry the app's own items: New room, Open an invite link, Join with a code and Settings under File; Chats, People, Boards, Find a chat or room, Room info and Text size under View; and a Room menu with the same items as ⋯, greyed out when no room is open. Right-clicking a message opens the app's menu of message actions.

## Desktop 0.1.92, 20 October 2026

- One way around the app. A rail on the left holds Chats, People and Boards, with Settings at its foot. In the web app on a phone it becomes a bar along the bottom.
- One chats list replaces the start page, the rooms sidebar and the room switcher. It has a search box (Cmd or Ctrl+K), chips for All, Unread, Mentions and each project, Pinned at the top, and Older and Ended folded away at the foot. It stays beside an open room, with its previews and counts kept up to date.
- New room, Open an invite link, Join with a code and New project sit in one New menu at the top of the list.
- People, when signed in with Nostr: your contacts and the people you follow, each with Message, Voice, Video and Invite. The follow list is your own, read only while public profiles are switched on.
- Invitations to a private chat wait at the top of Chats with Accept and Decline. Someone you do not follow is shown by a short key and never looked up.
- A private chat is named after the person, with "Private chat" under the name.
- Keyboard: skip links come first, Cmd or Ctrl+1, 2 and 3 move between Chats, People and Boards, and the chats list is one stop walked with the arrow keys. Right-click, the Menu key or Shift+F10 open a chat's menu.
- "Hide chat" no longer wraps onto two lines in the room bar.

## Desktop 0.1.91, 19 October 2026

- On Windows and Linux the desktop app no longer downloads spelling dictionaries from Google. Electron's built-in spellchecker fetched one from a Google server at start-up; it is now switched off on those systems, so there are no spelling underlines or suggestions there until dictionaries can ship inside the app. The Mac app keeps the macOS spellchecker, which downloads nothing.

## Desktop 0.1.90 and Android 0.6.93, 19 October 2026

- A calmer room on desktop, web and Android. One palette and type scale on the logo colours, shared by all three apps. Buttons, panels and bubbles lose their borders. Messages from one person within five minutes sit together under one name. The time and the lane sit inside the bubble, the lane as a lock whose name says which lane it is, and "Agent" is an outlined label that reads without colour.
- The room bar's Back, Call, Boards and More are icon buttons, each with a tooltip on hover and on keyboard focus.
- The message box is one row on one centre line at every width and text size: Add, then the field with Emoji inside it, then Send. GIFs and stickers are tabs in the emoji picker.
- Adding a reaction no longer hides the newest message, and reactions sit under the bubble instead of over it. A picture that finishes loading under the newest message keeps you at the bottom.
- With forced colours on, selected tabs, the conversation's focus ring, the Agent label and button edges stay visible.
- Android: the room's back arrow is labelled Back to chats, since it always kept the room, and stronger outlines and muted text follow the phone's high contrast text setting. Room invitations sent from the web client now open on Android.

## Desktop 0.1.89 and Android 0.6.92 — 19 October 2026

- The 0.1.87 quiet automatic replies are rolled back while broken calls are investigated, since calls broke the day they shipped. Call signals, room link answers and room key answers go out straight away again, read positions go to your other devices as before rather than in random batches, and a removed member is refused every time.
- Android uses WebRTC's own echo canceller and noise suppressor instead of the phone's, so people on a call no longer hear themselves back as reverb from a phone on loudspeaker.
- Meeting codes with a password now share as one link that just joins: kithmoot.app/c/ABC-DEF-GH followed by # and the four words, such as #ability-zoo-jasmine-forget. The join page opens the invitation door without asking for the words, then removes them from the address bar. The words sit after the #, which no server is sent, so the code service still holds only the locked copy and the redirect never sees them. Copy and Share send only that link, with no separate password line.
- A new switch, Send the password separately, is off by default. On, the link leaves the words out and they are shown to send on their own, as before. Reading the bare code out loud, the words are under the code. A wrong, missing or damaged set of words in a link falls back to the usual prompt, and typing a code in still asks for them.
- The desktop app opens a code link with its words. It accepts a fragment only if it is exactly four words from the list, and still refuses any other fragment, query, host or path. Android does not yet join by code.

## Desktop 0.1.88 and Android 0.6.91 — 18 October 2026

- Add an original full-picture masked avatar, remembered before capture starts. Prepare face-mask compositing and a separate MIT neural vision training library. Automatic face masking remains unavailable pending qualified weights.
- Remove MediaPipe camera effects and bundled Google background weights. Until the owned model is ready, blur covers the whole picture and a backdrop replaces the whole picture; person cut-outs and automatic framing are unavailable in this branch.

## Desktop 0.1.87 and Android 0.6.90 — 18 October 2026

- Meeting codes: the creator of a room they can end can get a short code such as ABC-DEF-GH and a link kithmoot.app/c/ABC-DEF-GH, optionally with a password of four words. Join with code is on the home screen, and the desktop app opens code links. Without a password the code service can read the invitation it holds; with one it holds only an encrypted copy. Android does not yet join by code.
- Automatic replies no longer give away when a device is in use. A repeated call signal is answered after a short random wait, at most once every two seconds per device, and stale ones the same way.
- With Ask me before anyone joins switched off, one device answers a room link after a short pause, instead of every device at once.
- A new setting, Share where I have read up to with my other devices, is on by default. When on, read positions go out in random batches rather than seconds after each message.
- A room's key desk answers after a short random wait, and refuses a removed member once an hour rather than every time. In a room closing with more than 20 people, some late arrivals see the room stop answering rather than a "closed" notice.

## Desktop 0.1.86 and Android 0.6.89 — 16 October 2026

- A call's answer is matched to the offer it answers, so a late answer can no longer settle a newer camera change and leave video stuck.
- Android keeps relay read and write choices made while signed out across a restart.

## Desktop 0.1.85 and Android 0.6.88 — 15 October 2026

- A Signet sign-in stays signed in across restarts. Signet answers on its own relay after pairing, so every sign-in link now names it and an existing sign-in is also asked there; nobody has to pair again.
- A signer that was asleep when KithMoot opened is asked again after five seconds rather than thirty.
- Clicking a KithMoot invitation opens it in the desktop app, which now handles `kithmoot://` links on macOS, Windows and Linux. A live call is asked about first.
- The web join page offers Open in the KithMoot app on computers as well as Android, for the invitation it was opened with.
- Android opens tapped join links on kithmoot.forgesworn.dev and kithmoot.app straight in the app, and holds a call tile's picture through a missed heartbeat.
- The Use your phone sign-in link carries three relays rather than one.
- While a call is docked the conversation keeps its height, and the chat drawer control is named for what it does.
- Also carries the startup and private-storage groundwork merged since 0.1.84 (#427, #429, #434).

## Desktop 0.1.84 and Android 0.6.87 — 15 October 2026

- Relay settings say whether each relay answered a read, refused it or wants authentication. A relay's own fault or a dropped connection is not shown as a refusal.
- A refused write gives its reason, such as rate limiting or authentication, rather than the relay's own words.
- A refusal stays on show while other reads or writes on the same relay succeed.
- Android can move relays up or down in Settings, notices a relay that accepts a message and then does not return it, and keeps reading older keeper requests from relays that serve short pages.

## Desktop 0.1.82 — 14 October 2026

- Show relay activity and let you move relays up or down, keeping the chosen order after reopening.
- Explain when Signet approved an identity without connecting a signer, and show explicit sign-in errors.
- Preserve the fix clearing an old reconnect error after successful sign-in.
- The reported persistent Signet waiting issue and Android black video flashes remain unresolved.

## Unreleased

- **"Use your phone" sign-in survives an unreachable relay.** The sign-in link now names up to three of the site's relays instead of only the first, so a phone that cannot reach nos.lol can still answer on another (signet-login 0.19.1; needs a My Signet build with multi-relay sign-in).
- **Fresh sign-in clears a failed reconnect warning.** Approving a new My Signet QR for the same account now replaces the old "Your signer did not answer" message with "Signed in."

- **Screen-share popouts belong to their call.** Multiple share windows keep the original room, project and sharer while you read another conversation. Each can show, hide and resize that sharer's live camera. Drawing still reaches the original call; leaving or stopping a share clears its video rather than retaining a frozen picture. Closing a viewer leaves the call and other viewers running. This covers the web and desktop viewer; the persistent gallery and native Android equivalent remain separate work.

- **Donkey GIFs, for desktop 0.1.66 and Android 0.6.75.** Three original orange Donkey performances—laughing, facepalm and Bitcoin—join the Blender coffee animation. The built-in collection now has 27 stickers and four animated GIFs. They send as encrypted references to bundled artwork, without image uploads or file-storage consent; personal files keep their encrypted upload flow.

- **Familiar original emoji and a shared artwork picker, for desktop 0.1.65 and Android 0.6.74.** ForgeMoji by TheCryptoDonkey covers 133 meanings with 124 Unicode emoji and symbols plus nine ForgeSworn brand shortcodes, using 163 PNGs including five human skin tones for six hand gestures. Emoji, Stickers and GIFs share one picker. Composer emoji choices preserve the draft and allow repeated insertion; reaction choices close the picker. Phone browsing starts without opening the keyboard, and search is explicit. Media previews stage built-in artwork only when Add is chosen; Send remains separate. Built-in stickers and GIFs travel as encrypted references to bundled artwork, without uploading an image or asking for file-storage consent. Your own files retain the encrypted upload flow and storage consent.
- **One acted coffee GIF replaces the flat GIF catalogue.** The local collection now offers 24 original stickers and one six-second coffee animation modelled and performed in Blender. Browsing, search and previews contact no third-party graphics catalogue. Existing received GIFs and people’s own files remain supported.

- **A keeper can turn its room's key over on a schedule, off by default.**
  `kithmoot-agent create --rekey-every <days>` (`KITHMOOT_REKEY_EVERY`,
  `RoomAgent.create({ rekeyEverySeconds })`) rekeys once the room has been
  at one epoch for the period plus up to six hours of jitter, and somebody
  other than the keeper has spoken since (`src/rekey-schedule.ts`,
  `RoomAgent.rekeyIfDue`). The rekey removes nobody and is marked
  `scheduled` (`RoomSession.rekey({ scheduled: true })`), and is sealed to
  every device seen within 30 days as well as the roster, cut to 64 KiB.
  Keeper state gains `epochAt`, `past` and `devices`, still version 2, and
  read leniently. `--state` now takes `<state>.lock`, so two keepers cannot
  share one state file. Phase 2a, step 6.
- **A member can bring a device up to date while the room's authority is
  offline.** Bump `@forgesworn/fold-kit` to 0.5.0 (member epoch catch-up).
  A device that missed a rekey now asks the room's current members as well
  as the authority (kind 20471), and any member in step answers (kind
  20472, signed by a one-time key) with the missed secrets and the
  authority's own rekeys, which the device checks before it moves. A
  removed participant or a closed room is answered by nobody. New rekeys
  carry the epoch commitment (`commit: true`) that lets a member vouch for
  the newest epoch; a room whose newest rekey predates this needs one more
  rekey from its authority before members can hand it on. `RoomSession`
  runs both sides (`memberEpochDesk`, `memberEpochJitterMs`), keeps each
  epoch's secret and rekey in memory for the chain, and reports
  `awaitingEpoch` / `onEpochWaiting` while it is behind and nobody has
  answered; it keeps asking. `join()` throws `EpochUnreachableError` when
  nobody answers in time. The app shows "This room has moved to a new key.
  Waiting for a member to bring this device up to date." and retries, both
  in the room and on the way in, and no longer treats a kept or group
  admission's structural epoch 0 as a sign the room is at 0. Vectors:
  `vectors/member-epoch-vectors.json`, copied from the kit.
- **Conference rooms.** A group room can be made to end: "Ends: Never /
  After 1 day / 3 days / 7 days" on the creation form, for a group only. Wire
  change, additive: the kind 1463 body gains `ends` (Unix seconds; `v` stays
  3) and the event a matching NIP-40 `expiration` tag, which a reader
  requires to agree with the body. Every event a member signs for the room
  then carries the same expiration (an earlier one of its own is kept), so
  relays that honour NIP-40 drop the room when it ends; `RoomSession` and
  `RoomAgent` take `endsAt`, and `withExpiration` is exported. At the end
  the room shows ended, nobody joins, and a join link says "This conference
  room ended on <date>." The header and invite sheet show the end date.
  See "Conference rooms" in `docs/persistent-groups.md` and
  `docs/protocol.md`.
- **Invite by QR**, beside Invite in the room, opens the invite sheet on a
  large QR code of the link.
- Bump `@forgesworn/fold-kit` to 0.3.0, which carries the 1463 `ends` codec
  and the expiration rule.
- **The app, desktop and Android icons move to the new vortex.** `npm run
  brand:build` now renders from `art/brand/2026-09-29`: the gradient mark on
  white for the PWA and touch icons, the small flat mark for favicons and
  anything 32 px or under, and a rounded tile on the macOS icon grid for the
  Mac, Windows and Linux builds (`desktop/icons/`, and a regenerated
  `KithMoot.ico`). The Android launcher becomes the vortex on white, inset to
  the adaptive safe zone, with a monochrome mark for themed icons.
- **The website moves to kithmoot.app, with the new identity.** The vortex
  mark and wordmark from `art/brand/2026-09-29`, the brand palette and Inter,
  self-hosted. The homepage is shorter and plainer: a screenshot of the real
  app, eight features in a sentence or two each, three steps, and a download
  card per platform with a direct installer link; the downloads, terms,
  privacy and report pages share the new header and footer. The old host's
  pages redirect to kithmoot.app; the app stays at
  `kithmoot.forgesworn.dev/j` for now, and kithmoot.app/j redirects to it.
  `npm run brand:site` renders the site's icons and social card from the
  vector masters, and the site test now fails if the homepage offers an
  installer the downloads page does not.
- Bump `@forgesworn/fold-kit` to 0.2.0: `createDeviceCredential` now refuses
  a person-scope credential a restamping signer pushed over the 30-day cap,
  throwing the new, re-exported `RestampedCredentialExpiryError` at mint
  time instead of minting a credential refused everywhere it is presented
  (#205).
- **Call bell, kind 1464.** Wire change, additive: the first device on a
  call publishes one `start` bell and the last one off publishes one `end`,
  so a phone with the app closed can wait for a call on an idle socket
  instead of decrypting every presence heartbeat. Signed by a throwaway key,
  tagged only with a daily tag derived from the epoch key and a NIP-40
  `expiration` two minutes out; the ringing device and its signature are
  inside the ciphertext. Nine new `callBell` vectors. See "Call bell" in
  `docs/protocol.md`.
- The default relays are now three third-party public relays: `nostr.mom`
  replaces the project's own relay as the third. Existing room links keep
  the relays they name. See `docs/decisions.md`.
- **An epoch request proves admission.** Wire change, additive: the kind
  20468 body keeps `v: 1` and gains a required `admission` field, an HMAC
  under a key derived from the epoch-0 room key over the room, the
  authority, the device and the event's `created_at`. A keeper's epoch desk
  refuses a request without it, so a stranger who reads a room id and its
  authority off a public rekey event can no longer be handed an open room's
  current key. A responder from before this release ignores the field; a
  client from before it cannot catch up after a removal through a new desk
  until it updates. Five new `epochRequestAdmission` vectors. See
  `docs/decisions.md`.
- The Remove dialogue says that somebody who keeps the invite link can come
  back under a new name, and that replacing the link is the answer.
- README, deploy README and the forwarder's own header no longer say media
  through a forwarder is readable: browser media through a forwarder has
  been sealed end to end since 15 September (`e68a79f`), and a browser
  without `RTCRtpScriptTransform` never promotes to a forwarder.

## 0.5.4 — 9 September 2026

- Use the approved sculptural assembly artwork for web/PWA icons, workspace
  branding, the marketing hero and social previews. Keep the artwork beside the
  headline and primary action on phones, with a smaller WebP download.
- Record the browser and home messaging goals and their acceptance criteria.


What shipped, by release. Releases are cut from `main` and published as
[GitHub releases](https://github.com/forgesworn/kithmoot/releases); the
Android client has [its own releases](https://github.com/forgesworn/kithmoot-android/releases)
and is noted here when the web release depends on one. Dates are the
release dates. Wire changes are called out as such, because a second
implementation reads this file to know what moved.

## 0.5.3, 2026-09-09

### Fixed

- **The start form fits a small phone again.** The "who can come in" radios inherited the card's field-label spacing, which on Linux fonts pushed the Start button below the fold at 390 by 540. They sit on one short row now.
- **The start form begins as written.** Firefox restored the last "Ask me first" choice across a reload, so the next room quietly asked too.
- **A refused publish says who refused and why.** The pool's error carries each relay's own reason, so a room pinned to a box's drop tier alone reads `blocked: this tier holds kind 1059 only` rather than that every relay rejected it.
- **Acceptance suite.** The knock and private-room specs reach the test relay over the page's origin, which WebKit requires, and skip the camera grant Firefox does not have.

## 0.5.2, 2026-09-09

### Added

- **Contact cards are kind 21641.** Wire change. A card is a signed event in the ephemeral range with one `expiration` tag, so a relay that meets one by mistake does not store it; the addressable 30641 with its `d` tag is gone (`nostr-contact-card` 0.4.0). A card made by 0.5.1 does not read here, and the other way round; the Android client moves in step.
- Relay settings: any relay can be marked as a box of your circle by hand, for a box's drop tier fronted as `wss://` and named to you by its keeper. A message that goes only to circle relays shows as sheltered; a card's box is marked for you and cannot be unmarked there.
- The box's drop tier is fronted at `wss://kithmoot.forgesworn.dev/drops`: kind 1059 gift wraps accepted from anyone into a bounded tier and served by broadcast, the mailbox quiet mode's dead drops need. A quiet room still needs a plain relay beside it for its roster.

## 0.5.0, 2026-09-09

### Added

- **Quiet rooms.** Wire change. A policy may carry `quiet: true` beside
  `members`; such a room never publishes a bare kind 1460. Its chat rides
  inside kind 1059 room drops as `nostr-deaddrop` defines them: each to a
  key derived from the epoch key, the member's participant pubkey and a
  counter, one wrap every five minutes per device with fillers between,
  read back from the gift-wrap stream over two days. A reader that does
  not know `quiet` rejects the link. The web client starts one with
  "Message quietly" on a person's row, keeps the counters it has spent
  and the messages still waiting for a slot on the device, and gives the
  device holding the identity and the device it paired disjoint halves
  of the member's keys; a third device reads. `kithmoot-agent` joins a
  quiet room from its link and posts in drops. See `docs/decisions.md`
  and `docs/protocol.md`. Android does not read quiet rooms yet.

- **Contact cards.** A contact book on this device, read from
  `nostr-contact-card` cards: paste one in Room details, or open one as a
  link at the door and press to keep it. The person's row shows "card",
  the box on the card is one of the circle's relays (the lane says
  sheltered when every relay a message goes to is one), its node id and
  the highest address serial are pinned per box, and every box says
  whether it is dialled on the card's endorsement or a refreshed address.
  "Show my card" makes this person's own card, with no box and a
  rendezvous key made here, for handing over; a card is a signed event
  of the reserved kind 30641, so an extension or a bunker makes one too. The circle mark on a relay
  is never saved as a preference. No wire change: nothing about a card is
  published.

- **A room where people ask to come in.** At the start form, "People with
  the link ask, and somebody here lets them in". Somebody opening the link
  waits on the door while the person in the room sees "Rowan wants to
  join" with Let in and Decline; the switch is in Room details, on the
  device that answers the link. There is no refusal on the wire: a
  declined person sees that nobody let them in and is told somebody has
  to accept them. **Wire, additive:** the admission request body (kind
  20466, `v: 1`) gains optional `name` and `participant`; readers that do
  not know them ignore them, and the Android client already does.

- **Invite somebody to a room you are in.** On a person's row in Room
  details, "Invite to a room" seals one of your rooms' links to them in
  the conversation you share, the way a private conversation starts. They
  find the room in their rooms, named as it names itself. A room that
  asks first lets somebody you invited straight in, without the card:
  that pair is a private room, a link nobody is handed and people you
  chose. Nothing new on the wire; it is the sealed invite from
  `docs/messages.md` carrying a room link that is not a two-person one.

- **A page that sends the browser back to the Android app.** Sign in with
  Signet from the Android client goes to mysignet.app as a nostrconnect
  invitation, and Signet will only send a browser back to an https address;
  `/signet/` is that address, and all it does is open the app again with
  the outcome. It holds nothing and is not indexed.

### Fixed

- **Your own name beside your account again.** Since 0.4.1 a profile was
  looked for on the public profile relays as well as the room's, and the
  two lists named nos.lol and relay.primal.net under different spellings,
  one with a trailing slash. The relay pool refuses a list that holds a
  relay twice, the lookup treated that as a relay it could not open, and
  no profile was ever asked for: a person signed in with their Nostr
  extension saw a bare npub where their name and picture had been, and
  read it as being signed in as somebody else. The lists are now merged
  by the relay, not the spelling. And the short code beside a name now
  shows both ends of the npub, `npub1mgvlrnf5…u0e7q2`, because the end is
  what a person checks against the key in their signer.

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
