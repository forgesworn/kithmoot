# Phase 2a ("healing"): implementation plan

Status: written 2026-10-05 against kithmoot `0824ea7`, fold-kit 0.7.0
(`7040e22`) and kithmoot-android 0.6.57 (`0b035c9`). Line numbers refer to
those revisions. Step 1 shipped as fold-kit 0.8.0 and step 2 as kithmoot's
readers; the owner chose option (a) for the first finding below on
5 October. Part of the key schedule parity plan
(`docs/2026-10-04-key-schedule-parity.md`).

2a makes no forward-secrecy claim and erases nothing. `MAX_MEMBER_EPOCH_CHAIN`
stays at 32.

Three things in the code contradict the plan or change its shape, so they come
first.

## Three things to settle before building

### 1. Weekly rekeys silence any room nobody has opened since the last rekey

This has to be solved before the keeper starts rekeying.

- The web rooms list reads a room under a stored epoch key and cannot follow a
  rekey (`app/src/main.ts:6596-6597`: "A watch cannot follow a rekey by
  itself; opening the room does").
- Android background delivery and the call listener also read under the
  stored epoch (`service/BackgroundDelivery.kt:80-83`,
  `service/BackgroundCallListenerService.kt:297-311`). Nothing outside the
  open `RoomSession` subscribes to kind 1462.
- Call bells ride under the epoch key (`src/call-bell.ts:23-24`, `:90`).
- So a week after a rekey, a room the person hasn't opened loses its unread
  marks on the web list, and on Android it loses notifications and
  incoming-call rings. That breaks the rollout rule that nobody's room goes
  quiet.
- The cause: a rekey seals copies only to devices in the roster at that moment
  (`src/session.ts:1706-1712`). An offline device gets no copy, so a watch has
  nothing it can open.

Options:

- **(a)** A scheduled rekey also seals to every device whose credential the
  keeper has seen within the history window. Each watch and Android background
  listener then subscribes to 1462 under its stored epoch and opens its own
  copy. The web watch uses `kithmoot.device.<room>` and
  `kithmoot.own-seal.<room>`; Android uses the `SavedRoom` device key.
- **(b)** Watches catch up through the desk. That needs a live credential, so
  a signer, so it can't happen silently.
- **(c)** Accept the silence and document it.

**Decided 2026-10-05: (a).** It was recommended, and the owner approved its
cost:

- If a device is stolen and the real device then stays offline, the newest
  credential the keeper holds for it is the copied one. The thief then gets
  scheduled rekeys for the length of the bound (30 days is about 4 rekeys).
  Today they get nothing once that credential expires (12 h).
- (a) also makes rekeys bigger. Each recipient costs about 370 bytes, so a
  64 KiB rekey fits about 170 devices. Beyond that, fall back to online
  devices plus the most recently seen.
- The session already keeps the newest credential per device whether or not
  the device is online (`#newestCredentials`, `session.ts:840-856`), but only
  in memory, so the keeper must persist it (step 6).

### 2. "The authority is … the creator's client" is contradicted

2a's cadence runs on the keeper only.

- The authority desk (`hostRoomEpoch`) is started only at `src/agent.ts:661`,
  for the keeper.
- The browser rekeys only to close a room (`main.ts:13737`,
  `endRoomForEveryone`) and runs no authority desk. Removal in a browser room
  is a request to the keeper (`sendHostControl`, `main.ts:7615`).
- Android never builds a 1462: `encodeRekeyEvent` (`Rekey.kt:128`) is called
  only from tests. Android answers 20468 as authority for rooms it created
  (`EpochRecoveryResponder`, `RoomViewModel.kt:3299-3309`), but those rooms
  never leave epoch 0.
- Bothy is not an epoch authority (box and cadence peer only).
- If a browser rekeyed on a schedule, every member who was offline, and every
  newcomer, would wait for some other member to come online (member desks
  only). Browser rooms today never leave epoch 0, so that failure cannot
  happen now.
- So the healing claim holds for keeper rooms only. The parity doc's cadence
  bullet (`docs/2026-10-04-key-schedule-parity.md:136-141`) needs correcting.
- Racing: only the authority can rekey; `peekRekeyEvent` (fold-kit
  `epoch.ts:309`) checks the signer, and Android checks the same
  (`Rekey.kt:118-126`). The only possible race is two keeper processes on one
  state file, covered in step 6.

### 3. The web rebuilds every epoch from epoch 0 on each load

Weekly rekeys will break that for busy devices after about five weeks.

- A device keeps at most 128 seal keys (`MAX_OWN_SEAL_KEYS`,
  `app/src/device-store.ts:158`). It mints one per credential renewal, every
  6 hours while open (`session.ts:447`, `:466`), so a device that stays open
  drops them after about 32 days.
- After that, the replay stops at the first old rekey copy (`#drainRekeys`,
  `session.ts:1341`; a copy no key opens reads as no secret and returns
  "ask"). Every load then needs a desk round trip, with "This room has moved
  to a new key. Waiting…" (`EPOCH_WAITING_NOTICE`, `main.ts:6841`) on screen.
- Latent today because rekeys are rare; certain under a weekly cadence.
- Fix: bring forward 2b's item 3 (the web keeping its window's secrets) now.
  Store the newest epoch secret, the window's secrets, `removed` and `members`
  beside `kithmoot.room-epoch.v1` (`main.ts:6599-6620`), and pass them to
  `RoomSession` as `opts.epoch` plus a new `opts.pastEpochs`.
