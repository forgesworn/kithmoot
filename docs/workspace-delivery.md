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
| Oathrun assignment execution | Existing assignment protocol/journal and Oathrun room route audited. Isolated runtime worktree created. | Canonical assignment claim, progress, question/answer, stop acknowledgement, result and exact acceptance; task-bound authority; restart/uncertain-effect handling; live supported host. |
| Minimal supervision | Oathrun profiles, grants, budgets and same-task continuation exist. | Reusable setup; bounded routine reporting, continuation and delegation; demonstrate fewer avoidable interventions without broadening authority. |
| Native Android | PR #17 merged; complete hosted CI passed. The 0.5.6 (14) debug preview is published on GitHub and the public site with its verified existing preview certificate. Primary chat, Call tab and draft/search/reading-position retention are included. | Agent/work/approval controls, same assignment contract, physical-device and locked-phone acceptance. |
| Context and efficiency | Signed context collections, scoped verification, literal retrieval, cache controls and usage accounting. | Relevant project retrieval and graph links, freshness/corrections, cross-project denial tests and cost per accepted outcome. |
| Calls and temporary meetings | Existing media/transcript/agent controls; G7/G8 retained. | Daily call-to-assignment acceptance, platform parity; separate temporary identity/retention/teardown mode and fail-closed masking. |

## Work locations

- PWA: `kithmoot` checkout; first slice merged into main as `3b344e3`.
  Further integration work continues on `feat/workspace-execution`.
- Android: sibling `.workspace-delivery/kithmoot-android` worktree,
  branch `feat/chat-workspace`, merged PR #17, source head `f80be80`;
  main merge `0289197`.
- Oathrun integration: sibling `.workspace-delivery/oathrun` worktree,
  branch `feat/kithmoot-assignment-delivery`, based on `d3e39be`; durable bridge commit `6bd6a0d`,
  recovery and immutable-digest improvement `9fd465c`.
  The original Oathrun checkout contains concurrent recovery and branding work;
  preserve that work and reconcile the integration before merging.

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

The public Android download is `kithmoot-0.5.6-debug.apk`, version 0.5.6 (14),
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
