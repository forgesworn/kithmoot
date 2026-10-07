# Persistent groups

The web creation form defaults to **Group: come back any time**.  A group can
be empty for days and admit a new member without a creator or keeper online.
**Temporary meeting** retains the v2 live handshake, bounded delegation and
twelve-hour local recovery.  A creator can use **Keep as a group** to publish
a group invitation with a fresh bearer for an existing conversation,
retaining its room secret, history and inviter.  Old meeting bearers cannot
decrypt the stored group invitation.  Existing v2 links keep their original semantics; share
the updated link for asynchronous joining.

## Wire format

The v3 fragment carries `v: 3`, `j` (32-byte bearer), `h` (inviter pubkey),
and the existing relay, ICE, policy and name fields.  It contains no traffic
secret.  `RoomInvitation.persistent` distinguishes it from v2.  Unknown link
versions are refused.  Existing v1/v2 links remain readable.

The creator publishes regular kind **1463**, `GROUP_INVITATION`, signed by
`h`, with one `d` tag containing the existing bearer-derived invitation id.
The encrypted JSON body is `{v:3, room, secret}`, with a base64url-no-padding
epoch-0 secret.  Its NIP-44 v2 symmetric key is HKDF-SHA256 of the bearer,
with no salt and info `kithmoot/v3/group-invitation-key`.  That domain is
separate from the live request key and room key.  The decoder verifies the
event signature, pinned author, invitation id, version, secret length and
derived room id.  No inviter or delegated signing key is given to members.

Creation waits for relay publication acknowledgement before exposing the
link.  Rejection or timeout leaves the form retryable.  A new member queries
1463 and the existing signed kind-1461 retirement together and waits for end
of stored events.  A retirement wins even when the welcome was replayed
first.  Missing or incomplete results fail rather than admitting from a
partial result.  A group join publishes no live invitation request.

