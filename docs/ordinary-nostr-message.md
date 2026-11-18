# Separate ordinary Nostr messages

## People inbox design

People is the way into Nostr messaging. Keep the existing Contacts and
Following lists and add a place for conversations, with new senders under
**Message requests**. A number on People shows unread incoming DMs across the
inbox. Each conversation shows its own unread count. Open a thread to read it
and reply in place. Offer **Accept**, **Dismiss** and **Block** for requests.
Accepting or replying keeps the conversation in People without publishing a
follow or granting any KithMoot room access. Unknown senders can reach the
inbox with the user's npub when the user has set up their Nostr inbox relays.

### Nostr inbox and unread state

- Use the published, signed kind-10050 inbox list of each account. Subscribe
  to gift wraps addressed to the signed-in account on its inbox relays. Send
  the recipient's and sender's encrypted copies to their respective inbox
  relays. Provide a setup and status entry in People for the account's list,
  so the user can publish or repair it inside KithMoot. A missing list or
  failed relay check has a visible state and a recovery action.
- A public Nostr relay can still require NIP-42 AUTH to serve someone's inbox.
  Identify the account only to its explicitly authorised inbox relays, using
  the selected signer. Use a dedicated inbox connection. Keep ordinary DM
  traffic off room and node relay pools. Public relays carry encrypted
  envelopes and can see connection metadata and the outer recipient tag.
- In Nostr mode, catch up and listen for new arrivals automatically while
  the app is open. Respect the account's device preference to turn off the
  inbox. Stop it on sign-out, account change or selection of Private
  invitations mode. Use non-interactive decryption where the signer authorises
  it. If it needs attention, show a prompt to unlock or check messages in
  People. Keep sealed copies available for that action.
- Count incoming text only after verifying the gift wrap, seal, canonical
  rumor and sender/recipient bindings. Deduplicate by rumor ID across relays,
  rewraps and reconnects. The sender's own history copy, an invitation, a
  blocked sender and an invalid or expired event do not count. Persist read
  state with the account's device history. Record which messages were shown
  when a thread was read so a late message with the same or an older timestamp
  still appears unread. Cross-device read sync is a separate capability.
- Catch up over a rolling window that covers the NIP-17 timestamp jitter.
  Advance each relay's history checkpoint only after it completes the queried
  page, including timestamp ties. Keep inbox health visible when any configured
  relay or the signer prevents a complete catch-up. Bound work on unsolicited
  envelopes and leave ordinary room messaging usable throughout.

### People and profiles

- Use the verified author key from the message and the account's public kind-3
  following list to resolve kind-0 metadata in batches on public profile
  relays. Use the latest valid event by timestamp, then lowest ID on a tie.
  Retain a bounded account-scoped cache on the device. A usable cached name
  shows immediately and refreshes without moving the row under a tap or key.
- The public profile preference controls lookup and display. The inbox works
  with shortened npubs while profiles are off or unavailable. Keep public
  sender lookups out of the private invitation and room views. With a new
  sender, display text and a local avatar initial until the user chooses to
  allow their remote picture or links. A self-asserted name does not mark the
  public key as checked.

### Invite to a private KithMoot chat

Choose **Invite to KithMoot chat** from a People profile or a Nostr thread.
The inviter pairs their KithMoot node in Settings → Calls. KithMoot creates
a room on that node and signs a room record naming both Nostr accounts. It
sends that record inside an encrypted invitation to each account's published
Nostr inbox. The node handles admission and the room uses that node's relay
for chat. The inviter's keeper device can admit the named recipient when it
is online. The recipient accepts from Chats and reviews the host before
contacting it. If the node is unavailable, the room waits for that node.

### Acceptance journey

