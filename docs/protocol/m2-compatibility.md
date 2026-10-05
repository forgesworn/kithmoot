# M2 compatibility ledger

Baseline: TypeScript/web `915ba7d` (contains the agreed `09391c5` baseline),
Android `c6580d4`. The previous-release tests use a separate immutable checkout.

## Boundaries under test

| Consumer | Contract affected or retained | Required proof |
|---|---|---|
| Existing KithMoot web clients | Signed seal-less 20462/21059, recipient selectors, room links | Old/new bidirectional decode and real browser rooms |
| Android | Independent signal codec, same vectors, v3 creation | JVM/app tests, APK checks, emulator room journeys |
| Existing keepers | Old state files, invitation/epoch authority, channels | Existing v2 state retains its link; new v3 rooms survive restart |
| Existing forwarders | Old signal body, room binding, no tickets | Old/new signals and existing forwarding journeys; no policy or redeployment |
| Wildbloom | FSWNENC2 and older envelopes, recovery key, metadata | Unchanged vectors, uploads/downloads and encrypted chat/context |
| V4V | Blossom upload/mirror/server-list contracts; payments | No KithMoot signal dependency introduced; shared storage checks remain separate from payment settlement |
| RelaySwarm | Kinds 24170/24171 and its own transport protocol | Collision check and no format/selector changes |
| Bothy / Link | Future optional archive/nudger and privacy principles | No new mandatory service, imported tag wire or changed Bothy implementation |

No pass/policy is automatically issued, published or required. No live TURN,
Blossom, keeper or forwarder deployment is part of this change. The future
selector mode remains reserved and inactive.

## Results

Results are added here after commands finish. Tests against local relay fixtures
are distinguished from public-service and installed-device evidence. Copied
vectors are not evidence for Android features its README explicitly lacks.

- TypeScript: `npm test` passed 1,449 tests across 85 files.
- Android: protocol/app unit tests, debug/release lint, debug/release APK builds
  and instrumentation APK assembly passed. The disposable API-35 emulator also
  passed 12 installed-app tests: storage/recovery, forced process restart, v3
  creation/rotation/reopen/refusals, chat and screen sharing.
- Shared vectors: 190 across 26 groups, including 12 signal compatibility
  cases and 42 service audience/scope/pass/policy cases. Kotlin reads both event shapes.
- An existing Android `everyone` mention discrepancy surfaced when syncing
  current vectors and was corrected to the already-frozen message contract.

## Existing limitations

Android already lacks forwarder support and end-to-end encrypted media, and does
not implement every message/attachment/epoch feature. M2 must not present these
as newly supported. Its service decoders do not implement service admission.
A hostile relay can withhold traffic or exhaust the bounded unwrap budget; the
budget bounds CPU work rather than proving availability through a malicious relay.

### Seal keys (fold-kit 0.7.0, key schedule parity phase 1)

The web client names a seal key in each credential it mints for itself
(`["seal", <pubkey>]`) and seals rekey copies and epoch grants to the seal key
of the newest credential it has seen for a device. Compatibility:

- Old senders, including today's Android, ignore the tag and seal to the
  device key; new readers try the device key last, so they still read.
- New senders seal to a seal key only when the credential names one, and only
  a client that reads seal-sealed copies mints one, so an old reader never
  receives a copy it cannot open.
- Android mints credentials without a seal tag and is sealed to as before.
  It needs no change to keep working; it heals only once it mints seal keys.
- A paired secondary device's credential is minted by its primary and names no
  seal key, so it is sealed to as before, unhealed.
- The seal vectors (`vectors/seal-vectors.json`) are copied from fold-kit and
  checked by `vectors/verify-seal.test.ts`.

### Scheduled rekeys and the history window (fold-kit 0.8.0, key schedule parity phase 2a)

These are the readers. No release rekeys on a schedule yet: the keeper's
cadence comes later and starts off (`docs/2026-10-05-phase-2a-plan.md`,
step 6). Each change, both ways:

| Change | New writer, old reader | Old writer, new reader |
|---|---|---|
| `"scheduled": true` in a 1462 body | Ignored. Web and desktop up to 0.1.53 post "The room moved to epoch N."; Android up to 0.6.57 shows "Secure room update complete." Neither breaks | No marker, so the rekey is announced as before |
| `passed` in a 20469 grant | Ignored: the current epoch only, as from any grant before (`epoch-grant-window-old-reader`) | No `passed`: the current epoch only, as before |
| Window of 16 left epochs, 30 days | An old client reads 4 left epochs. On a weekly schedule that is still about a month; removals shorten it | Unchanged |
| Chat filters folded past the fifth | A relay sees one REQ with at most six filters, the last with several `#d` values, which NIP-01 allows | Unchanged |
| A rooms list following 1462 | Old lists read a room under the epoch they last held and go quiet after a rekey until it is opened | Follows only rekeys with a copy for its device, as a session does |
| `kithmoot.room-epoch.v2.<room>` | An older web build reads `room-epoch.v1`, which is still written beside it, and replays from epoch 0 as it always has | No v2 record: the session opens from epoch 0, as before, and writes one from then on |

- The keeper's desk hands every grant the window (`hostRoomEpoch`'s `past`,
  from `RoomSession.pastSecrets`). Until it rekeys on a schedule that is
  epochs left by removals only.
- Old watches and Android background listeners going quiet after a rekey is
  why the cadence starts off: once desktop 0.1.54 and Android 0.6.58 are out,
  a scheduled rekey reaches a room nobody has open as well.
