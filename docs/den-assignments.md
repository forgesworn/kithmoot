# Den and KithMoot assignments

Status: implemented and verified locally, within the supported limits below.
Deployment and store distribution are separate from this development goal.

Den owns private tasks and personal attention. KithMoot owns the shared room
conversation. A shared assignment has one stable ID and an authenticated event
history. Den stores a private link to that ID, not a second editable shared task.
Only a previewed objective, acceptance criteria and explicitly supplied action
inputs leave Den. Notes, task IDs, focus records and other tasks are not shared.

The canonical protocol and client live in KithMoot. Den consumes a versioned,
reproducible browser bundle through its existing TypeScript engine, on web and
native hosts. Dart presents projections; it does not implement another reducer.

## Authority and execution

The creator chooses a named owner and remains responsible for accepting the
result. Owners report progress, questions, results and stopped execution. A
result is pending review until its exact event ID is accepted. Rejection creates
a new attempt; old approvals never accept a revised result.

Each operation names its predecessor. Duplicate operations are harmless;
missing predecessors remain pending. Conflicting valid successors stop the
assignment for reconciliation rather than choosing a winner that may already
have executed. Only the designated owner may claim an attempt. A durable worker
journal holds the execution identity before work starts. A restarted worker
checks that journal and its live process handle; it does not restart uncertain
work. There is no timeout-based takeover.

Cancellation and handoff first request a stop. A replacement owner is assigned
only after the old owner confirms stopped execution. A request for cancellation
is not displayed as confirmed cancellation. Agent action discovery confers no
new authority: existing principal/admin approval and host policies still apply.

All assignment content, actor references, action inputs and result evidence ride
inside room encryption. The relay-visible event must not advertise task IDs,
goals, owners, budgets or state. Local caches and replayed operations must retain
authentication and must fail visibly on storage, history or validation failure.

## Acceptance ledger

- [x] Shared authenticated model: creation, claim, progress, blocker, answer,
      result, exact-result acceptance/rejection, cancellation and handoff.
- [x] Durable transport/cache and retry identity; retained-history reconnect and
      restart. Missing predecessors prevent decisions; see recovery limits below.
- [x] Agent catalogue actions and input validation, runtime/MCP integration,
      durable execution journal and permission checks.
- [x] KithMoot assignment cards and human controls.
- [x] Den explicit room/agent selection, sharing preview and persistent link.
- [x] Den next-action projection through its existing inbox/shortlist.
- [x] End-to-end execution and review using the actual clients and local relay.
- [x] Blocker, handoff, cancellation, rejection, restart, duplicate and conflicting
      claim verification; privacy and unauthorised-update tests.
- [x] Responsive interactive verification and affected native-client checks.
- [x] Final architecture/user documentation and evidence with limitations.

Agent wallets, funding and general project management are outside this work.
Deployment and store distribution require their own release evidence.

## Using the flow

In Den, open **The list**, use the task menu and choose **Share with a room**.
Connect an invitation deliberately, select the room and owner, then choose an
advertised action if available. Edit the objective and acceptance criteria and
provide any required inputs. **Preview sharing** shows the complete projection;
**Share this assignment** saves the private pointer before publishing anything.
The original task appears under **With the room** while waiting. It returns to
the inbox when an answer or review is needed and still follows Den's three-item
shortlist limit. A focus session ending cannot accept an agent's result.

KithMoot's **Work** button opens the same assignment cards. Owners can claim,
report progress, ask a question, provide result evidence and confirm stopped
execution. The creator answers, accepts the exact displayed result, requests
changes, cancels or hands work over. Rejection advances the attempt while keeping
the assignment ID and history. Handoff advances the attempt only after stopped
execution is confirmed. Den also exposes the creator's decisions on its linked
task; accepting marks that same private task done.

## Implementation boundaries

`src/assignments.ts` owns schema validation and deterministic projection.
`src/assignment-log.ts` owns authenticated history and the durable outbox.
`src/den-client.ts` owns room connections, catalogue discovery and the JSON
boundary consumed by Vitark's existing engine. The vendored bundle is generated
with `node tool/bundle-den.mjs <vitark>/packages/vitark_engine/ts/vendor/kithmoot/den-client.mjs`.
Its manifest records the bundle and every source/dependency hash. Dart stores a
private link and displays this projection; there is no second Dart reducer.

Signed assignment events are inner statements only, carried in encrypted room
chat envelopes on a derived assignment channel. They use a separate retained
history query rather than the chat window's message/time limit. The envelope's
participant and device must match the inner author and device. Ownership and
state transitions are checked again during projection. Unknown operation fields,
including private Den fields, are refused. Room content and cached history are
encrypted; Node's private execution journal contains identifiers/process state,
not objectives or result text. Relay timing and traffic volume remain visible.

Browser writers use a lifetime Web Lock; Node writers use an OS-released SQLite
transaction lock and atomic, synced file replacement. A claim reserves an attempt
on disk before publication. Automated claims also bind to one designated device,
so two installations sharing a participant identity do not both receive execution
authority. This is not a distributed exactly-once guarantee for arbitrary external
services: the tool driver must obey `start`, persist its external job handles and
retain normal side-effect approvals.