| Screen | Exercise | Expected result |
| --- | --- | --- |
| People and Message requests | With KithMoot in Chats, send two DMs from a fresh account in an independent Nostr client. Replay one on another relay and deliver the recipient's self-authored copy. | People increments by two. The new sender appears once. Reopen KithMoot and check that the badge and cached name return. |
| Thread | Open the request, reply, then send a late message from the independent client. Block a second unknown sender. | Opening clears the displayed unread messages. The reply reaches the independent client. The late message becomes unread. A block removes that sender's messages from the badge. |
| People and Following | Load a follow list and names. Supply a newer signed profile, a forged replacement and an unreachable profile relay. Toggle public profiles off. | Cached names are usable on a warm start. Only the valid replacement wins. With profiles off, the inbox and follow-independent requests remain usable by key. |
| Invite to KithMoot chat and Chats | Pair a KithMoot node, then invite a contact from People or a Nostr thread. Inspect relay traffic on both clients. Repeat with the node refusing admission or offline. | Public relay traffic contains ordinary DMs and the encrypted invitation envelope. Admission and room chat stay on the node's private relay. The recipient chooses when to join. |
| Inbox setup and connection status | Change or remove the signed list, deny relay AUTH, revoke signer approval, switch accounts, and select Private invitations mode. | Status identifies the action needed. The old account's badges, content and subscriptions retire. Room operation follows its existing route. |

Run the journey on the web, the installed desktop app and native Android on
GrapheneOS without Google Play. Verify catch-up after the app was closed on
each platform. Qualify alerting while the app is closed separately using
each platform's supported background and signer capabilities.

Protocol references are [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md),
[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md),
[NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) and
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), and
[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md).

## People inbox candidate

The inbox starts automatically for a signed-in account in Nostr mode. Open
**People → Nostr messages** to read it or turn it off on this device.
**Inbox relays** opens the signed public list editor. If no list is found,
publishing one is an explicit account action. Each new person's
conversation appears under **Message requests**. Read and reply from here or
block a sender. The People badge counts incoming messages, including arrivals
while viewing Chats. Opening a thread marks the messages it displayed as read.
Read state is per device. Use the existing public profile preference to turn
on cached signed profile names for senders and follows.

The browser and desktop builds support sending and receiving with a browser
extension or the in-memory key option. A remote NIP-46 signer can receive
messages. Sending and inbox relay authentication with a remote signer in
those builds require a Signet SDK transport that can cancel queued signing
and encryption requests. Android uses its local signer, NIP-55 with the
required approvals, or NIP-46. The inbox uses a bounded recent-history query
with a 32-day window, including two days of outer timestamp skew. Browser
history retains encrypted envelopes. Android uses the encrypted account
journal and its public profile cache.

Each People listener runs one narrow subscription per published inbox relay
with a recent history limit of 128 envelopes. The reply goes to the
recipient's published inbox relays and the account keeps a copy on its own.
Setup suggests one to three inbox relays, as recommended by
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md#relays).
Reopening the listener can reuse a recent relay list lookup. Public profile
requests in web and desktop use one batch of up to 48 authors at a time.
Relay rate-limit holds apply across the pools in each running client.
KithMoot stops retrying subscriptions when the relay reports a ban.
The Android listener for older private invitations can also query a published
inbox relay. Both listeners use the same rate-limit hold.

Loopback tests in Chromium, Firefox and the desktop renderer verified unread
counts, late arrivals, signed sender and follow names, replies and inbox relay
authentication. A phone-width Chromium viewport exercised receiving and replying
from People. Chromium also opened messages with a disposable remote signer.
Two Chromium sessions sent the encrypted invitation
over the public inbox fixture, exchanged messages through a real local
Shelter node relay, and observed no room traffic on the public relay. The
Electron shell also passed the earlier inbox receive and reply check against
the loopback relay. Android compiled and passed direct-message, remote-signer
and invitation JVM tests.

Request acceptance and dismissal for ordinary Nostr threads, paginated history
and alerts while the app is closed are open. Production relay coverage, Safari
and native acceptance on a physical GrapheneOS device are pending.

## Earlier Settings candidate

Source preparation for Vennel DG09.6 / G5. **Not compiled, tested, released or
accepted at runtime.** This candidate integrates the legacy-receive and ordinary
message feature with KithMoot main `da3ac9b4`, including desktop release
0.1.94 and the shared-rooms contact page, while retaining the earlier
compatibility integration `02e3f134`. The earlier immutable legacy source
`17023aa3` and its frozen qualification producer remain separate and unchanged;
this integration needs its own exact build/runtime qualification.

