# Erasure audit: where room keys are kept, and what forgets them

Status: done 2026-10-05. The first step of phase 2 in
`docs/2026-10-04-key-schedule-parity.md`. Read-only: nothing here changes
code. KithMoot at `26614fd`, fold-kit at 0.7.0 (`7040e22`), KithMoot Android
at `ac1186f`.

The plan says: before claiming forward secrecy, list every place an epoch
secret is persisted and confirm it is erased on schedule. The answer is that
forward secrecy is further off than "erase on schedule". Three things defeat
it today, and none of them is fixed by erasing epoch secrets:

1. **Rekey copies and authority grants are sealed from the authority's
   long-lived key.** Whoever later gets that key opens every copy ever sent.
2. **Android, and paired secondaries, have no seal keys.** Every copy they
   receive is sealed to the device key, which lives as long as the room is
   saved.
3. **The web never stores epoch secrets, but recomputes all of them** at
   every load, from the link, the device key, up to 128 seal keys and the
   rekeys it archived. Erasing a secret it never stored does nothing.

Scheduled rekeys still deliver healing (phase 1 completes) without fixing any
of this. Forward secrecy needs all three fixed, and erasure on top.

## What is kept, by client

"At rest" says how the store is protected on disk. "Cap" is how much of the
key material it holds. "Cleared by" lists what removes it.

### Web and desktop

Desktop is the same web app in an Electron profile, with the same stores and
no `safeStorage`. Its localStorage and IndexedDB are plain files in the
profile directory.

| Store | Holds | At rest | Cap | Cleared by |
|---|---|---|---|---|
| Saved rooms | The link, which is the epoch 0 secret | Plain localStorage | One per room | Forgetting the room (`clearRoomLocally`, `app/src/main.ts:13990`) |
| Room bookmarks (`app/src/room-bookmarks.ts`), for a signer account | The link, and a group's epoch 0 secret as `admission`, on relays as kind 30078 | NIP-44 to the account's own key | One per room | A tombstone. A relay may keep an older copy |
| `kithmoot.device.<room>` | The device secret key, one per room, never rotated | Plain localStorage | One | Forgetting the room |
| `kithmoot.own-seal.<room>` | Every seal secret this device minted | Plain localStorage | 128 (`MAX_OWN_SEAL_KEYS`) | Forgetting the room. Not by age or by epoch |
| `kithmoot.own-credential.<room>`, `kithmoot.credential.<room>` | Own credential; a secondary's credential | Plain localStorage | One | Forgetting the room |
| `kithmoot.room-epoch.v1.<room>` | The newest epoch's derived id and key, not its secret (`main.ts:6498`) | Plain localStorage | One, overwritten forwards | Forgetting the room |
| `kithmoot.invitation-owner.v1.*` | The authority (root inviter) secret for rooms this browser made (`main.ts:1461`) | Plain localStorage | One per room | Forgetting the room |
| `kithmoot.admission-kept.v1.*` | A group invitation's epoch 0 secret | Plain localStorage | One | Its expiry or the room |
| Room archive (`app/src/room-archive.ts`) | Every accepted room event, still room-encrypted: chat, and every rekey (1462) | AES-GCM under a non-extractable key in the same IndexedDB | 50,000 per conversation, no age limit | Only the wipe-everything path (`deleteRoomArchive`, `main.ts:1119`). Forgetting one room leaves its records |
| `kithmoot.quiet.v1.<room>` | Queued outgoing events, encrypted under the current epoch | Plain localStorage | Dropped after 24 h | Forgetting the room |

In memory, a `RoomSession` holds:
- the current epoch secret;
- `#secrets`, the newest 32 secrets (`MAX_MEMBER_EPOCH_CHAIN`), for its member desk (`src/session.ts:713`);
- `#pastEpochs`, the derived keys of the last four epochs it left, within 30 days (`MAX_PAST_EPOCHS`, `src/chat.ts:328`).

None of these are zeroed when they are dropped.

**How the web reaches the current epoch.** At every load it starts from
epoch 0, which is the link. It then replays every rekey from the relays and
from the archive (`src/session.ts:897`), opening each copy with the seal keys
and then the device key. On disk it holds no epoch secret, only the newest
epoch's reading key, but what it does hold re-derives every secret.