- It adds no new exposure: localStorage already holds the link, the device key
  and the seal keys, which re-derive every epoch.
- Cheaper fallback if you'd rather not: hide the waiting notice during the
  first few seconds of a join. It does nothing about the latency.
- Android is unaffected: its `EpochVault` journal starts from the stored epoch.

## The quiet marker

**A body field rather than a tag (as built in fold-kit 0.8.0): `"scheduled": true` in the
encrypted `RekeyBody`, alongside `closed` (fold-kit `epoch.ts:165-183`).**

- **Signature:** the content is part of what the event id hashes (NIP-01), so
  the field is signed. fold-kit `verifyEventUncached` and Android
  `Events.verify` (`NostrEvent.kt:121-123`) both recompute the id.
- **Old readers:**
  - fold-kit 0.7.0 `decodeRekeyEvent` (`epoch.ts:338-376`) and
    `readRekeyEvidence` (`member-epoch.ts:141-160`) build their result from
    named fields only, so they ignore it.
  - Android's rekey body parsing reads `v`, `epoch`, `removed`, `keys` and
    optionally `closed`, `by`, `commit`, `members`, and ignores anything else.
  - An old client just shows its usual line: the web posts "The room moved to
    epoch N.", and Android shows "Secure room update complete.".
- **Why not a tag:** a clear tag would tell the relay that nobody was removed.
- **If you want a tag anyway:** use `["reason","scheduled"]`. It is also
  signed and also ignored by old readers: `peekRekeyEvent` (`epoch.ts:310-311`)
  looks only for `d` and `epoch`, and Android reads tags through `tagValue`
  (`NostrEvent.kt:35`), which returns the first tag of a name.
- **Rule for both:**
  - The encoder throws if `scheduled` is combined with a non-empty `removed`
    or with `closed`.
  - The decoder reports `scheduled: true` only when `removed` is empty and the
    rekey doesn't close the room. An event that contradicts itself still gets
    announced.

## Steps, in ship order

### Step 1: fold-kit 0.8.0 (readers and wire)

Files: `src/epoch.ts`, `src/member-epoch.ts`, `src/index.ts`.

- **Rekey marker:**
  - `EncodeRekeyOptions.scheduled?: boolean` (`epoch.ts:185`), written into
    the body.
  - `RekeyNotice.scheduled?: true` (`:276`), set in `decodeRekeyEvent`
    (`:346-354`).
  - `RekeyEvidence.scheduled` in `readRekeyEvidence`.
  - A rekey without the flag stays byte-identical to 0.7.0's.
