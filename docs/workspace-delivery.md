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
| Native Android | PR #17 implements primary chat, separate Call tab, draft/search/reading-position retention. Android 15 emulator workspace and chat/media regression tests passed. | CI/merge/release for PR #17; agent/work/approval controls, same assignment contract, physical-device and locked-phone acceptance. |
| Context and efficiency | Signed context collections, scoped verification, literal retrieval, cache controls and usage accounting. | Relevant project retrieval and graph links, freshness/corrections, cross-project denial tests and cost per accepted outcome. |
| Calls and temporary meetings | Existing media/transcript/agent controls; G7/G8 retained. | Daily call-to-assignment acceptance, platform parity; separate temporary identity/retention/teardown mode and fail-closed masking. |

## Work locations

- PWA: `kithmoot` checkout; first slice merged into main as `3b344e3`.
  Further integration work continues on `feat/workspace-runtime`.
- Android: sibling `.workspace-delivery/kithmoot-android` worktree,
  branch `feat/chat-workspace`, PR #17, head `9dbf037`.
- Oathrun integration: sibling `.workspace-delivery/oathrun` worktree,
  branch `feat/kithmoot-assignment-delivery`, based on `1f38f1b`.
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