## Agent integration and recovery

Node 22.13 or later is required; verification uses Node 24. An agent host can
advertise `actions` with an ID, label, description and up to eight named string
inputs with required flags. The CLI receives that catalogue through
`KITHMOOT_ASSIGNMENT_ACTIONS`. Discovery does not grant execution permissions.
Claims from the attested principal or an announced room admin use existing
authority; other creators require an explicit decision through the existing
approval channel. Spending, publishing and other consequential actions keep
their separate approval rules.

Tool-driven workers use `assignment_list`, `assignment_claim`,
`assignment_report`, `assignment_execution`, `assignment_wait` and
`assignment_retry` through MCP. Stdio exposes the corresponding assignment
commands. Only `assignment_claim` returning `start: true` allows a driver to
begin that attempt. Repeated calls return `start: false` or an inspection error.
Built-in text-only model brains do not automatically execute these assignments;
a worker must integrate these tools and monitor stop requests.

After an ambiguous send, retry the saved operation with the same request ID;
never repeat the external action. After a worker crash, inspect its durable
journal, original process and any detached/external jobs. A missing process alone
does not permit a restart. The creator first requests a stop for cancellation or
handoff. `assignment_recover_stopped` then requires the original journal, an
absent original process and an authenticated principal/admin confirmation that
all external work has stopped. Only then can a new attempt be assigned. A live
or unknown process, missing journal or changed assignment prevents recovery.

## Supported recovery limits

- Retained relay history and the existing encrypted cache support reconnects,
  restarts and acknowledgement-loss retries. A relay can omit history; EOSE is
  not a retention guarantee. Missing predecessors pause decisions. Keep the
  existing task link and restore its history rather than creating replacement
  work to bypass uncertainty.
- Cached history survives a room epoch change. A fresh device joining after a
  key rotation cannot fetch historical epochs through this adapter yet. There is
  no archive exchange or cache export/import UI in this change.
- Competing valid branches remain visible as conflicted and halt updates. There
  is no automatic branch reconciliation or forced takeover. Check and stop the
  original execution before any manual investigation. Missing history currently
  pauses the entire room's assignment log, including unrelated assignments.
- Storage caps are 20,000 history events, 100 pending sends and 30 Den room
  connections. Capacity/storage failures surface errors. This does not provide
  an archival service or recover work after all history and journals are lost.
- Den's room credentials are derived from its existing sync identity. Existing
  Den sync alone does not transfer room invitations/history to another install;
  connect that install deliberately. Participant-signing credentials are needed
  to write assignments; a KithMoot device with only a paired device credential
  cannot author these inner statements. Cloning a live installation's private
  keys and journal is unsupported.
- There is no Den disconnect/forget-room control yet. Changing Den's identity
  closes the existing work client. Native integration uses the existing Android/
  iOS engine host; macOS native hosting and physical Android/iPhone acceptance
  are outside the verified evidence below.

## Verification evidence

Verified locally on 7 September 2026 using isolated room identities and relays;
no production room, personal task collection or external job service was used.

| Check | Evidence |
| --- | --- |
| KithMoot types and unit/integration suite | `npm run typecheck`; `npm test`: 1,377 tests passed across 83 files |
| Auth, privacy, replay and ownership | `src/assignments.test.ts`, `src/assignment-log.test.ts`; modified/wrong-room statements, extra private fields, unauthorised actions, exact-result review and lost-acknowledgement retry |
| Actual local agent action | `src/den-client.test.ts`: writes an artifact and digest once, returns it to Den, accepts the same result; also blocker/rejection/handoff/cancel and principal-confirmed recovery |
| Process crash and concurrent execution | `src/node/assignment-execution.test.ts`: killed child releases its cache lock while its execution reservation remains; second writer/reservation refused; two installation binding and concurrent claims in `src/den-client.test.ts` |
| KithMoot responsive UI | `test/assignments.spec.ts` at 390px: Chromium/Firefox on the local Mac and WebKit on macOS 26; exact review, blocker answer and encrypted reload |
| Vitark engine | 309 passed, 5 live-service tests skipped; generated bundle integrity covered |
| Den core and app | Core 207 passed; full Den suite 400 passed, 32 skipped; final focused shared-work suite has eight passing tests, including the additional failed-restoration cleanup regression |
| Native engine lifecycle | Seven RPC tests passed, including closing while WebView delivery is pending |
| Native Den | Debug simulator build and actual iOS WebView room-sharing smoke test passed on an isolated iPhone 17 Pro simulator; this is not physical-device or store proof |
| Den web build and static analysis | Release web build passed; `flutter analyze` reports no issues |
| Compiled Den and KithMoot together | `DEN_BASE_URL=http://127.0.0.1:4280 npx playwright test test/den-journey.spec.ts --project=chromium`: passed; explicit preview, bound agent execution, saved artifact/digest, matching room card/result ID, Den inbox review, acceptance and restored final state |

The compiled-browser test saves `den-sharing-preview.png`,
`den-result-review.png` and `den-accepted-after-reload.png` in its Playwright
output directory. These were visually inspected after route animations settled.
The native smoke test was repeated successfully after the final lifecycle fix.
