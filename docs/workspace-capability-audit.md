# Workspace and agent supervision capability audit

Recorded 2026-09-09. This is a source and focused test audit, not a declaration
of production acceptance for the combined system.

## Finding

Much of the required foundation already exists. The PWA needs a more coherent
interface over implemented capabilities, while Android parity, Oathrun assignment
execution, shared project mapping and graph retrieval require functional work.
The desired outcome is fewer human interventions per accepted result. Merely
making every agent session easier to watch would not establish that outcome.

Revisions inspected:

- KithMoot: `fc1b74ae9a397107d16b6421ff29e94c92faec06`, with local product-goal edits.
- KithMoot Android: `32c1b1d499e933314e64351e4866ec0f620a690b`.
- Oathrun: `ad4f26be4b5b4a3d0392f9aea589ecab3ac1ff2d`; checkout under active
  development, read only during this audit. Its recorded acceptance is separate
  from the KithMoot tests rerun here.
- T3 Code reference checkout: `383cc40f4d5d9f61d47b3caa28fac839a8b9c433`.
  Source/docs inspected; its application was not installed or runtime-tested.

## Implemented foundations and remaining work

| Need | Current implementation | Remaining work |
| --- | --- | --- |
| Shared human/agent work | KithMoot has assignment creation, named owners, action inputs, claims, progress, questions/answers, result evidence, exact-result acceptance/rejection, cancellation and handoff. Den links the same assignment into private attention. | Surface the existing model in conversation and across projects. Preserve one canonical assignment history. |
| Launch and execute agents | Host catalogues advertise agents/actions; the PWA can invite and assign. Tool workers have guarded assignment claiming and durable execution journals. | Built-in text-only brains do not automatically execute assignments. Compose reusable profiles and supported workers into a simple start flow. |
| Multi-project workspace | Desktop/mobile room navigation, project filters, drafts and reading positions exist. | KithMoot project labels are device-local organisation, not shared project membership or Oathrun project authority. Define and sync an explicit mapping. |
| Runtime and permissions | Oathrun implements project-bound tasks, separate agent/project policies, classified context, explicit sharing, budgets, plugin jobs and schedules. | Its operator console is not a project-scoped multi-user workspace. Live agent migration and isolated deployment acceptance remain open. |
| KithMoot-to-Oathrun work | Oathrun routes authorised fresh addressed chat/directives to pinned plugins and produces reviewable reply drafts. | Assignment events explicitly do not start jobs. Native conversation continuation is not automated by the room route. Bridge the canonical assignment lifecycle, stop acknowledgement and result evidence. |
| Low interruption operation | Scoped grants, reviewed task profiles and bounded same-task continuation exist. | Automatic cross-profile delegation/fallback is not established. Each outgoing Oathrun room draft currently needs exact approval; agree bounded routine reporting authority and lifecycle renewal before claiming unattended collaboration. |
| Useful memory | Signed encrypted collections, provenance, scoped grants, literal search and agent prefetch exist. Oathrun verifies/imports the same protocol through its context adapter. | No repository crawler, graph extraction or graph/vector retrieval in this context implementation. Add a permission-enforced derived index with freshness and correction rules. |
| Token efficiency | Oathrun implements reviewed model candidates, scoped cache prefixes, input limits and input/output/cache usage accounting. | Demonstrate savings per accepted task on real workloads. Automatic quality-driven escalation is not proved. |
| Native Android | Rooms, project labels, chat, calls and per-participant agent media access exist. | No native assignment Work cards, agent catalogue or approval workflow found. Chat is currently a sheet off the room/call screen. This needs implementation as well as layout changes. |

Primary local evidence:

- [Shared assignment contract and execution limits](den-assignments.md),
  [PWA panel](../app/src/assignment-panel.ts),
  [assignment model](../src/assignments.ts),
  [durable execution](../src/node/assignment-execution.ts).
