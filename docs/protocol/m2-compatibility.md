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