### Headless agent and keeper (`kithmoot-agent`)

| Store | Holds | At rest | Cap | Cleared by |
|---|---|---|---|---|
| Keeper state file (`src/keeper-state.ts`) | Room secret (epoch 0), inviter (authority) secret, current epoch and its secret, the removed | Plain JSON, mode 0600 | One epoch, overwritten at each rekey | Deleting the file |
| `<state>.link` | The link | Plain, 0600 | One | Deleting the file |
| `private.json` | Links to private conversations the agent accepted | Plain JSON, 0600 | All | Never pruned |
| Host identity file (`src/node/host.ts:294`) | A hosted agent's participant key | Plain, 0600 | One | Deleting the file |

A joined agent keeps nothing about epochs on disk. A fresh device key and a
fresh seal key come with each run, unless `deviceKeyForRoom` supplies the
device key. The den does supply it: `src/den-client.ts:60` derives it from
the den secret, and saved rooms keep only `{ room, name, link }`, encrypted
under the den's key.

The keeper overwrites its one epoch secret with an ordinary file write. On a
journalling or copy-on-write filesystem, or in a backup, the old bytes can
outlive it.

### Android (`kithmoot-android`)

All stores are AES-256-GCM under non-exportable AndroidKeyStore keys, in
`noBackupFilesDir`. Backup and device transfer are off
(`allowBackup="false"`, and data extraction rules exclude every domain).

| Store | Holds | Cap | Cleared by |
|---|---|---|---|
| Saved rooms (`kithmoot.rooms.v1`, `SavedRoom`) | Link secret (epoch 0) and the join URL; device key; participant nsec for local-signer rooms; credential; inviter secret | One per room | Forget room, reset |
| Epoch journal (`kithmoot.epoch.v1`, `EpochVault`) | Current epoch and secret; a pending successor | One, overwritten | **Nothing.** A removed or closed room keeps its last secret |
| Epoch history (`kithmoot.epoch-history.v1`) | A secret and the authority's 1462 for each past epoch | Newest 32 by count, no age limit, 4 MiB | Only removal or closure (`terminal` → `forgetHistory`, `EpochVault.kt:193`) |
| Pending chat outbox | Outgoing events under the epoch key at writing | 64 KiB | Forget room |
| `Nip77OfferArchive` | Outer events | 30 days | Age |

In memory, `EpochVault.historyCache` holds every history secret for the life
of the process. `RoomSession.pastEpochs` holds four derived keys within 30
days. None of these are zeroed.

Android mints no seal key and reads no `seal` tag. Its credential carries
`d`, `device` and `expiration` only (`protocol/.../Credential.kt:41`). It
opens rekey copies and grants with the device key alone (`Rekey.kt:180`,
`:413`).

Android does not post a "moved to epoch N" line. It shows a transient
"Secure room update complete." (`RoomViewModel.kt:4069`), which a scheduled
rekey would also trigger.

### Not holders

- **Bothy (quiet cadence).** It receives public drop keys only. The epoch key
  stays on the phone (`src/box-cadence.ts`). Bothy as a room member in its
  own right is a separate repository, not audited here.
- **The forwarder.** It holds no room key; the browser's frame worker does
  (`src/session.ts`, `forwarderMediaPipeline`).
- **History index, private-history, MLS and rendezvous vaults.** They hold DM
  and account material, not room epochs.

## By attacker

### A device copied later

Forward secrecy against this attacker needs three things: every copy the
device received is sealed to a key it can erase, the device erases those keys
and the secrets once an epoch leaves the window, and nothing local
re-derives them.

- **Web fails on re-derivation.** The link, the device key, 128 seal keys and
  the archived rekeys give the thief every epoch the device was ever in. The
  archive outlives the relays' retention, so a relay forgetting old rekeys
  does not help.
- **Android fails on sealing.** Every copy is sealed to the device key. Its
  32 kept secrets are a second, smaller problem.