- [Local project labels](../app/src/room-projects.ts),
  [hosted agents and media/approval controls](agents.md),
  [context and explicit current limits](context.md#current-limits).
- Oathrun sibling checkout: `docs/PROJECT-SCOPES.md`, `docs/ROOM-ROUTING.md`,
  `docs/ROOM-APPROVALS.md`, `docs/AGENT-POLICIES.md`, `docs/SCHEDULES.md`,
  `docs/CONTEXT.md`, `docs/PROMPT-EFFICIENCY.md`, `docs/MIGRATION-READINESS.md`;
  implementation includes `src/projects.rs`, `src/room_routing.rs`,
  `src/room_approvals.rs` and `src/context.rs`.
- Android sibling checkout: `ui/start/StartScreen.kt`, `storage/SavedRoom.kt`,
  `ui/KithMootApp.kt`, `ui/RoomViewModel.kt` and `session/RoomSession.kt`, under
  `app/src/main/kotlin/dev/forgesworn/kithmoot/`.

## What T3 Code contributes to the comparison

T3 Code is directly relevant to controlling agents on a computer from desktop,
web and mobile clients. Its focus is agent harness control; our required journey
also includes shared human conversation, calls and project-scoped collaboration.
[Repository](https://github.com/pingdotgg/t3code).

Patterns to adapt to our existing models:

1. **Retain deliberate choices.** New threads inherit project/model/mode and
   workspace defaults, and can start in the background while another draft opens.
   For KithMoot, reuse a project's authorised agent profile and task template.
   [Thread flows](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/user/thread-sidebar.md).
2. **Make setup remember the work environment.** The welcome flow checks selected
   computers and agents, offers project import and permits continuing without it.
   Our equivalent should pair a host and deliberately map selected projects and
   context; importing conversation history needs explicit classification.
   [Welcome flow](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/user/welcome-wizard.md).
3. **Put permissions in task context.** T3 exposes thread permission modes and
   inline decisions. We should expose Oathrun's bounded authority understandably;
   its default Full access is not a substitute for multi-person project policy.
   [Permission modes](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/user/permission-modes.md).
4. **Continue the same work from a phone.** T3 documents persistent device pairing,
   remote environments and notifications that open the relevant thread. Its
   background mobile push depends on T3 Connect; direct pairing alone does not
   provide it. Our mobile acceptance must establish its own delivery route.
   [Remote access](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/user/remote-access.md),
   [notifications](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/user/mobile-notifications.md).
5. **Share connection semantics across clients.** T3 keeps execution on the host,
   normalises provider events and shares client runtime state. Durable command
   acknowledgement is separate from side-effect completion. Reuse our journals
   and protocol, and test equivalent Android behaviour against those contracts.
   [Architecture](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/docs/internals/overview.md).
6. **Distinguish activity from attention.** The sidebar resolver prioritises
   pending approval and input, then running work, failures and background activity.
   Unread state is separate. KithMoot should similarly derive attention from work
   state rather than using agent presence or unread chat as a proxy.
   [Status implementation](https://github.com/pingdotgg/t3code/blob/383cc40f4d5d9f61d47b3caa28fac839a8b9c433/apps/web/src/components/Sidebar.logic.ts#L783).

These are recommendations inferred from inspected source and documentation,
not measured proof that T3 reduces supervision or supplies our memory model.

### Refreshed comparison — 2026-09-10

Reviewed T3 Code's current source and documentation at
`b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835`. This remains a source review;
the T3 clients have not been installed or tested here. The findings reinforce
the existing delivery direction rather than establish another task system.

| Pattern to adapt | KithMoot / Oathrun acceptance |
| --- | --- |
| Separate approval, input, working, monitoring, failure and unread state. | Routine agent activity stays quiet. A project decision shows its question, recommendation, evidence and consequences; answering it clears the same decision on every authorised device. Unread human chat remains independently visible. |
| Remember project and execution defaults; keep thread order stable across devices. | Starting another assignment reuses the explicitly authorised project profile. Switching projects or devices preserves drafts, reading positions and work identity without importing unrelated history. |
| Keep execution on the host while clients reconnect. | Close the desktop, continue from Android and return to the same assignment and attempt. A lost acknowledgement or host restart cannot duplicate work or imply that an external effect completed. |
| Open the relevant thread from a mobile alert. | A locked-phone decision alert opens the exact current assignment. Suppress resolved or revoked decisions and duplicate alerts; ordinary progress does not interrupt. Prove the actual push route on a physical device. |
| Settle inactive work without destroying its conversation. | Keep the active workspace small while preserving recoverable history and result evidence. A stopped agent or merged PR alone cannot mark the canonical assignment accepted. |

Sources: [status resolver](https://github.com/pingdotgg/t3code/blob/b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835/apps/web/src/components/Sidebar.logic.ts#L784),
[thread behaviour](https://github.com/pingdotgg/t3code/blob/b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835/docs/user/thread-sidebar.md),
[project settings](https://github.com/pingdotgg/t3code/blob/b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835/docs/user/project-settings.md),
[architecture](https://github.com/pingdotgg/t3code/blob/b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835/docs/internals/overview.md),
[mobile notifications](https://github.com/pingdotgg/t3code/blob/b7b3ef1e6fcb5c22a9790d2578fe8af7ce396835/docs/user/mobile-notifications.md).

T3's documented background mobile notifications depend on T3 Connect, with
Google Play services required on Android. Direct pairing or Tailscale alone
does not provide that delivery. Its documented Full access default is also
not our multi-person authority model: retain project-bound mandates, budgets
and explicit revocable context grants. These are product integration choices,
not reasons to discard its useful interaction patterns.

Herdr provides a complementary runtime reference: persistent terminals,
several machines in one view and working/blocked/idle visibility.
[Herdr repository](https://github.com/herdrdev/herdr). The inspected material
does not substantiate the suggested funding amount. Neither comparison proves
our shared human collaboration, daily call-to-task flow, temporary meeting
cleanup or graph retrieval. The primary measure remains human minutes and
avoidable interventions per accepted outcome.

## UX evidence

Current browser test screenshots show working shared assignments at desktop and
phone widths. The Work modal mixes creation, result review and management in a
long scrolling surface; raw result identifiers receive prominent space. A person
reviewing a result must navigate this surface rather than receive a concise
decision with its evidence and the relevant action. This is a concrete UX issue
over functionality that is already implemented.

Keep conversation primary. Present a compact result or decision in context, with
technical evidence and management controls available on demand. Reuse the same
next-action projection for an authorised cross-project inbox. Routine status
should not compete with human messages or generate a decision notification.

## Verification performed

Using Node 24 in the KithMoot checkout:

```sh
npm test -- src/assignments.test.ts src/assignment-log.test.ts src/den-client.test.ts src/node/assignment-execution.test.ts src/node/host.test.ts src/approval.test.ts app/src/room-projects.test.ts --maxWorkers=2
E2E_RELAYS=local npx playwright test test/assignments.spec.ts test/workspace.spec.ts --project=chromium
```

- 38 tests passed across seven unit/integration test files.
- 12 Chromium browser tests passed, including two-person shared work, phone-width
  question/answer/review/reload, advertised-agent assignment, project grouping,
  room switching, drafts, unread/read positions and keyboard operation.
- Inspected generated `shared-work-light-1440.png` and
  `assignment-review-phone.png` screenshots in local `test-results/`.

These runs use local relays and synthetic participants. They do not establish
physical Android parity, background mobile push, live Oathrun execution or live
agent migration. No runtime code, deployment or running agent was changed.

## Delivery order

1. Simplify the existing PWA assignment/review surface and reuse Den's attention
   semantics. Define shared project mapping to Oathrun authority.
2. Connect one authorised assignment through Oathrun execution, progress, a real
   decision, result and acceptance. Prove browser closure and recovery without
   duplicate effects; explicitly handle routine reporting authority.
3. Implement the same conversation/work/decision journey in native Android and
   prove desktop-to-phone continuity and locked-phone delivery on a real device.
4. Add reusable agent setup and bounded continuation/delegation policies; measure
   human intervention and accepted outcomes against the previous workflow.
5. Extend scoped memory retrieval and evaluate graph links where they improve
   correctness or reduce repeated context work. Measure tokens and total cost
   per accepted task, including retries and human review.

Daily calls feed this existing assignment model. Temporary anonymous meetings
remain a separate lifecycle goal: neither this audit nor a more polished UI
establishes automatic erasure or fail-closed voice masking.