- **History window helper:** add `HISTORY_WINDOW_SECONDS = 30 * 86400`,
  `MAX_HISTORY_EPOCHS = 16`, and a pure
  `epochsInWindow(left: {epoch, leftAt}[], now)`. It keeps epochs left within
  30 days, newest first, capped at 16. Android ports it from the same vectors.
- **Authority grant (20469) carries the window:**
  - `EpochGrantBody.passed?: {epoch, secret, left}[]` (`:568`).
  - `EncodeEpochGrantOptions.passed?`, validated: each entry below the granted
    epoch, no duplicates, sorted, at most 16, 32-byte secrets.
  - `decodeEpochGrant` (`:662-689`) fills the existing `EpochGrant.passed`
    (`:652`). Malformed entries drop the field, not the grant.
  - Widen the element type to `RoomEpoch & { leftAt?: number }`. Also set
    `leftAt` in `decodeMemberEpochGrant` from the chain's rekey `created_at`s,
    for consistency.
- **Newcomers:** a 20468 request doesn't say which epoch the device holds
  (`EpochRequestBody`, `:436-443`), so the desk can't tell a newcomer from a
  returning device. Every authority grant therefore carries the window. That
  is owner decision 3 as stated, and it also rescues the returning web devices
  in finding 3.
- **Desk:** `HostRoomEpochOptions.past?: () => readonly {epoch, secret,
  leftAt}[]` (`:691`), passed into `encodeEpochGrant` at `:837-848`.
- **Housekeeping:**
  - `scripts/diff-source.mjs`: a new `SCHEDULE_CHANGES` block applied before
    `SEAL_CHANGES`. Phase 1 commit `6b502a5` is the pattern.
  - New `EXTRACTION.md` section.
  - `CHANGELOG.md` 0.8.0 entry.
  - New `docs/scheduled-rekey.md`, plus README and `llms.txt`.
  - `package.json` `files` gains the new vector file, and a
    `generate-schedule` script.
- **Vectors:** `scripts/generate-schedule.mjs` (modelled on
  `generate-seal.mjs`) writes `vectors/schedule-vectors.json`, one group
  `schedule`, checked by `vectors/verify-schedule.test.ts`.
  - `scheduled-rekey`: empty `removed`, members carried, `commit` present,
    marker present, chain unbroken (read through `readRekeyEvidence` from the
    previous epoch).
  - `scheduled-rekey-contradictory`: marker plus a removal reads as not
    scheduled.
  - `epoch-grant-window`: 20469 carrying `passed`, with 16 as the cap and 17
    refused.
  - `epoch-grant-window-old-reader`: the same grant through 0.7.0 logic gives
    the current epoch only.
  - `history-window`: `epochsInWindow` cases at the 30-day edge and the 16
    cap.
- **Tests:** `epoch.test.ts` (marker round trip, encoder refusals),
  `member-epoch.test.ts` (`leftAt` from the chain), and a `hostRoomEpoch` test
  that `past()` reaches the grant.

### Step 2: kithmoot readers (bump the pin to 0.8.0)

- **Shims:** `src/epoch.ts` and `src/index.ts` re-export the new symbols.
  Update `src/api-surface.snapshot.json`. Copy in
  `vectors/schedule-vectors.json` with `verify-schedule.test.ts`, and add a row
  to `vectors/README.md`.
- **Web notice:** at `app/src/main.ts:6871` (`onEpochChange`) add
  `|| notice.scheduled` to the early return. Everything above that line still
  runs (lock state, `rememberRoomEpoch`, carrying the room name). The line it
  silences is at `:6874-6877`.
- **History rule:**
  - `MAX_PAST_EPOCHS = MAX_HISTORY_EPOCHS` (16) at `src/chat.ts:328`, and
    update the comment's reason.
  - `#keepPast` (`chat.ts:874-889`) already applies the 30-day time bound
    (`CHAT_RETENTION_SECONDS`, `chat.ts:40`).
  - `session.ts:1625-1629`'s `.slice(-MAX_PAST_EPOCHS)` has no time bound;
    that's fine because ChatLog applies it, but note it in a comment.
