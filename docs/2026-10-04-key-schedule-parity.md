# Key schedule: healing, forward secrecy and quieter authorship

Status: proposed 2026-10-04. Phase 1 shipped 2026-10-04 (fold-kit 0.7.0,
#237, desktop 0.1.52). Phase 2's erasure audit is done
(`docs/2026-10-05-erasure-audit.md`), and it splits phase 2 in two: healing
(2a) and forward secrecy (2b). 2a's readers shipped 2026-10-05 (fold-kit
0.8.0 and this repository; the plan is `docs/2026-10-05-phase-2a-plan.md`);
its keeper cadence is not built yet. Phases 3 and 4 are not started. Eight
owner decisions are listed at the end. Each has a recommended answer except
the seventh, the eighth is decided, and the work so far follows them.

## Scope

This plan covers rooms admitted by link on ordinary relays: every room
KithMoot has today. Rooms on Vennel's sheltered lane get MLS through the
circle's box (`vennel/VENNEL.md` §4.1, the P3 tickets), and this does not
compete with that. MLS cannot serve a link-admitted room on public relays,
for the reasons in "Not NIP-29, and not Marmot" (`decisions.md`): nobody is
online to issue welcomes, and key packages are never published in the clear.
So the epoch scheme stays, and it should stop losing to Marmot on the
properties a reviewer checks first.

## Where White Noise is ahead today

- **Post-compromise security.** A device's key does two jobs: it signs, and
  every rekey and epoch grant is sealed to it (`fold-kit` `epoch.ts`, the
  rekey's `keys` map and the 20469 grant; `member-epoch.ts`, the 20472
  grant). Whoever copies it opens every future rekey for that device until
  somebody notices and removes it. In MLS a member heals by updating its
  leaf.
- **Forward secrecy.** An epoch key is static until the next rekey, and a
  room that never removes anybody never rekeys, so a stolen key reads back
  to the room's first message.
- **Per-message authorship.** Chat is signed by the device key
  (`src/chat.ts`, `encodeChat`), and a relay can count messages per device.
  Marmot signs each group message with a throwaway key.

Marmot's cipher suite should be checked against MIP-00 before anyone says
White Noise is or is not post-quantum. Phase 4 below does not depend on it.

## What the evidence already fixes

Four facts decide most of the design.

