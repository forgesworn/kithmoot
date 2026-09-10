# Workspace delivery

Started 2026-09-09; continued 2026-09-10. The active objective is to deliver the
chat-focused desktop and Android workspace with minimal agent supervision,
Oathrun execution, scoped useful memory and efficient token use. The
[product goals](product-goals.md) and [initial audit](workspace-capability-audit.md)
retain the complete requirements. An individual slice is not completion.

## Acceptance ledger

| Deliverable | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Conversation and decisions | PR #60 merged and deployed. All five CI jobs passed; 24 deployed app files matched the build. Room attention, desktop work beside chat and phone decision review are live. | Authorised cross-project attention and physical-phone acceptance. |
| Shared projects | Existing device-local room labels and preserved drafts. | Synced project model mapped to Oathrun authority, overlapping memberships and device continuity. |
| Oathrun assignment execution | Durable encrypted assignment bridge and bounded route implemented in the isolated Oathrun worktree. The browser/native-host/container journey covers claim, one model question, principal answer, bounded continuation, evidence result and exact principal acceptance. Cross-project denial, positive cleanup before stop acknowledgement, encrypted action discovery, late refresh and withdrawal are tested. | Held-execution reconciliation; richer progress/failure decisions; live supported host. |
| Minimal supervision | Oathrun profiles, grants and budgets exist. A reviewed assignment route now handles claim, question and result reports without per-report approval, and continues from the principal’s answer under the original task and project authority. | Reusable setup; delegation and failure decisions; demonstrate fewer avoidable interventions and cost per accepted outcome on real work. |
| Native Android | [PR #21](https://github.com/forgesworn/kithmoot-android/pull/21) merged and 0.5.8 (16) is published on GitHub and the public site: native Work cards, action discovery, the shared signed assignment contract, encrypted history and exact retry. All 347 local unit tests, both lint variants, the 17-test local emulator suite and both hosted jobs passed. | Quiet shared work, paired-device signing, cross-project attention, live executor pairing, physical-device and locked-phone acceptance. |
| Context and efficiency | PR #69 merged after all five hosted checks passed; bounded lexical retrieval and one-hop provenance are deployed with the PWA. Oathrun adapter adoption passed 336 Rust tests and both native journeys on the reconciled recovery baseline. | npm 0.2.0 publication requires publishing authentication; derived repository/semantic graph coverage and measured cost per accepted outcome remain open. |
| Calls and temporary meetings | Existing media/transcript/agent controls; G7/G8 retained. | Daily call-to-assignment acceptance, platform parity; separate temporary identity/retention/teardown mode and fail-closed masking. |

## Work locations

- PWA: `kithmoot` checkout; first slice merged into main as `3b344e3`.
  Release copy and the current delivery record continue on `release/android-shared-work`.
- Android: sibling `.workspace-delivery/kithmoot-android` worktree,
  branch `feat/shared-agent-work`, PR #21, source head `8a9036b`;
  based on the committed 0.5.7 baseline `97a182c`.
- Oathrun integration: sibling `.workspace-delivery/oathrun` worktree,
  branch `feat/kithmoot-assignment-delivery`, reconciled with committed recovery
  baseline `cafd303`. The integration and bounded context work are recorded at
  `ddf5d52`; `cec6c2b` adds fixture compatibility and final reconciled evidence.
  The original Oathrun checkout contains concurrent recovery and branding work;
  preserve that work. This isolated branch has no configured remote.

## PWA verification notes

The focused Chromium suite covers a question arriving while work runs, opening
the room decision view, answering it, clearing attention, receiving result
evidence, accepting the exact result and encrypted recovery after reload. It also
proves a second person receives a chat message sent while the desktop work panel
is open. Existing draft/caret retention, cancellation/handoff notes, failed-send
retry and room-switching checks remain in the suite.

Creation now collapses after successful submission. Test flows that create a
second task explicitly reopen it. A missing acknowledgement preserves the form;
retry only clears the exact submitted draft and preserves a newer one.

## First PWA release

[PR #60](https://github.com/forgesworn/kithmoot/pull/60) merged as
`3b344e3c31e23019b358e2bc83c6d6acc2610755`.
[CI run 34415333345](https://github.com/forgesworn/kithmoot/actions/runs/34415333345)
passed Node 22, Node 24, Chromium, Firefox and WebKit jobs. Chromium recorded
112 passes and one skip. The deployed release is `20260909T231842Z`; HTTP SHA-256
checks matched all 24 files under the built app, and the server's current symlink
was independently checked. No Android APK was republished by the web deployment.

No live Oathrun agent migration has been performed for this delivery.

Local WebKit stalled in `BrowserContext.newPage` before app navigation. A separate
blank-page probe also failed to open within ten seconds. Use Linux CI to verify
WebKit; do not treat the local launch failure as passing browser acceptance.

## Web and Android preview release — 2026-09-10

[PR #62](https://github.com/forgesworn/kithmoot/pull/62) merged as
`c027e790effe1b1292f09fb36c6e1f8bd5593669`. All five hosted checks passed
at source head `619e421` in
[run 34421504835](https://github.com/forgesworn/kithmoot/actions/runs/34421504835).
The merged tree also retains PR #63's corrected contact-relay attribution;
seven focused Chromium assignment/contact-card tests and typecheck passed
on that merged tree before deployment.

Production release `20260910T004405Z` serves the merged code. Public HTTP hashes
matched all 24 built app files, the marketing page and the exact Android APK.
Desktop (1440 px) and phone-width (390 px) live browser checks returned HTTP 200,
rendered room entry controls and reported no page errors or horizontal overflow.
The prior web release remains available for rollback.

The Android download published with this release was `kithmoot-0.5.6-debug.apk`, version 0.5.6 (14),
SHA-256 `34a3067c25c2a111b3611e11d9e5cc5cc6b468944a7f577a12a18bfa588eacef`.
[Android PR #17](https://github.com/forgesworn/kithmoot-android/pull/17) merged
as `0289197`; its complete hosted
[verification and recovery/media suite](https://github.com/forgesworn/kithmoot-android/actions/runs/34419881451)
passed. The same artifact is available in the
[0.5.6 preview release](https://github.com/forgesworn/kithmoot-android/releases/tag/v0.5.6).
It retains the previous public preview's certificate. This is a debug-signed
preview, with no physical-device or production-store acceptance claimed.

The quiet-message dependency is now `nostr-deaddrop` 0.2.2. Its deadline timer
fixes missed random send offsets; the old once-per-slot polling phase could
repeatedly check too early. Both quiet-message delivery and assignment review
passed after consuming the published dependency fix.


## Oathrun assignment execution — local acceptance

The final reconciled implementation passed 320 Rust tests (four ignored).
The direct and isolated client checks passed identity, executable-action and
replay refusal. The final native-host journey also passed late catalogue refresh
and removal of a withdrawn action. Same-second messages are verified by their
new IDs because canonical history order uses an ID tie break.
The browser-configured route completed the encrypted room journey through a
real Rust WebSocket host and isolated containers, using synthetic principals
and a loopback model. It created exactly two jobs for one question and one
answer continuation, and waited for exact principal acceptance of the result.

The same agent’s membership in another project does not permit binding that
project’s task to this room. Stop acknowledgement requires positive execution
cleanup; cancelled flags alone are insufficient. Restart restores the encrypted
canonical journal without automatically retrying an uncertain outgoing effect.
Changed authority holds the execution for review.

The evidence and implementation are committed in the isolated Oathrun worktree;
`docs/evidence/assignment-catalogue-2026-09-10.json` records exact source hashes
and the direct-client, isolated-client and native-host results.
Oathrun has no configured Git remote, and no live agent migration has occurred.
This establishes local executor integration. The Android acceptance below is
independent; a live Android-to-Oathrun project journey remains open.


## Native shared-work candidate — 2026-09-10

[Android PR #21](https://github.com/forgesworn/kithmoot-android/pull/21),
source `8a9036ba64f67b3763ac8ba7bd2107be567b5538`, adds native assignment
verification and projection from signed TypeScript vectors, a separate encrypted
journal, explicit exact retry and the Work tab. The installed-app journey caught
and now guards against closing work on the room's initial null epoch state.
The same assignment survives real view-model publication, leaving and reopening
the room; microphone and camera remain off. Native sockets and the Android vault
also completed question, answer, exact result acceptance and recovery with no
relay history. No live model or agent was used for these Android checks.

The exact 0.5.8 (16) debug candidate passed 200 app and 147 protocol unit tests,
debug/release lint, debug/unsigned-release builds, and all 17 checks in the
recovery-emulator script. Its APK SHA-256 is
`38638bda17306207418ab688062e7875d2b44baf4097715e13a92ccac5696883`;
the existing preview certificate is retained. Source digests and test boundaries
are in the Android repository's `docs/evidence/shared-work-2026-09-10.json`.
The candidate record preceded hosted checks; the release result follows below.

[Web PR #67](https://github.com/forgesworn/kithmoot/pull/67) merged as
`2344514bcca217c731d1a4e7a53506379f33e3b4` after all five checks passed.
It fixes an invitation test that raced the intermediate admission label; durable
admission, host acknowledgement and actual entry assertions remain in place.


## Android shared-work release — 2026-09-10

[Android PR #21](https://github.com/forgesworn/kithmoot-android/pull/21) merged
as `23c88023e73c20574d2810769dd603ca7bab105c`. Both verification and the
recovery-emulator job passed in
[run 34428897674](https://github.com/forgesworn/kithmoot-android/actions/runs/34428897674).
The [0.5.8 preview](https://github.com/forgesworn/kithmoot-android/releases/tag/v0.5.8)
is published, with the recorded candidate APK and existing preview certificate.
The signed app source matches the merged tree.

[Web PR #68](https://github.com/forgesworn/kithmoot/pull/68) merged as
`cd135bd9faf57e7a299b1e9fa0c2d4c4d3db763f` after all five hosted checks passed
in [run 34428963363](https://github.com/forgesworn/kithmoot/actions/runs/34428963363).
Production release `20260910T023141Z` serves the download page and exact APK.
HTTP checks matched all 24 built app files, the page and APK. Desktop (1440 px)
and phone (390 px) browser checks rendered entry controls with no page errors
or horizontal overflow. The previous release `20260910T010811Z` is retained.
Physical-device, quiet shared work, paired-device signing and live Oathrun
pairing acceptance remain open.

## Bounded context retrieval candidate

The portable context and MCP packages prepare version 0.2.0. A call names one
explicit collection and query. The library rechecks cached grants, audience,
signatures and correction history, then returns complete records within a
compact JSON byte budget. Exact shared sources and explicit signed-record
references may add one-hop neighbours. It does not follow URLs, traverse another
collection, persist a plaintext index or treat records as execution authority.
Remote grant changes still depend on importing a newer authorised snapshot;
already downloaded copies cannot be recalled.

Typecheck, all 1,556 tests, and independently installed Node/browser/CLI package
consumers passed. Tests include scope and expiry refusal after successful reads,
superseded records, source revision boundaries, one-hop expansion and complete
UTF-8 payload limits. This is lexical retrieval with provenance links; no
repository crawler, semantic extraction, embedding model or measured real-task
token savings are claimed. Oathrun adoption and live outcome acceptance remain
separate work. The signed v1 collection format remains unchanged.

## Bounded context source release and executor adoption

[PR #69](https://github.com/forgesworn/kithmoot/pull/69) merged as
`7d5f68c9dd1e9543446a6dc4b1ad06c692d27bf0` after all five checks passed in
[run 34430040944](https://github.com/forgesworn/kithmoot/actions/runs/34430040944).
Production release `20260910T025239Z` passed 26 public HTTP hash comparisons
(app, marketing page and existing Android APK), plus desktop and phone-width
rendering with no page errors or overflow. The previous `023141Z` release is
retained. npm publishing of the independently verified 0.2.0 tarballs returned
`EOTP`; neither package is claimed published. Source deployment and package
registry publication are separate states.

Oathrun's signed-context broker now accepts optional bounded retrieval under
the existing project-bound `context.read` permission and one request reservation.
It validates the complete byte-limited result, provenance and returned links,
and rechecks authority after container execution. The reconciled branch passed
336 Rust tests (four ignored), the seven-stage native context journey and the
26-check native room/assignment journey. In-flight grant and identity revocation
remain enforced. The duplicate-file-descriptor state-lock regression failed
before the explicit lock-release fix and passes with it.

Exact source digests and reconciliation results are in Oathrun's
`docs/evidence/bounded-context-retrieval-2026-09-10.json`. These tests use synthetic
principals and a local container image; live agent migration, physical-phone
acceptance and real-task cost reduction remain open.

## Shared project directory candidate — 2026-09-10

The PWA now supports owner-signed project identities, explicit people/agent lists,
persistent room selections and separately signed personal joins. Joined projects
appear in home, room switching and desktop navigation; same-named projects remain
distinct. A received directory does not automatically admit a room or launch work.
The [wire, recovery and authority contract](shared-projects.md) describes exact
limits and the remaining Oathrun and native Android integration.

The candidate is based on main `a4ea229`, retaining the merged box discovery and
cryptographic timing changes. All 1,671 unit tests in 106 files, typecheck and the
production build passed. Twenty-seven Chromium account, workspace and room-switching
checks passed. A further focused browser run verified stale invitation refusal,
rename propagation and keyboard focus retention in the three-project journey.
Both phone-width project management and desktop project navigation were rendered
and inspected. Tests use synthetic accounts, local relays and real persistent
room admission; they are not physical-phone or live-agent acceptance.

Signed-record tests reject forged/cached-verdict events, unexpected fields, wrong
recipients and temporary, pairing or legacy traffic-key links. Recovery checks
cover encrypted caches without relay history, competing owner revisions, preserved
withdrawal notices, member re-addition, archive/restore authority, exact retry
receipts, failed storage and closure while signing. Invalid changes are rejected
before invoking the external signer. Normal navigation retains keyboard focus
through background directory updates.

This records local candidate verification. Hosted checks, merge and production
activation are separate release evidence. The full G9 and G1–G8 gates remain open.