From **Settings → Account** outside a room or call, **Start public message** opens a new draft. It
does not import a room's text, link, invitation, membership or route. Enter the
other person's npub and a new message, then choose **Review public message**.
Review reads the configured account relays for both accounts' signed kind-10050
inbox lists. Missing, invalid or empty lists hold sending; no NIP-65 or default
destination substitutes for a missing inbox. The sender's list is required for
an encrypted history copy. This is a bounded observation of available relay
statements, not proof that no newer statement exists elsewhere.

The visible `○ public` chip, separate-public wording and exact destination lists
precede **Send public**. Content is encrypted; the public lane describes the
envelope's route and metadata exposure. There is no automated fallback from a
sheltered conversation. Ordinary, quiet and anonymous room routes remain separate;
this first account view is unavailable inside rooms, calls and account transitions.

Sending creates one unsigned kind-14 text rumor, without application markers or
room data, then separate kind-13 seals and random-key kind-1059 envelopes for the
recipient and sender. Both envelopes are prepared before either is published.
The exact encrypted sender copy is retained under the account history writer
lock before either envelope is published. A busy, changed or unwritable history
holds sending with an explicit message. This original copy records neither relay
acceptance nor recipient delivery. The existing SDK keeps the account key; only
ephemeral wrapper keys are local.
NIP-04 encryption and sending are never requested.

The first supported signer path is NIP-07 through the existing pinned
`signet-login@0.21.0` provider-effect boundary. Each actual encrypt/sign start and
handoff rechecks account, expiry, view and contact permission. The SDK's one
transient signing retry is separately guarded. Other signer transports need their
own qualification and remain unavailable here. Reading the SDK tag does not prove
that its published installed artifact executes equivalently. The SDK update does
not enable NIP-46 messaging in this consumer.

Publishing uses the existing guarded WebSocket carrier and exactly the reviewed
inbox destinations. A relay acknowledgement is reported as relay acceptance,
never delivery/read by the other person. Partial or uncertain results remain
visible. Only a user-selected retry can resend the identical unconfirmed envelope;
accepted halves are skipped. Nothing migrates back into the sheltered conversation.
An inbox requiring additional relay authentication can refuse this send; no new
authentication grant is silently created.

Drafts and retry envelopes are memory-only for this view. Close, leaving the
Account settings page or Settings destination, page departure,
account replacement/sign-out and room transitions invalidate pending work and
clear displayed text. Returning to Account enables fresh actions and closing a
message returns focus to its entry button. Already-started signer operations cannot be cancelled, but
late results cannot publish or repopulate the view. This is not a forensic memory
erasure guarantee or a persistent outbox/recovery implementation.

Written regression sources cover ordinary rumor contents and sender copies,
missing/newly empty/forged inbox lists, signer refusal or substitution, stale
provider starts, blocking, cancellation, bounds and exact-envelope retry. Both
asymmetric acknowledgement orders now have source cases: a retry must reuse only
the exact unconfirmed envelope and must not sign or encrypt again.

Additional source checks import the pinned SDK’s exported `Nip07Signer` class with a disposable
in-process provider: an account/view change during encryption or signing rejects
the late handoff; a transient signing retry has both a still-current positive
control and a cancellation refusal. The class import is not a replacement SDK
implementation, but these sources have not executed and establish no installed
artifact equivalence or actual extension acceptance.

The built-client browser source now includes pending encryption and seal results
across close, sign-out, home-departure entry, Account-page Back and Settings
destination departure. A new draft must survive an old result.
The exact ciphertext or seal ID must reach the browser provider completion log
before the SDK return path is checked. Sign-out, home-departure and navigation cases invoke
actual root DOM handlers programmatically while the modal is open, explicitly
bypassing pointer modal blocking. They do not replace account state or call a
private app API. Home-departure entry does not prove completed room creation. The original
post-close sign-out control is retained separately.
All cases stay in the existing registered browser spec and have not run.