- **Both have a line per device.** An epoch whose copy was sealed to the
  device key cannot be made forward secret by erasure while the device key
  lives. That covers copies from pre-0.7.0 senders, copies to secondaries,
  and copies to Android. Forward secrecy starts for a device at its first
  seal-sealed copy, and for a room only once every device in it is there.

### The authority compromised later

Rekey copies (`fold-kit/src/epoch.ts:249`) and authority grants (`:627`) are
NIP-44 between the authority's secret key and each recipient's seal key. Seal
keys are public, in credentials. So whoever later holds the authority key
opens every archived rekey and grant, and with them every epoch. That key is
in the keeper's state file or in the creator's browser (`invitation-owner`).

Healing is unaffected, because a device thief does not get the authority
key. Forward secrecy is defeated at the authority.

Member grants already avoid this: each is sealed and signed by a one-time
key (`member-epoch.ts:337`). The fix is the same for 1462 and 20469:
- seal from a one-time key and drop it after publishing;
- name its pubkey in a tag the authority's signature covers.

This is a wire change. It lands in fold-kit with vectors, and readers ship
before writers.

### Anyone holding the link

Epoch 0 is the link. Whatever the room said in epoch 0 is readable by anyone
who has or finds the link, for as long as relays keep it. That is never
forward secret, and the doc should say so wherever it claims forward secrecy.
A room's first rekey is where forward secrecy can begin.

## What this changes in the plan

**Split phase 2.**

- **2a, healing:** scheduled rekeys, the silent marker, the time-bound
  history rule, and newcomer grants carrying the window. None of this
  depends on the findings above, and it completes phase 1's healing. Ship it
  with no forward-secrecy claim.
- **2b, forward secrecy:** needs each of these, then erasure.
  1. One-time sender key for 1462 and 20469 (fold-kit, reader-first).
  2. Seal keys on Android and on paired secondaries. These were follow-ups;
     they are now prerequisites.
  3. The web keeps its window's secrets instead of re-walking from epoch 0.
     `RoomSession` already accepts `opts.epoch` (`src/session.ts:736`, which
     the keeper uses), so this is a store and its wiring. It then retires
     seal keys older than the oldest epoch in the window.
  4. The archive prunes rekeys and chat outside the window, by age as well
     as count.
  5. Android's history gets the same window (30 days, at most 16), and its
     journal forgets a removed or closed room's secret.
     Erasure also caps the grant path (the plan asked for it to be covered):
     a member desk reads secrets from `#secrets` on the web and from the
     epoch history on Android. Once those hold only the window, a member
     grant carries at most 16 epochs, not `MAX_MEMBER_EPOCH_CHAIN` (32), and
     a device further behind asks the authority. 2a leaves the 32 alone,
     since nothing is erased yet.
  6. Dropped secrets are zeroed where the language allows: `Uint8Array.fill`
     on the web and in Node, and `ByteArray.fill` on Android.

**A decision the audit raises.** The room archive exists so that "a room's
history does not depend on a relay remembering it". It keeps 50,000 events
per conversation with no age limit, and the chat log pages back past the
retention window with it. Erasing keys at 30 days makes archived chat older
than that unreadable. Either:

- the archive prunes at the window, and deep local history goes; or
- the archive starts storing something readable without epoch keys,
  re-sealed to a device archive key. That ends its "nothing decrypted is
  stored" promise, and the device thief reads that history from the archive
  instead.

Signal's answer is the second: history kept on the device is not
forward-secret against the device. Either is defensible. It is the owner's
call.

## Fix now, apart from phase 2

- **Android: forgetting a room leaves its epoch secrets.** `forgetRoom` and
  `resetSavedRooms` (`RoomViewModel.kt:2024`, `:2047`) clear the saved room
  and the outbox. They do not touch `EpochVault`: the journal with the
  current secret, and up to 32 past secrets. `RoomMembers` stays too, and
  `EpochVault` has no public forget. A person who forgets a room expects its
  keys gone. This is a privacy bug today, whatever phase 2 does.
- **Web: forgetting a room leaves its archive records.** The keys that open
  them go with the room, so only record sizes and counts stay. It is minor,
  but `clearRoomLocally` should drop the room's conversations from the
  archive.