- **Filter budget:** `#listen` (`chat.ts:807-815`) opens one filter per epoch.
  The cap of 4 existed because relays limit filters per request. Keep separate
  filters for the current epoch and the 4 most recently left, and fold any
  older ones into one filter with several `#d` values, so at most 6 filters. A
  weekly cadence keeps only about 5 epochs inside 30 days anyway; removals are
  what push the count up. Update `chat.test.ts:350-383`.
- **Session:**
  - `#moveToEpoch(…, passed)` (`session.ts:1614`) uses each passed epoch's
    own `leftAt` when present, instead of `notice.at` for all of them.
    `ChatLog.rekey`'s `crossed` (`chat.ts:856`) accepts `{root, leftAt}`.
  - `#catchUp` already hands `grant.passed` over (`session.ts:1449`).
  - Add `RoomSessionOptions.pastEpochs?: {epoch, secret, leftAt}[]`
    (beside `epoch`, `session.ts:298-304`), which fills `#secrets` and
    `#pastEpochs` in the constructor (`:735-737`).
  - Add a `pastSecrets()` accessor, filtered by `epochsInWindow`, using
    `rekeyedAt(e+1)` (`:1172`) for `leftAt`.
- **Web epoch store (finding 3):** a v2 record holding the epoch, its secret,
  the window secrets, `removed` and `members`. Fed to `RoomSession` on open.
  `forgetLocally` and `clearRoomLocally` remove it, like v1.
- **Following rekeys from outside the room (finding 1, option a):** the
  rooms-list watch subscribes to `1462` with the authority as author. It calls
  `decodeRekeyEvent` with its stored keys, `kithmoot.device.<room>` and the
  `own-seal` keys, then advances the stored epoch.
- **Chat-history vector:** a `chatHistory` group in kithmoot's own
  `vectors/generate.mjs` (beside `roomEpoch`, `:1706`), since `chat.ts` lives
  here. Given left epochs with times, a `now`, and a scheduled rekey, it lists
  which `#d` streams are read. One message before and one after a scheduled
  rekey both stay readable.
- **Tests:**
  - `session-epoch.test.ts`: a scheduled rekey carries the flag through
    `onEpoch`.
  - `session-member-epoch.test.ts`: a grant's `passed` gives the right
    `leftAt`.
  - Keep in mind that a fixed clock in `src/session.test.ts` drops signals;
    omit `now` where offers must flow.
- **Docs:** a `docs/protocol/m2-compatibility.md` row for old and new readers
  in both directions. `docs/protocol.md` for the marker and `passed`. Correct
  the parity doc's 2a bullets.

**As built**, where step 2 differs from the text above:

- `pastSecrets()` includes epoch 0 while it is in the window, with the room
  secret, and `pastEpochs` takes it. Once the web opens a room at its stored
  epoch, nothing else would read what was said before the first rekey. The
  desk leaves epoch 0 out of a grant, as fold-kit requires.
- When the room left an epoch is the rekey out of it the session holds,
  else what a grant or `pastEpochs` said, else the notice's time. Seeded
  epochs have no rekey to ask `rekeyedAt`, so the session records each
  `leftAt` as it goes.
- A v1 record holds no secret, so it cannot become v2. A device from an
  earlier release opens from epoch 0 as before and writes v2 from then on,
  and v1 goes on being written beside it for older builds.
- The rooms-list watch follows rekeys in place: it moves its chat, control
  log and roster to the new epoch and goes on reading the one it left, then
  reports the move. A rekey followed out of epoch 0, or out of the epoch the
  v2 record holds, moves v2; otherwise only v1 moves, and opening the room
  writes v2.
- The watch reads its device key without touching it (`loadDeviceKeyFor`),
  so a room only watched still ages out after 30 days unused.

### Step 3: Android readers (0.6.58)