`nostr-message-relays.test.ts` supplies signed inbox statements in-process, then
uses the actual message controller, `RelayConnections` and guarded carrier against
real loopback WebSockets. A delayed HTTP upgrade has a successful-send control;
close, account change and recipient block must leave both inboxes without message
writes. It checks the composed cancellation mechanism, not which of the write
guard or cancellation poll wins a race. Defaults must not be contacted and relay
challenges must not create new AUTH grants. This is not an actual app lookup/UI,
external-client receipt, raw network privacy or persistent-retry proof. Existing
shared-carrier and default-borrower tests remain separate and unchanged.

The browser cases reuse the existing synthetic NIP-07 provider and default-relay
WebSocket redirection fixture. They are **not** external-client interoperability.
The separate C04 observer source at Vennel `e72989c9` requires unchanged
Coracle's real receive/decrypt/render path, actual KithMoot sender controls and
warning, original fresh builds and a separate isolated recipient relay without
WebSocket replacement or receiver state/event/DOM injection. Its selected source
is still KithMoot `02e3f134`; its frozen producer `a62f0842` is unchanged by this
new inbox candidate. Selecting the new candidate and adding the reverse external
sender journey require explicit pin/provenance reconciliation and qualification.
Neither observer preparation nor these regression sources is runtime acceptance.

## Incoming ordinary text, replies and saved copies

**Nostr messages** in Settings → Account opens a separate account-only view.
Opening the dialog performs no storage, relay or signer operation. **Load messages**
acquires the account's existing browser writer lock, validates saved original
signed kind-1059 envelopes, and looks up the account's own signed kind-10050 list.
It reads exactly those inboxes with read-only hints and no default substitution.
No new relay-authentication grant is inferred. This view is unavailable inside
rooms, calls, private modes and account transitions; no room data enters it.

The view retains up to 128 original encrypted copies within 2 MiB, in receipt
order. Its account-scoped DeviceStore record contains the signed wrappers only,
without opened text, a decrypted sender index or a newly stored secret key.
Oldest copies may leave the bounded device cache. Unknown, corrupt, differently
scoped or concurrently changed records are refused without silently resetting
history. This is bounded local retention, not the full owned Bothy archive.

**Open message** explicitly asks the pinned NIP-07 signer to decrypt the outer
wrapper, verifies the signed kind-13 seal, checks the author against block policy,
then explicitly decrypts and validates the unsigned kind-14 text. Each SDK start
and handoff rechecks account, view, method, expiry and provider boundary. The
rumor author must match the seal author; its canonical ID and participants must
be valid for this account. The same explicit operation classifies valid encrypted application invitations
and passes them to the existing invitation journal and Chats controls. No invitation marker or room link is required for ordinary text.
Opened content uses literal text nodes: no links, media, previews or fetching.
Verified duplicate rumors share one displayed message. Expired or newly blocked
opened text is removed. Close, navigation, sign-out and account/room transitions
revoke pending work and clear the view; a late result cannot restore plaintext.
Rendering failure closes the controller and clears its writer/read lifetime.

**Reply with public message** starts the existing public composer with a blank
draft and the verified one-to-one peer. It attaches the original rumor ID in an
`e` tag only while that recipient is retained. Review, visible public-lane warning
and explicit Send public are still required. Group text can be opened; group
replies are unavailable in this candidate.

Original encrypted copies can be reopened after a new app lifetime without
waiting for a successful relay read; the account and signer are required again.
Plaintext and decrypt results are not persisted. Forget this browser removes the
local copies through its existing account-data clearing flow; this makes no claim
about relay deletion. All publication receipts remain separate from history.
The relay callback may mean timeout or close, so the UI never labels it complete.
A 30-second read deadline and bounded candidate/accepted input stop this borrowed
read, including late callbacks, while saved copies remain available.

New unit source covers actual library-generated envelopes, two-layer identity
binding, block/cancellation boundaries, duplicate rumors, corrupt/concurrent
cache refusal, no background decryption, offline fresh-controller restoration,
render-failure cleanup, silent relay timeout, input/notification bounds and expiry.
Dedicated handoff tests import the pinned SDK’s exported class with a synthetic
provider; controlled wrapper-only boundary tests are separate. The worktree has
no installed dependencies; an older root installation is not used as proof of
the pinned SDK’s API or behaviour. The registered
browser spec covers built UI literal rendering/reply, original self-copy retention
at browser send, a page reload with new WebSockets denied, and a synthetic quota
refusal with no message publication. None of these sources has run.