1. **The healing anchor has to be the participant key.** A rotating
   receiving key signed by the device key heals nothing, because the thief
   holds the device key and signs their own rotation. The device credential
   (kind 20460) is signed by the participant (`protocol.md`, "Credentials,
   roster and room state"). It lives twelve hours and is renewed at half-life
   (`src/session.ts`, `CREDENTIAL_TTL_SECONDS`, `CREDENTIAL_RENEWAL_FRACTION`).
   The participant key usually lives in an extension, a bunker or Heartwood,
   not on the device (`decisions.md`, "A member is removed by a room epoch").
   That signer is the one thing a device thief does not get.
2. **Epoch 0 is the link.** Its secret is the link's room secret, and saved
   rooms keep the link, so nothing derived from epoch 0 can have forward
   secrecy. Forward secrecy starts at epoch 1.
3. **History is read across epochs.** A client reads the four most recently
   left epochs, none left more than thirty days ago (`src/chat.ts`,
   `MAX_PAST_EPOCHS`, `CHAT_RETENTION_SECONDS`). Rekeying on a schedule
   shortens readable history unless that rule changes.
4. **The desk answers a live credential.** An epoch request with a valid
   credential for a participant the room knows, plus the epoch-0 admission
   proof, is granted the current epoch (`decisions.md`, "The epoch desk
   answers holders of the room key"). A thief holding the device key, the
   credential and epoch 0 can ask for the current epoch until that
   credential expires.

## Phase 1: a seal key in the credential (healing)

- **Wire.** The 20460 credential gains a tag `seal`: an x-only secp256k1
  public key, minted fresh by the device at every renewal. The participant's
  signature covers it, so only the signer can bind a new one.
- **Keeping the secrets.** The device keeps its seal secrets as it keeps its
  device key, up to 128 a room (a month of renewals), and offers them back
  to the session (`sealKeys`). A browser reads a room again from its first
  rekey, and each old copy is sealed to the seal key current when it was
  written, so a device that dropped them would have to ask a desk for every
  epoch. Keeping them costs healing nothing: a thief who copies the device
  holds the seal keys minted up to then and none after. Retiring them
  belongs with epoch secrets in phase 2's erasure audit.
- **Sealing.** A rekey's `keys` entry and both grants (20469, 20472) are
  sealed with NIP-44 to the seal key from the newest live credential the
  sender holds for that device. If the device has no `seal` key, the
  sender falls back to the device key, as today. Every reader tries the seal
  key first, then the device key.
- **Desk.** A request is answered against the newest credential the desk
  knows for that device, never an older one it is shown, and is sealed to
  that credential's seal key.
- **Window.** A device thief who does not hold the participant key can read
  until the next rekey. By then the credential they copied has expired, the
  device's new seal key is out of their reach, and the desk will not answer
  them. The window is the time to the next rekey, up to the scheduled
  cadence (phase 2), and at least the remaining life of the copied
  credential, up to twelve hours.
- **The link outlives healing.** The thief also holds epoch 0, which is the
  link. In a room that has never removed anybody, they can mint a fresh
  participant key, make the admission proof and be admitted as a newcomer
  (`member-epoch.ts`, `admissible`; `decisions.md`, "What this does not
  change"). In a room that has removed somebody, they knock. Either way
  they arrive as a new member that everybody can see. Healing turns an
  invisible reader into a visible stranger. Keeping them out as well needs
  the link replaced, which the security notes should say.
- **Secondary devices.** A paired device's credential is minted by its
  primary and does not renew, so it names no seal key and is sealed to as
  before. Healing it needs the pairing flow to carry a seal key the
  secondary minted.
- **What it does not cover.** A participant whose key lives on the device
  (a local nsec, no signer) heals only by removal. The same is true in MLS,
  where a thief who copies the signing key can update the leaf too. Device
  *signing* key rotation is a separate, later change, because a changed
  device key is a different endpoint and tears down its media connections
  (`protocol.md`, the `sid` paragraph).
- **Vectors.** `credentialSealKey` (tag present and absent, malformed and
  stale), `rekeySeal` (seal key, device-key fallback, both offered),
  `epochGrantSeal` (20469 and 20472 alike, newest credential wins).

## Phase 2: scheduled rekeys (healing completes, forward secrecy arrives)

Phase 1 only heals at a rekey, and today a room rekeys only on removal.

**Split by the erasure audit** (`docs/2026-10-05-erasure-audit.md`). Three
things defeat forward secrecy today, and erasing epoch secrets fixes none of
them:
- rekey copies and authority grants are sealed from the authority's
  long-lived key;
- Android and paired secondaries have no seal keys;
- the web recomputes every epoch at each load.

**2a, healing:** cadence, history, newcomers, the quiet marker. It ships
first and claims no forward secrecy. Its readers are done: the marker, the
time-bound history rule, the window in the authority's grant, the web keeping
its window's secrets (2b's item 3, brought forward), and watches that follow
rekeys. What is left is the keeper's cadence (the plan's step 6), off by
default until a desktop release after 0.1.54 and an Android release with
the readers (after 0.6.58) are in the field.

**2b, forward secrecy:** a one-time sender key for 1462 and 20469, seal keys
on Android and secondaries, the web keeping its window's secrets instead of
re-walking from epoch 0, archive and Android history pruned by age, then
erasure. The bullets below were written before the split; the audit's "What
this changes in the plan" takes precedence where they differ.

- **Cadence.** The keeper rekeys a room when it has been at one epoch for
  seven days and anybody has spoken in it since. A rekey with nobody removed
  is the existing 1462 with an empty `removed` list, marked `scheduled`.
  **Corrected 2026-10-05:** the cadence runs on the keeper only, not "the
  creator's client". The keeper is the only place an authority desk runs
  (`src/agent.ts`, `hostRoomEpoch`); a browser rekeys only to close a room,
  and Android never builds a 1462. A browser rekeying on a schedule would
  leave every member who was offline, and every newcomer, waiting for some
  other member to come online. So the healing claim holds for keeper rooms.
  If the keeper is away, the rekey happens when it is next online, and the
  doc and the Remove dialogue say so.
- **Rooms nobody has open (owner decision, 2026-10-05: option (a)).** A
  rekey seals copies only to the devices in the roster, and the rooms list,
  Android's background delivery and its call listener read a room under the
  epoch they last held. So without more, a room nobody has opened since a
  rekey would lose its unread marks, notifications and rings a week later.
  Chosen: a scheduled rekey is also sealed to every device whose credential
  the keeper has seen within the 30-day window, and each of those watches
  follows 1462 from its stored epoch with its own copy. The cost, accepted:
  a stolen device whose real owner then stays offline is sealed scheduled
  rekeys for up to 30 days (about four), not just until its 12-hour
  credential lapses; and each recipient adds about 370 bytes, so a 64 KiB
  rekey fits about 170 devices, beyond which it falls back to online
  devices plus the most recently seen. The readers (the web's rooms list)
  shipped with 2a's readers; the keeper's side is the plan's step 6.
- **Forward secrecy at epoch granularity.** A device erases an epoch's
  secret and every key derived from it once that epoch drops out of the
  history window. Over a scheduled cadence that is forward secrecy whose
  window is the history window. No in-epoch ratchet is proposed. That
  replaces the last sentence of "Not NIP-29, and not Marmot", which planned
  one: a ratchet buys something only if history is kept for less time than
  an epoch lasts, and it would make every grant carry step keys.
- **Erasure caps member catch-up.** A member building a grant chain reads
  the secret before each rekey to check its evidence (`member-epoch.ts`,
  `secretAt`). Once secrets outside the window are erased, a member can
  carry only the epochs inside it, not `MAX_MEMBER_EPOCH_CHAIN` (32), and a
  device further behind asks the authority. That is acceptable, but the
  audit must cover the grant path.
- **Erasure audit first.** Before claiming any of this, list every place an
  epoch secret is persisted and confirm it is erased on schedule: the web
  `device-store` and `den` saved rooms, the agent's state file, Android's
  `SavedRoom`, desktop. Today the retention rule decides what a client
  *subscribes to*; it is not yet shown to decide what it *keeps*.
- **History.** Seven-day epochs, four of them kept, gives five weeks, which
  just covers the thirty-day window, but removals use up the same four.
  Done: the rule is time-bound (every epoch left within thirty days), with a
  hard cap of 16 (fold-kit's `epochsInWindow`). A chat subscription keeps at
  most six filters by folding the oldest epochs into one.
- **Admission is unchanged.** The ask-before-letting-in rule keys off the
  removed set, not the epoch (`member-epoch.ts`, `admissible`), so a
  scheduled rekey does not gate an open room.
- **Newcomers would lose the backlog.** Today a newcomer to a never-rekeyed
  room reads thirty days of history under epoch 0. A grant to a newcomer
  carries the current epoch only (member grants carry up to
  `MAX_MEMBER_EPOCH_CHAIN` passed epochs, but only for a returning device).
  After scheduled rekeys a newcomer would see one week. Done: every
  authority grant carries the epochs within the history window (`passed`),
  since a request does not say which epoch the device holds. That keeps
  today's behaviour and gives a link holder nothing they could not read from
  epoch 0 today.
- **Quiet in the room.** The web client posts "The room moved to epoch N"
  on every rekey (`app/src/main.ts`, the rekey notice). Done: a scheduled
  rekey carries `"scheduled": true` in its encrypted body, and the web says
  nothing of it; Android follows with its own readers (the plan's step 3).
- **Vectors.** `scheduledRekey` (an empty `removed` list, members carried,
  the chain unbroken, the scheduled marker), a newcomer grant carrying the
  window, and a chat history case across a scheduled rekey. Done: fold-kit's
  `schedule-vectors.json`, copied here, and the `chatHistory` group in
  `vectors/kithmoot-vectors.json`.

## Phase 3: a throwaway outer author for chat (metadata)

- **Wire.** A chat event is signed by a one-time key. The device's BIP-340
  signature moves inside the encrypted body, over the same canonical message
  the outer signature covers today plus the one-time pubkey. The call bell
  already works this way (`src/call-bell.ts`).
- **What it buys.** Someone reading relay history cannot count messages per
  device. The relay operator still sees which connection published, and the
  roster is still signed by the device, so the device set is still visible.
  `protocol.md` already records that trade-off; this does not change it.
- **Rollout.** `chat.ts` drops a message whose outer author is not the
  device, so readers ship first, on web, desktop, the agent and Android
  (`session/Chat.kt`). Writers switch only once every reader has had a
  release in the field. Relay rate limits by author stop working for chat,
  so the sender rate limits that matter move inside the room.
- **Vectors.** `chatEnvelope2` (a valid inner signature, inner and outer
  mismatched, a replayed inner under a fresh outer, an old reader's refusal).
  It also needs an edit and a retraction whose inner device matches the
  original while the outer keys differ, because `replaces` and `retracts`
  are same-author checks and must be made against the inner device, never
  the outer key.

## Phase 4 (optional): hybrid post-quantum seals

- The `seal` tag from phase 1 becomes the hook: the credential also carries
  an ML-KEM-768 public key, inside the encrypted roster, never in the clear.
  Rekeys and grants seal with ML-KEM and the existing secp256k1 key
  exchange together, never ML-KEM alone.
- **Size is the design problem.** A seal grows by about 1.1 KB (about
  1.45 KB in base64). Relays refuse events much over 64 KiB, so a single
  rekey stops fitting at about 40 devices. A larger room needs its rekey
  split across events, or a tree-shaped schedule.
- Messages, files and media need nothing: they are symmetric at 256 bits.

## Rollout rules for every phase

- `@forgesworn/fold-kit` first, with its vector group; then this repository
  bumps the pin (`AGENTS.md`).
- The Android client ports from the same vectors (`epoch/EpochOpening.kt`,
  `session/RoomSession.kt`, `session/Chat.kt`).
- A row in `docs/protocol/m2-compatibility.md` for old-to-new and
  new-to-old reads, as the release gate requires.
- Each phase ships readers before writers. A device without the feature
  keeps working, unhealed, and nobody's room goes quiet.

## Where this leaves KithMoot against White Noise

- **Healing:** level after phases 1–2, and ahead for anybody whose
  participant key lives in a signer, since the anchor is off the device.
- **Forward secrecy:** level at epoch granularity after phase 2, except
  epoch 0, which is the link. If White Noise keeps a local plaintext store,
  as MDK's storage layer suggests (unverified), its forward secrecy against
  a device thief is limited in the same way that history limits it here.
- **Authorship:** level after phase 3.
- **Already ahead:** no forks (only the authority rekeys), catch-up after
  absence, one member per person, entry by link.
- **Post-quantum:** ahead after phase 4 if Marmot is still classical.

## Owner decisions

1. **Cadence.** Recommended: seven days, only if anybody has spoken.
2. **History rule.** Recommended: time-bound (thirty days), capped at 16
   epochs, instead of four epochs.
3. **Newcomer backlog.** Recommended: a newcomer's grant carries the epochs
   within the history window, as epoch 0 effectively does today.
4. **Device-key participants.** Recommended: say in the room's security
   notes that healing needs a signer, rather than building a second anchor.
5. **Phase 3 now or later.** Recommended: after phases 1–2. It is
   independent but buys the least.
6. **Phase 4.** Recommended: design the rekey split now, since phase 2
   makes rekeys routine, and build ML-KEM when a pure-JS and Kotlin
   implementation pair has passed review.
7. **The room archive against forward secrecy** (raised by the erasure
   audit). Either the archive prunes at the history window and deep local
   history goes, or it re-seals what it keeps to a device archive key, so
   history the device holds is not forward secret against the device (as in
   Signal). No recommendation yet. It gates 2b, not 2a.
8. **Rooms nobody has open** (raised by the 2a plan). Decided 2026-10-05:
   option (a), a scheduled rekey is also sealed to every device the keeper
   has seen within the 30-day window, and watches follow 1462 with their own
   copy. See "Rooms nobody has open" under phase 2.