- `decodeRekeyEvent` (`protocol/.../Rekey.kt:180-214`) reads `scheduled`.
- `decodeEpochGrant` (`Rekey.kt:413-440`) reads `passed`. It currently ignores
  the field safely. Add `passed` to `EpochGrant.Current`.
- `answerFromAuthority` applies the passed epochs as `crossed` and stores them
  through `onEpochHistory`, as `answerFromMember` already does
  (`session/RoomSession.kt:1479-1505`).
- **History rule:**
  - `MAX_PAST_EPOCHS` becomes 16 (`RoomSession.kt:130`,
    `QuietTransport.kt:119/250`).
  - `pastEpochsFor` (`epoch/ActiveEpoch.kt:55-70`) ports `epochsInWindow`; it
    iterates `currentEpoch - MAX_PAST_EPOCHS` today.
  - `keepPastLocked` (`RoomSession.kt:1597-1602`) takes the new cap.
  - `chatFilter` (`RoomSession.kt:1654-1658`) is already a single filter with
    several `#d` values, so it needs no change.
  - `EpochVault` keeps 32 epochs (`EpochVault.kt:275`), which already covers
    16.
- **Quiet:**
  - Carry a `scheduled` flag on `RoomEpochState.Active` and
    `RoomEpochState.Updating` (`RoomSession.kt:150-158`).
  - `observeRoomEpoch` (`ui/RoomViewModel.kt:4084-4090`) then shows neither
    "Secure room update in progress." nor "Secure room update complete.". That
    covers the "waiting for Bothy to retire the old schedule" line too.
- **Background follows rekeys (finding 1):** `BackgroundCallListenerService`
  and `BackgroundDelivery` subscribe to `1462`, open their copy with the
  device key, and commit the new epoch to `EpochVault`. Ringing and
  notifications then survive a rekey.
- **Vectors:** copy `schedule-vectors.json` and the new kithmoot vector JSON
  into `protocol/src/test/resources/` (copied by hand, verbatim). Add
  `ScheduleVectorsTest.kt` and update `VectorCoverageTest`.
- **Tests:** `RoomEpochTransitionTest` (scheduled stays quiet),
  `PastEpochsForTest` (16 and 30 days), `EpochRequestTest` (grant with
  `passed`).
- Android's own authority responder does not need `passed`: rooms it created
  never leave epoch 0.

### Step 4: releases

Deploy the web, then release desktop 0.1.54 and Android 0.6.58.

### Step 5: decide the gate

Before the keeper starts rekeying, the owner confirms option (a) and its
bound. Done 2026-10-05: option (a), with the 30-day bound.

### Step 6: the keeper writes, with the cadence off by default

**Keeper state (`src/keeper-state.ts`):**
- New `epochAt` (when the current epoch began) and
  `past: [{epoch, secret, left}]`.
- Under option (a), also `devices`: the newest credential for each device seen
  within the window.
- All three are additive to v2. `parseKeeperState` ignores fields it doesn't
  know, so going back to an older keeper is safe.

**`src/agent.ts`:**
- `#persist` (`:1149-1170`) writes those fields.
- The startup path (`:575-600`) passes `pastEpochs` and `epoch` to the
  session.
- `hostRoomEpoch` at `:661` gains `past: () => session.pastSecrets()`.

**Who and when:**
- A new `#keepRekeying()`, started only when `opts.keeper` is set and the room
  isn't closed.
- It checks on an hourly unref'd timer and once after joining.
- It's due when both hold:
  - `now >= epochAt + 7d + jitter`, where the jitter is
    `hash(epochId) mod 6h` (deterministic, so it needs no state);
  - somebody has spoken.
- Put the due check in a pure function in a new `src/rekey-schedule.ts`.
- `epochAt` is `session.rekeyedAt(epoch) ?? keeper.epochAt`. For a room at
  epoch 0 with no `epochAt`, set it to now on the first check and save it. The
  first scheduled rekey therefore comes at least 7 days after upgrading.

**"Somebody has spoken since":**
- Any `messages()` entry (`chat.ts:1137`) with `at > epochAt` whose
  participant isn't the keeper.