Actual built-pane pending-provider, account/block/Settings transitions, cross-tab
writer locking, and both cache-capacity limits still need runtime qualification.
Authenticated-inbox consent/qualification, additional supported signer/platform
paths, group replies, pagination/full owned archive, durable pending-publication
retries and actual reverse external-client receipt remain open. Current-main
build/runtime, supported-browser/Android, release, physical and outside review
gates remain open, as do all ten Vennel delivery goals and 39 packages. Production
MLS and protected member UI remain disabled.

Protocol references: [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)
and [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md). UI wording
follows Vennel's existing `docs/brand-voice-states.md` separate-public state.


## Shared explicit invitation receive

The account invitation journal no longer creates a relay transport, discovers
inbox lists or subscribes to arriving wrappers at sign-in. It retains its v1
encrypted invitations, dismissed IDs and exact pending-send envelopes. Restoring
an existing journal asks the existing signer to unwrap its self-sealed storage
key; that is distinct from opening an arriving kind-1059 message. Unknown or
invalid journals are not reset. A changed saved head refuses a later write.

**Load messages** still uses only the account's signed published inbox list.
**Check invitations on account relays**, available in Settings → Account and
the existing Contacts sheet outside rooms/calls, is a separate explicit choice.
Opening either dialog does no I/O. **Load account messages** reads configured
account read relays; it neither replaces a missing published inbox list nor
creates additional relay-authentication grants. The view labels the chosen
source. Both checks retain original encrypted copies in the same bounded cache.

Neither relay receipt nor saved-copy restoration decrypts a message. An explicit
**Open message** uses the same guarded two-layer opener for ordinary text and
invitations. A canonical, authenticated kind-14 with a valid encrypted invitation
marker is checked by the existing strict contact-invitation decoder. A malformed
marker is refused, never displayed as ordinary text. An ordinary message needs
no invitation marker, capability or room link.

Only the opener can mint an invitation token. Its private binding includes the
exact account, wrapper, canonical rumor and originating view/block/expiry guard.
Journal adoption resolves that binding when queued work starts and immediately
before persistence. A fabricated, wrong-account, cancelled or expired token
cannot create a row. Saving retains existing deduplication and dismissal rules;
there is no new signing, encryption or room-membership authority in the receiver.

The opened invitation row offers **Review invitation in Chats**. Existing saved
requests still load in Chats and retain their existing open/join/dismiss controls.
Opening a received copy does not join a room. The receive pane displays invitation
metadata only; its room link is retained inside the encrypted invitation journal.
Pending invitation sends still use their exact saved envelopes and existing
explicit retry controls. A dismissed invitation is not resurrected by reopening
another copy.

This new receive/classification implementation currently exposes only the guarded
NIP-07 path. Other signer methods cannot open newly arriving invitation copies
through this pane yet. Their existing stored invitations, journal key custody and
outgoing controls are retained; that does not establish incoming feature parity.
Additional signer paths remain required work, with their actual provider start
and handoff checks, before broader support can be claimed.

Written regression source composes the real inbox and journal with real NIP-59
crypto. It covers no arrival decrypt, two explicit decrypts per type, unopened
sender copies, malformed markers, opaque-token/account/view/block/expiry refusal,
pending inner cancellation, serial adoption behind an outbox write, changed
storage heads and old v1 journal restoration. Existing exact-envelope retry and
dismiss/restart cases remain. Registered browser source exercises ordinary-layer
invocation starts, the separate account-relay choice, existing offline invitation
join/reply controls, pending-inner close and two-tab history writer exclusion.
The provider and loopback relay remain declared synthetic fixtures.

These changes are source only. No local dependency install, typecheck, unit test,
build or browser execution has been performed. External-client C05 source still
pins the older known-conflicting candidate; selecting this fix needs an explicit
pin reconciliation and review before future qualification. Earlier frozen
qualification sources, dispatchers and allowances are unchanged. No runtime,
merge, release, physical or full-profile acceptance is inferred.
