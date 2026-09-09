# Workspace delivery

Started 2026-09-09; continued 2026-09-10. The active objective is to deliver the
chat-focused desktop and Android workspace with minimal agent supervision,
Oathrun execution, scoped useful memory and efficient token use. The
[product goals](product-goals.md) and [initial audit](workspace-capability-audit.md)
retain the complete requirements. An individual slice is not completion.

## Acceptance ledger

| Deliverable | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Conversation and decisions | PWA work drawer, phone work screen, room attention card, needs-you filter, compact result review implemented on `feat/agent-workspace-delivery`. Type checking, 12 Chromium work/workspace tests and five Firefox work tests pass. | Linux WebKit, release/CI/live proof, authorised cross-project attention. |
| Shared projects | Existing device-local room labels and preserved drafts. | Synced project model mapped to Oathrun authority, overlapping memberships and device continuity. |
| Oathrun assignment execution | Existing assignment protocol/journal and Oathrun room route audited. Isolated runtime worktree created. | Canonical assignment claim, progress, question/answer, stop acknowledgement, result and exact acceptance; task-bound authority; restart/uncertain-effect handling; live supported host. |
| Minimal supervision | Oathrun profiles, grants, budgets and same-task continuation exist. | Reusable setup; bounded routine reporting, continuation and delegation; demonstrate fewer avoidable interventions without broadening authority. |
| Native Android | Existing rooms, chat/calls and agent media controls. | Primary chat layout, agent/work/approval controls, same assignment contract, physical-device and locked-phone acceptance. |
| Context and efficiency | Signed context collections, scoped verification, literal retrieval, cache controls and usage accounting. | Relevant project retrieval and graph links, freshness/corrections, cross-project denial tests and cost per accepted outcome. |
| Calls and temporary meetings | Existing media/transcript/agent controls; G7/G8 retained. | Daily call-to-assignment acceptance, platform parity; separate temporary identity/retention/teardown mode and fail-closed masking. |

## Work locations

- PWA: `kithmoot` checkout, branch
  `feat/agent-workspace-delivery`.
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

No live agent migration or deployment has yet been performed for this delivery.

Local WebKit stalled in `BrowserContext.newPage` before app navigation. A separate
blank-page probe also failed to open within ten seconds. Use Linux CI to verify
WebKit; do not treat the local launch failure as passing browser acceptance.