This uses the regular-event and EOSE conventions in
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) and the
existing [NIP-44 v2](https://github.com/nostr-protocol/nips/blob/master/44.md)
encryption implementation.  Kind numbers remain provisional KithMoot kinds.

## Conference rooms

A group can be made to end on a date: **Ends: Never / After 1 day / After 3
days / After 7 days** on the creation form, offered only for a group (a room
that asks before anyone joins is already a meeting). The end, in Unix
seconds, rides in the 1463 body as `ends` and on the event as a NIP-40
`expiration` tag, and the decoder refuses the two disagreeing. See
[protocol.md](protocol.md#room-links-and-admission) for the wire rule.

- Every event a member's device signs for the room carries the same
  expiration (an earlier one of its own is kept), so relays that honour
  NIP-40 drop the room's traffic when it ends, not only its invitation. The
  library does this in `RoomSession` when it is given `endsAt`; the app also
  tags its file announcements and read positions, and `RoomAgent` a keeper's
  invitation, retirement and epoch desk.
- The end is kept wherever the room is: the creator's owner record (so the
  six-hourly re-sign keeps it, and stops once it has come), the kept and tab
  admissions, the rooms list and the account's bookmarks, and a keeper's
  state file (`ends`).
- At the end the room is over: a page in it leaves with "This conference
  room ended on Sat 4 Oct, 18:00.", the rooms list marks it ended with
  `markEnded`, nothing watches or rings for it, and a join link refuses with
  the same sentence. `RoomSession.join` refuses after the end as well. The
  room's header shows "Ends Sat 4 Oct, 18:00" before then, and so does the
  invite sheet.
- Expiry is a request to relays, not deletion: a relay may ignore NIP-40, and
  anybody who copied the events keeps them. A relay that honours it has no
  invitation left to hand out, so a late newcomer is told the invitation is
  not available rather than the date.

## Self-destructing rooms

A group can be made to self-destruct: when it ends, every member's device
deletes what it wrote there and forgets the room. The creation form asks
**When it ends: Self-destruct / Keep it read-only** for a room with an end,
defaulting to Self-destruct. A room with no end is made to self-destruct
from its details, with Self-destruct now. The flag rides inside the encrypted 1463
body and the encrypted closing rekey (`destruct`, fold-kit 0.9.0), never on
the outside of an event and never in the plain-JSON retirement. See
[protocol.md](protocol.md#room-links-and-admission).

- **Kept on the device.** The saved room, the kept and tab admissions, the
  creator's record and the account's bookmark carry `destruct`, so a device
  that was offline at the end acts on it the next time it starts. Once set
  it is never taken back. The room's admission is kept past its end, and its
  device key past the usual 30 days unused, until the room has been tidied
  away and its deletions sent.
- **At the end.** By the room's timer while it is open, at the next launch
  (`destructDue`), when the closing rekey says so (in the room, in a docked
  call, or in a room the list or the desktop rail is watching), or when
  another of the person's devices tombstones the bookmark, the device runs the
  tidy-up below without asking. Each room is tried once per run; a failure is
  tried again by the list's timer and at the next launch. One tab per room
  runs it (Web Locks); the others leave.
- **What the tidy-up does,** in this order: delete the link-key records when
  this device made the room; leave in every tab; NIP-09 delete this device's
  own events; ask the file server to delete the files this device shared
  (below); tombstone the account's bookmark and delete its read position;
  wipe locally (every key naming the room or its invitation, the room's
  entries inside shared records such as the relay map, its pins and
  projects, its shown notifications, and the archive streams this device can
  name: the main chat and rekeys, the main chat of every kept epoch, and the
  known channels in each); then leave a tombstone row in the rooms list, "A
  room self-destructed · Fri 9 Oct, 15:43", naming no room, until dismissed or
  seven days pass. A named channel whose name this device never learned stays
  in the archive as ciphertext nothing here opens.
- **Files.** Each file this device shared in the room is deleted from the
  Blossom server it went to, with a BUD-02 `t` delete authorisation signed by
  the room's device key, the key that signed the upload. Only that device can
  delete it, and only its own files. It knows them from a record written as
  each upload lands (`kithmoot.uploads.v1.<room>`: URL and hash, no name or
  key, wiped with the room) and, for uploads made before that record existed,
  from its own kind 1063 announcements found by the device step. Those exist
  only in a room that is not quiet, and a dated room's lapse at its end under
  NIP-40, so older files are found only in a room with no end or one tidied
  up before its end. A delete goes only to the server this device is set to
  upload to, or one its own record names, at a URL whose last segment is the
  hash. After each delete the app asks (HEAD) whether the file is still
  served, because a server answers 200 to a key that does not own the blob.
  One that cannot be reached, answers with an error, or still serves the file
  does not hold up the wipe: the delete is signed again to stay good for
  seven days and kept under `kithmoot.blob-deletes.v1`, which names no room,
  and sent again at each launch and hourly while the app is open until it
  works or the week is over. After that the server's own expiry is the
  backstop (90 days from the last fetch on the KithMoot server). Leave and
  tidy up does the same for any room.
- **Self-destruct now.** The browser holding the room's authority can make
  any room self-destruct from Room details, behind a confirmation naming the
  room. It retires the link, closes with `destruct` in the rekey, then tidies
  away its own copy. "End room for everyone" in a room flagged at creation
  self-destructs it too. Any member keeps Leave and tidy up for themselves.
- **A device that missed the close.** A device offline at the close learns of
  it from the authority's refusal (`refused: 'closed'`), which carries no
  flag. A room flagged on its invitation is covered by the stored flag. For a
  room flagged only at its closure, the app reads the stored closing rekey off
  the room's relays and decodes it with the device's current epoch key: when
  the authority refuses a joining session, when a room's door finds its link
  retired, and, through the rooms list's watch, whenever the list is open. That
  works only when the device was at most one epoch behind and a relay still
  holds the rekey (a dated room's rekey expires at the room's end under
  NIP-40). If it cannot be read, the room simply ends: nothing is wiped.
- **The countdown.** A pill in the room header, the rooms list row and the
  desktop rail row: green, then amber from the smaller of a day and a quarter
  of the room's lifetime, red from the smaller of an hour and a twentieth,
  with a live clock; a banner across the chat in the last minute, pulsing
  unless reduced motion is on. Every stage has words and a fuse icon; screen
  readers hear stage changes, not ticks. A room that keeps its read-only copy
  shows the same pill in grey, "Ends in …". The lifetime is counted from when
  this device made the room, or first knew it, so a late joiner's colours
  change a little early. One heads-up goes out at the start of red through
  the person's notification settings; a pending message that cannot leave
  before the end reads "Will not be sent: the room is self-destructing".
- **What it cannot do,** said at creation and in Room details: "Someone could
  still have kept a copy, and some relays and file servers ignore deletion
  requests." Each device can delete only what it signed, so full deletion
  needs every member's device to come back once; that goes for files too.
  Anyone who opened a file may have kept it. An older client in the room ends
  it the old way and deletes nothing. Android shares no files, so has none to
  delete; its parity for the rest is a later phase. `kithmoot-agent` enforces the same for itself; see
  [agents.md](agents.md).
- **Test builds.** `VITE_TEST_ROOM_END_SECONDS` offers an end that many
  seconds away on the creation form, for the acceptance suite; a real build
  never sets it.

## The room's own relays

The relays a group is made on are its meeting place. They ride in the 1463
body as `relays` (after `ends`; see
[protocol.md](protocol.md#room-links-and-admission) for the wire rule), and
every member's device uses them ahead of its own relays, reading and
writing, whatever that device has saved for the room or for its defaults.
Two members can therefore never end up on relays with nothing in common,
which is what left a joiner unable to see anybody's call offers.

- The creator fixes them at creation: the relays it both reads and writes,
  at most eight. Nobody changes them afterwards. The authority's **Use for
  everyone** relays op still adds more, for every member, on top of them.
- A joiner takes them from the signed invitation. Without one (a temporary
  room, or an invitation written before the field) it takes the link's
  relays, on first sight, and a later signed list replaces them.
- They are kept apart from the person's own relays
  (`kithmoot.room-relays-fixed.v1` on the web, `fixedRelays` in Android's
  saved room), are never written into a saved relay list, and are listed in
  the room's relay settings as the room's, not editable. A pool holds at
  most sixteen relays; the person's own are cut first.
- A link names the room's relays, then the op's, cut to eight, so a link
  re-shared through several people does not drift with each sharer's own
  relays, and a stale bookmark still opens on the room's relays.
- Rooms made before this converge without anybody acting: the creator's
  six-hourly re-sign adds `relays` to the invitation, and a member that holds
  no signed list reads the invitation once in the background after opening.
- An Android anonymous (Tor-only) room, and one sheltered behind a Bothy,
  keep exactly their own relays for now.

**Invite by QR**, beside **Invite** in the room, opens the same invite sheet
on the link's QR code, drawn at 480 pixels to scan from across a table. Every
member can share the link, as before.

## Persistence and limits

The app retains group membership on this device by default; Room details
offers an opt-out.  The group record has no twelve-hour expiry.  Creator
records require an explicit persistent storage marker to skip their old
expiry; changing a URL alone does not extend it.  Opening an old v2 link
after conversion cannot erase the saved group authority.  Forgetting a room removes retained admissions, including
earlier rotated links, and creator recovery for it.  The current tab's cache
is also removed by the Forget action.  Other open tabs can still hold keys
in memory.  Device passes and secondary-device pairing keep their separate
expiry rules.  Nostr bookmarks continue to carry encrypted links, not creator
private keys; an updated client can resolve the stored group invitation.

The bearer plus a saved 1463 event is durable cryptographic access to epoch
0, including its retained history.  Retirement is cooperative, not remote
deletion or cryptographic revocation.  A hostile relay can withhold a
tombstone, and a holder can retain the envelope and key.  The relay pool's
EOSE reflects reachable relays and its normal timeout policy, not proof that
every possible relay was consulted.  Relays see invitation ids, inviter
pubkeys, timings and ciphertext sizes.  They do not receive the bearer or
plaintext secret.  Stored admission depends on relay retention and
availability, just as stored chat does.

Only epoch 0 is in the envelope.  Existing session rekey verification remains
in force; a group invitation cannot recover a later epoch or override a
removal.  Browser-created groups currently do not expose member removal,
managed named channels or keeper nudges.  Those managed-room services still
use the existing keeper.  This change removes the keeper requirement for
basic group membership, chat and calls; it does not add distributed group
administration or mobile push delivery.

## A group follows its member to their other devices

A signed-in account's room bookmarks carry the room secret of each group it has
joined (`admission: { secret }`, beside `room` in the bookmark record). Without
it a second device had only the link, and opening the room meant fetching the
group invitation from the link's relays, which public relays drop within a day
or two. With it the device keeps the membership as if it had joined itself
and opens the room without that event.

- The record is encrypted to the account's own key like the rest of it; only
  the account's signer can read the secret. Group memberships only: a
  temporary admission is a delegated, expiring permission and never syncs.
- A secret is taken in only when it derives the room's own id, and never
  replaces a membership the device already keeps.
- A save from a device that holds no secret keeps the one the record carries,
  because the record is last-writer-wins and would otherwise drop it.
- Consequence for tidying up: the bookmark is replaceable and relays may keep
  older copies, so the tombstone no longer removes the secret from every relay,
  only from the record the account reads. The room itself is ended by the
  retirement notice and a closing rekey, not by the bookmark.

## Ending a room and tidying up

The browser holding a browser room's authority can end it for everyone. It
retires the link with `{v:1,ended:true}` and then publishes a closing rekey
with no recipients, the same pair a keeper's close publishes. Members leave
with a notice, a newcomer on the old link is told the room ended, and each
rooms list marks it ended. A browser whose link was replaced no longer holds
the key members follow, so it offers no end action. Removing one member from a
browser room still needs the admission design in P1.

**Leave and tidy up** asks the room's relays to delete what one person left,
in an order that keeps the keys it needs: the group invitation under the link
keys; the retirement notice only once no relay still returns the invitation,
since without it the old link would open the room again; every other tab in
the room, which must confirm it left; everything signed by the room's device
key; the account's bookmark, by tombstone; the account's read position and,
if chosen, the tombstone, named by both `e` and `a`; then this browser's
keys and caches. It reports each relay's answer and queries again. It cannot
delete other members' events, copies anybody already made, or quiet-room gift
wraps signed with throwaway keys, and an accepting relay may still keep a copy.
History imported through private recovery stays in this device's encrypted index until deleted there.

The JS library and web app read v3.  Android 0.4.0 also reads and creates v3
groups, with encrypted membership recovery on the device. Older Android builds
need updating before using these links.

## Evidence

`src/persistent-invitation.test.ts` checks stored-only agent admission,
signature/bearer validation, retirement ordering, missing EOSE and conflicts.
`app/src/invitation-store.test.ts` checks long-term recovery, temporary
expiry, opt-out and forgetting.  `test/persistent-groups.spec.ts` drives
fresh browser contexts against a real test WebSocket relay: everyone leaves,
a new member joins two days later, persisted browsers return four days
later, an old link is retired, a meeting is converted, publication fails, a
creator ends a room for everyone, and ends and tidies up in one action.
`test/self-destruct.spec.ts` watches a 90-second room self-destruct on two
devices, one of them away at the end, and checks what was asked to be deleted,
that nothing in storage names the room, the countdown's stages and the
tombstone row; it also covers Self-destruct now and a dated room that keeps
its copy. In both the end and Self-destruct now, each device's shared file is
deleted from the test Blossom server (`test/ws-relay.mjs`, which honours
BUD-02 only for the uploading key) with a valid authorisation from that key;
a Leave and tidy up with the server down keeps the deletes, names no room, and
sends them at the next launch. `app/src/blob-deletion.test.ts` and
`src/attachment.test.ts` cover the record, the retry and the delete client. `app/src/self-destruct.test.ts` checks the stage arithmetic, the
stored flag and the storage scrub.
`app/src/room-tidy-up.test.ts` checks the deletion order, `e` and `a` naming,
the kept retirement and the refusal while a tab does not answer.
Browser time is advanced for the days-later cases; this is automated evidence,
not a multi-day production observation.