- The schedule vectors (`vectors/schedule-vectors.json`) are copied from
  fold-kit and checked by `vectors/verify-schedule.test.ts`; the `chatHistory`
  group in `vectors/kithmoot-vectors.json` pins what a log reads across a
  scheduled rekey.

### Call reliability profile 2 (2026-09-17 spec, step S3)

Web `src/signal.ts` and `src/types.ts` now carry the profile-2 wire fields
(`gen`, `conn`, `peerConn`, `seq`, `first`, `candidates`, `ack`, `re`,
`restart`, `slots`, `rx`), the three new signal types (`ack`, `health`,
`sync`) and the roster's `callProfile`/`sid`, all additive and validated
strictly on decode - see `docs/protocol.md` "Profile 2 additions". This is
wire and vectors only: no `Peer`, `Mesh` or app code reads or writes any of
it yet, so today's Android build, and today's web build, both remain profile
1 for every pair.

Android's protocol module (`protocol/.../Signal.kt`, `protocol/.../Roster.kt`)
does not yet decode these fields, and no fixed-slot transceivers, reliable
channel, generation tracking or pair-health ladder exist on that platform -
see section 6 of the spec, work items 1 through 6, none of which have landed.
Shared vectors already include the profile-2 `signalWrap` cases and the
`profile-2-and-page-session` roster case; Android reading them decodes the
fields it recognises and ignores the rest, exactly as the additive-fields
design intends, but that is a codec-compatibility proof, not a claim that
Android speaks profile 2. Until Android's work items land, every Android
pair is profile 1 and the web side carries recovery for it, per the spec's
interop table (section 5).

## Mixed versions and shared services

- Built immutable previous release `915ba7d159dbc54a078cc1cb69c5e875e6bc9096`.
  `playwright.m2.config.ts` passed three Chromium journeys: old/new video,
  audio and chat in both v2 and v3 rooms; previous-release keeper admission and
  encrypted chat with an M2 browser over a real local NIP-01 relay.
- Chromium media/agent/soak checks passed nine journeys, including delayed relay
  acknowledgement and an outage longer than the presence timeout. Encrypted
  context upload/import and screen-viewer checks also passed.
- All six copied Wildbloom encryption fixtures are byte-identical to the current
  Wildbloom checkout. Existing attachment tests reproduce and read their bytes.
- A synthetic 65,608-byte FSWNENC2 envelope uploaded to the existing public
  Blossom endpoint, downloaded, matched its hash and decrypted to its source.
  No pass, server configuration change or participant signing key was needed.
  Synthetic ciphertext hash: `2228323b47eae1c1e318c168dc2c18e943ddcec6c96ebb71facc54902ba6c5ba`.
- Running keeper units were checked read-only: unchanged since 4 September.
  No forwarder instance is running. No live keeper/forwarder/Blossom/TURN code
  or room state was redeployed for these checks.

### Existing forwarder defect found by the gate

The previous release establishes ICE/DTLS with both old and M2 clients, then
removes mirrored tracks when `Peer.start([])` updates local publications.
The previous release fails the media check against itself too: this is an
existing server defect, not a new selector or admission incompatibility.

M2 fixes publication ownership: `Peer` only removes tracks it added. The focused
regression failed before that fix; actual encrypted RTP now crosses the fixed
forwarder in both directions with old clients and with M2 clients. Those checks
use the real forwarding stack, local NIP-01 WebSockets and ICE/DTLS/SRTP, with
public STUN disabled for the local fixture. The forwarder receives no room key.
An operator using the affected old forwarder needs that server fix to restore
media. Client updates alone cannot repair it. No live room is restarted here.

Reproduce against a separately built previous-release checkout:

```sh
M2_BASELINE_DIR=/path/to/previous-release M2_CURRENT_FORWARDER=1 node scripts/check-m2-previous-release.mjs
M2_BASELINE_DIR=/path/to/previous-release M2_CURRENT_FORWARDER=1 M2_PREVIOUS_CLIENT=1 node scripts/check-m2-previous-release.mjs
```

Omit `M2_CURRENT_FORWARDER=1` to reproduce the known old-server media failure;
the preceding first-offer/ICE result is reported separately. For browser proof,
serve that checkout on its own HTTPS preview port, then run
`M2_BASELINE_DIR=/path/to/previous-release M2_BASELINE_URL=https://localhost:4174/j/ npx playwright test --config playwright.m2.config.ts`.

Two independent vector regenerations matched byte for byte. The separate pinned
and tracking upstream checks passed. Kind-registration JSON and YAML are prepared
for owner submission; no upstream registration or NIP acceptance is claimed.
V4V payment settlement and new Bothy/Link functionality are outside M2 and were
not claimed as tested by shared-format checks. Physical Android acceptance is
separate from the installed emulator evidence above.

The installed Android 0.4.1 client also passed a real v2 keeper journey against
`915ba7d`: native admission, encrypted chat in both directions and clean exit.
Run `scripts/check-m2-android-keeper.mjs` with `M2_BASELINE_DIR`, `ANDROID_HOME`
and `ANDROID_SERIAL` set to a disposable emulator with both debug APKs installed.
Its test uses synthetic keys and a local NIP-01 relay; the old keeper receives no
M2 code or service policy. Android 0.4.1 uses version code 7 and the same debug
signing certificate as the published 0.4.0 APK. It remains a debug prerelease.
