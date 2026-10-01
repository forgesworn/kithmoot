# A joined group follows its member to other devices (1 October 2026)

How a private chat that would not open on a second device led to room secrets
syncing through the account's room bookmarks. Companion to
`persistent-groups.md`, which holds the standing description.

## What went wrong

"Private: Morgs" opened on the owner's Pixel but not in the desktop app on the
M4. The desktop listed the room (the list syncs through the account) and then
showed "The invite link could not be loaded".

Two separate faults were in play:

1. **The signer was unreachable.** The first symptom was an empty room list
   ("4 rooms saved to it are not shown until you reconnect your bunker") with
   `nip46-connect-timeout` in the console. The relays the bunker names all
   accepted connections; a ping from a separate client using the same saved
   credentials also timed out. Restarting the signer fixed this and the four
   rooms came back.
2. **The invitation event was gone from the relays.** With the signer back,
   Morgs still would not open. This was the real fault.

## Cause

The Morgs link is a persistent (v3) invitation. Opening it from a device that
has not joined means fetching a signed kind 1463 event from the relays the link
names (`nos.lol`, `relay.primal.net`) and decrypting the room secret from it.
Neither relay, nor `relay.trotters.cc`, returned the event. `relay.damus.io`
did not answer. Neither client had ever republished it: both publish it once, at
creation or rotation.

Relay retention was measured, not assumed. Asking for kind 1463 events older
than a given age:

| Relay | Oldest kind 1463 events returned |
|-------|----------------------------------|
| `nos.lol` | under three days |
| `relay.primal.net` | under one day |

So a "persistent" link lasts only as long as the weakest relay keeps one event.

The Pixel worked because it joined while the event still existed and then kept
the room secret on the device. The Pixel's own "Share invite link" handed out
the same saved URL byte for byte, publishing nothing, so it was dead for anyone
else too.

The device that made the link (the owner's M1, away from the owner this week)
is the only one holding the inviter key, so it was the only machine that could
sign the invitation again.

## First attempt: republish the invitation

The device that made a persistent link now signs and publishes its invitation
again when the room opens and every six hours while it stays open. Android
0.6.26 and the web client carry it.

Challenged on whether that was right for a private chat, it was scoped back. A
link kept alive indefinitely turns a chance expiry into a standing way in, and
the periodic publish shows on public relays that the creator is online. A link
limited to named members (`policy.members` non-empty) is now left to lapse
(Android 0.6.27, web `d3ce821`). That left Morgs, a two-member conversation,
outside the republish, which is why a different fix was needed.

## The fix: sync the membership

The room list synced only a link, a name and a room id. A device that had never
joined had to be admitted again, which needed the missing event. A kept
membership (`kithmoot.admission-kept.v1.*`) is local to the device that joined.

A bookmark record may now carry `admission: { secret }` beside `room`. It is
encrypted to the account's own key with the rest of the record.

- **Shape.** A sibling of `room`, not inside it: both clients rebuild `room`
  from a whitelist and would drop anything placed in it. The `l` tag stays
  `kithmoot.rooms.v1`, so a client that has not updated still reads the list.
- **Read.** The secret is accepted only when it derives the room's own id, then
  stored as a kept membership if the device has none. A bookmark without it, or
  with a wrong one, still lists the room.
- **Write.** Persistent group memberships only; a temporary delegated admission
  is an expiring permission and never syncs. The record is last-writer-wins, so
  a save from a device with no secret keeps the one the record already carries.
- **Epoch.** A kept persistent membership is always epoch 0; later epochs
  recover from the secret, so none is stored.

Web: `app/src/room-bookmarks.ts` and `groupAdmissions()` in `app/src/main.ts`
(`bfeacaa`). Android: `account/RoomBookmarks.kt` and `RoomViewModel`
(`a3a37e0`, `43c3c64`). Five new tests on the web, four on Android.

### A bug found only by testing it live

The first Android build did nothing. The upload step was placed in
`refreshRoomBookmarks()`, which runs only when relay settings change, and not in
`startRoomBookmarks()`, which runs at sign-in. The relays showed no new bookmark
from the Pixel after launch, and the M4's cached records carried no secret. It
also compared the saved link to the bookmarked link, which can differ for the
same room; that check was dropped, and the upload now keeps the bookmark's own
link, name and time and adds only the secret. Fixed in Android 0.6.28.

## Result

After the Pixel (0.6.28) uploaded, the M4's desktop app adopted two secrets
(Morgs and Tally), opened Morgs and showed its history from 21 September with
the composer. The unit tests alone would not have caught the placement bug.

## What this costs

- The secret now sits on public relays inside the bookmark. Only the account's
  signer can decrypt it, but a relay may keep an older copy of a replaceable
  record, so deleting a bookmark removes the secret only from the record the
  account reads. This changes the guarantee in "Ending a room and tidying up".
- It applies to every persistent group the account has joined, not only private
  ones.
- A leaked or expired link still cannot be revived by this: it brings the room
  to the account's own devices, not to new people. A new person needs a fresh
  invitation from a device that can sign one.

## Released

- Web: live from release `20261001T050945Z`.
- Android: 0.6.28 (code 51), APK SHA-256
  `53e058d43a361397d182eefa1a5b2007d9d15d1d312aea549651d376a8051526`,
  owner-signed on the M4, passed `verify:android-publication`, live on the
  website and installed in place over 0.6.27 on the Pixel 10 Pro XL.
- Desktop: rebuilt and installed on the M4 as 0.1.30 with the new code. **No
  public desktop release carries it.** The published 0.1.30 and any other Mac
  still need a desktop 0.1.31.

## Still to do

- Cut desktop 0.1.31 so other Macs read synced secrets.
- ~~Android writes the secret but does not yet read one that only another device
  holds.~~ Android reads it too (`af29da4`), when the room is opened rather than
  when the bookmark loads: saving an account room needs a signature.
- Decide whether syncing should be opt-in per room.
- Create the GitHub pre-release for Android `v0.6.28`.
- The inviter key for Morgs lives on the M1; the old link stays dead for anyone
  who is not on the account.

## Later the same day: a link whose relays had lost it

Morgs, who is not on the account, could not open The Moot: its invitation was
gone from the relays the link names. He got in by adding a relay by hand,
because a copy was still on another relay. The door now does that itself
(`ddceb1c`): when the link's relays lack the invitation it asks this device's
relays and the app's defaults, never for a link naming a circle relay, and the
creator re-signs it on the relays its link names as well as the room's current
ones. See `app/src/invitation-lookup.ts`.