- Checked across `session.chat` and `session.channel(name)` for each
  registered channel (`agent.#channels`).
- The ChatLog reloads 30 days from relays after a restart, so this survives
  restarts without extra state.

**The rekey:** `session.rekey({ authoritySk: keeper.inviterSk, scheduled:
true })`. Add `scheduled` to `RoomSession.rekey` (`session.ts:1698`). It
already writes `commit: true` and `members` (`:1715-1734`). Under option (a),
the recipients are the window's devices from `#newestCredentials`, not just
the roster.

**Keeper offline:** when it restarts, one rekey happens if one is overdue and
somebody has spoken. Missed weeks are not made up, and clients never assume a
regular cadence.

**Avoiding a race:** just before signing, skip if the session is behind or has
a pending rekey above its epoch. In `src/node/cli.ts` (state saved at `:342`,
`:668`) add a `<state>.lock` file opened exclusively, so two keepers can't run
on one state file.

**Flag:** `--rekey-every <days>`, defaulting to 0 (off) in this release.

**Tests:**
- `rekey-schedule.test.ts`: 7 days with no speech; speech by the keeper only;
  jitter.
- `keeper-state.test.ts`: round trip; an old reader ignores the new fields.
- `agent.test.ts`: with a fake clock the keeper rekeys once; the web notice
  stays silent; a newcomer's grant carries the window.
- Optional e2e: no "moved to epoch" line.

### Step 7: turn the cadence on

Once desktop 0.1.54 and Android 0.6.58 are out in the field, release a keeper
that defaults to 7 days, and update the parity doc and the Remove dialogue
copy ("if the keeper is away, the rekey happens when it is next online").

## Risks

- **Old clients:**
  - Web is fixed on deploy.
  - Desktop 0.1.53 posts "The room moved to epoch N." every week until it
    updates.
  - Android 0.6.57 flashes "Secure room update…" every week. In quiet-cadence
    rooms it also renews its Bothy schedule lease weekly
    (`RoomViewModel.kt:5303-5371`).
  - Neither breaks, and old grant readers still get the current epoch.
  - Old watches and Android background go quiet after a rekey (finding 1)
    until they update, which is why the cadence starts off.
- **Size of the newcomer grant:** 16 entries of about 75 bytes each, sealed,
  is about 3 KB per 20469. That's no concern.
- **Size of the 1462:** about 370 bytes per recipient plus about 100 per known
  member. A 64 KiB rekey fits about 170 devices or about 600 members. The
  limit exists today; weekly rekeys make it routine, and option (a) raises the
  recipient count. That is phase 4's rekey-split work.
- **Member desks:** they stop serving newcomers once a room passes 32 epochs
  (about 7 months of weekly rekeys; `chainFor`, `member-epoch.ts:564-565`), so
  newcomers then depend entirely on the keeper. Member grants are also capped
  at 60 KB of inlined rekeys (`DEFAULT_MAX_GRANT_BYTES`, `:90`), so large
  rooms fall back to the keeper sooner.
- **Relay filters:** 16 past epochs as separate filters could exceed relay
  per-request filter caps; the fold in step 2 bounds it at 6.
- **Unrelated bug found on the way:** `KeeperState.channels` (`agent.ts:115`)
  is never written by `serialiseKeeperState` (`keeper-state.ts:93-110`), so a
  keeper restart loses the room's channel list. Fix it separately.

## Ship order and versions

1. fold-kit 0.8.0 to npm (0.5.0, 0.6.0 and 0.7.0 were each a minor bump for a
   feature).
2. kithmoot readers: pin 0.8.0, then web deploy and desktop 0.1.54.
3. Android 0.6.58.
4. Gate decision (can run in parallel with 1 to 3).
5. Keeper with the cadence off.
6. Keeper with the cadence on.

Steps 2, 3 and the keeper work all build on fold-kit 0.8.0, and every step only
reads or writes things old clients ignore. The 2a doc still makes no
forward-secrecy claim, and `MAX_MEMBER_EPOCH_CHAIN` stays at 32.
