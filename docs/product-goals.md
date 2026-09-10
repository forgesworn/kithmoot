# KithMoot product goals

Recorded 2026-09-09. These are accepted product goals; all remain open.
Individual foundations already exist, but none of the complete journeys below
is declared finished by this document.

The [capability audit](workspace-capability-audit.md) records implemented work,
remaining integrations and the T3 Code comparison. These goals extend the
existing assignment, Den attention, agent-host and scoped-context models.

## The need

One person runs several projects with overlapping groups of people and agents.
They need one chat-focused workspace to organise those projects, collaborate,
make decisions and direct agent work from a desktop or a phone while away.
The same person or agent can participate in several projects with different
colleagues, roles and permissions in each.

The primary outcome is less time directing agents. People should spend their
time communicating and collaborating with people, delegating outcomes once,
and making decisions that need their judgement. Agents should retrieve relevant
authorised context, coordinate routine work and verify results within agreed
authority, without repeatedly asking for instructions already given.

KithMoot is the everyday interface for this work: conversations, daily calls,
agent requests, task control and results. Routine remote operation must not
require opening a separate Claude or Codex remote-control interface, terminal,
SSH client or remote desktop. Agents execute on connected hosts; KithMoot
provides the authenticated, permissioned controls and visibility.

The browser experience and Android app should expose the same project and
work model, with layouts suited to desktop and touch. Supporting services and
data may live on hardware the person owns. Browser messaging, home deployment
and access to contacts already using WhatsApp, Signal or Telegram remain
supporting goals; access to those external networks is a separate integration,
not satisfied merely by sending a KithMoot invitation.

## Primary experiences — clarified 2026-09-09

Projects organise the primary experience: everyday chat among their people
and agents. Human principals also hold daily
video calls with agents listening, transcribing and taking assigned work away
to execute asynchronously. Alongside that persistent workspace, people need
anonymous temporary meetings reached through a link shared in Signal or a
similar service, with video, voice masking, chat and screen sharing.

These are distinct room experiences with visible retention rules:

| | Workspace room | Temporary meeting |
| --- | --- | --- |
| Entrance | Return to a project and its conversations | Open a shared link and check devices/privacy before joining |
| Main surface | Conversation and composer; calls open alongside chat | Meeting stage; chat and screen sharing remain easy to reach |
| Identity | Continuing membership, human principals and attributed agents | Fresh meeting identity; no account or existing profile required |
| Agent work | Visible listening, transcript, decisions and delegated tasks | Proposed default: agents, transcripts and retained tasks disabled |
| After departure | Conversation and authorised agent work continue | Automatic room closure and application-managed cleanup |

“Public” here means joinable by people holding the shared link. Searchable
public discovery is not implied. “Offline tasks” means asynchronous work after
the people leave the call; operation without network connectivity is a
separate capability.

Use clear entry actions such as **Start a conversation** and **Start a temporary
meeting**, with matching terms and behaviour in the PWA and Android app. Room
mode must be visible before joining. A temporary meeting must not silently
become a saved workspace or acquire transcript/archive retention.

## G1 — Everyday messaging from a phone browser

Complete the ordinary messaging journey without requiring a native KithMoot
app, a phone number, a paid account or a desktop computer.

Acceptance:

- On physical iPhone and Android devices, open an invitation, establish a
  recoverable identity, send and receive direct and group messages, share and
  retrieve encrypted files, and make and answer voice/video calls.
- Reopen after browser suspension, a device restart and a Wi-Fi/mobile-data
  change without losing membership or acknowledged messages. Pending and
  failed sends remain visible and retry without duplicate messages.
- Recover on a replacement device using an explicitly saved recovery method;
  explain what cannot be recovered when the person has not saved one.
- Document any browser permission or home-screen installation requirement per
  feature. A required external signer app must not be hidden inside a claim
  that no native app is needed.

## G2 — Notifications while the phone is in a pocket

Deliver useful message and incoming-call alerts when the conversation is not
open, with explicit consent and control over what a lock screen reveals.

Acceptance:

- Demonstrate delivery on physical iOS and Android devices while locked and
  with the app closed, recording the browser/OS versions, installation mode,
  latency and any platform-imposed limits separately.
- Opening a message alert reaches the correct conversation and catches up;
  answering a supported call alert joins the intended call. Expired calls
  become missed calls rather than invitations to a dead session.
- Exercise denied/revoked permission, expired subscriptions, offline delivery,
  duplicate alerts, mute settings and notification-host replacement.
- Keep message contents and room keys out of push infrastructure. Disclose
  remaining metadata and any browser/OS push-provider dependency. An owned
  nudger alone is not proof of independence from platform push services.

This extends the existing M5 optional nudger direction. Open-tab notifications
or a Nostr nudge alone do not close this goal.

## G3 — Durable history and useful search

Let a person find and recover their conversations beyond the current
30-day/500-message client window, using an optional encrypted archive.

Acceptance:

- Recover and search a conversation older than 90 days containing more than
  500 messages on a fresh browser, including replies and file references.
- Verify archive data before use and enforce membership/epoch access rules;
  a storage host must not receive plaintext messages or room keys.
- Restore after loss of an archive node from an independently held copy,
  retrieve referenced file bytes, and identify incomplete history honestly.
- Provide understandable retention, export, recovery and local cache controls;
  distinguish local deletion from deletion of copies held by other parties.

This extends M3. Bothy is the preferred optional archive host; a Bothy mailbox
with bounded retention is not by itself a durable KithMoot archive.

## G4 — An integrated home messaging setup

Offer a documented setup that brings KithMoot, Bothy and Wildbloom storage
together on hardware the person controls. Include an Umbrel installation path
alongside a standalone Linux path, with explicit supported hardware and versions.

Acceptance:

- From a clean supported machine, install, pair a phone, create a conversation,
  store an encrypted attachment on owned storage and retrieve it from another
  member's device. Show which services and copies are actually in use.
- Repeat away from home over mobile data, with no manual router changes on the
  default supported path. Record any public relay, reachability, HTTPS or push
  dependency rather than describing the deployment as entirely local.
- Demonstrate restart, upgrade, rollback, backup and restoration on a replacement
  host. Archive and notification integration must meet G2 and G3, not merely
  start their processes successfully.
- Replace each configured service without changing the person's identity or
  losing access to recoverable conversations. Hosted and independently operated
  alternatives remain usable; Bothy is never mandatory for joining a room.

Wildbloom supplies encrypted file delivery and owned Blossom storage; Bothy
supplies the personal shelter and planned archive/nudger integration. This is
an integration goal, not a claim that the complete appliance exists today.

## G5 — Existing conversations from one browser surface

Enable a person to retain conversations with WhatsApp, Signal and Telegram
contacts through an optional integration they operate. Those contacts should
not have to move to KithMoot to satisfy this goal.

Acceptance and feasibility gates, tracked separately for each service:

- Establish the supported integration route, account/number requirements,
  primary-device obligations and service terms from current primary sources
  before choosing an implementation. Record restrictions and unsupported
  features; usernames alone are not evidence of phone independence.
- Prove bidirectional text and attachment delivery with a real consenting
  contact, then exercise relinking, restart, offline catch-up and disconnect.
  Show feature support, including calls, per service instead of implying parity.
- Keep credentials and sessions on the explicitly chosen host. Explain where
  messages are decrypted and who can read them: a connector that sees plaintext
  changes the end-to-end encryption boundary.
- Make each connector opt-in, isolated and revocable. Its failure must not
  interrupt native KithMoot rooms. Existing networks remain external services
  even when their clients or connectors run at home.

A feasibility report is the first deliverable, not completion of this goal.
If a service prevents the intended journey, retain that service as blocked
with evidence and an explicit limitation; an invitation link is not a bridge.

## G6 — A clear option for keeping messaging execution at home

Serve people who want the messaging client and persistent decrypted state on
their home machine, beyond simply avoiding a native phone app.

Acceptance:

- Define and prototype an explicit home-execution mode, then verify what
  executes and persists on the home host and phone. Screen display and input
  still expose content to the phone; promise no stronger boundary than measured.
- Demonstrate mobile text entry, attachments, session locking, reconnection and
  remote-access authentication. Document call/media support and notification
  behaviour rather than inheriting claims from native browser mode.
- Explain the trade-off: normal KithMoot decrypts in the member's browser;
  home execution makes the selected home host a trusted endpoint. Neither
  mode silently changes the other's custody model.

Oathrun may optionally host a permissioned assistant participating in a room.
It is not a prerequisite for messaging, a remote desktop, or an assumed bridge
to the existing networks. Agent access must remain explicit and revocable.

## G7 — Daily workspace calls with accountable agent follow-up

Keep persistent chat as the primary surface on both platforms. A daily call
brings the human principals together, with clearly identified agents able to
listen and transcribe under the existing explicit media-access controls.

Acceptance:

- Move from room chat into a video call and back without losing the draft,
  reading position, thread or call. On Android, everyday conversation must be
  a primary screen rather than available only in a call screen's bottom sheet.
- Show which agents are present, whose they are, who can hear each participant,
  and whether transcription is active. Each participant can revoke agent media
  access. Joining a call must not silently enable it.
- Present attributed transcript, decisions and proposed actions in the room.
  Distinguish agent transcription/summaries from statements actually sent by
  participants; corrections remain possible.
- Give accepted tasks an accountable principal, named agent, relevant context,
  status and a route back to the source conversation. Agents can continue on
  an available host after people leave the call, request required approvals,
  and return results to the same project. Show host unavailability honestly.
- Keep task context scoped to the room/project and authorised task. Continuing
  work does not grant an agent unrestricted access to other projects.
- Make transcript, task and any recording retention visible, including whether
  an external model provider receives meeting content. Audio recording is a
  separate choice from transcription.

Existing foundations include [agents](agents.md), per-participant agent media
access, transcription, minutes and approval cards. This goal concerns the
complete daily-call journey and does not declare platform parity complete.

## G8 — Anonymous temporary meetings with automatic teardown

A person shares a meeting link through Signal or another channel. Guests can
join without a KithMoot account, use a temporary name, and participate in
video, voice-masked audio, ephemeral group chat and screen sharing. Leaving
must not create a saved room or recoverable meeting history by default.

Acceptance:

- Generate independent meeting identities and keys. Do not attach an existing
  account, contact card, profile or stable identifier automatically. Offer
  camera/microphone controls and a local voice preview before transmitting.
- Test voice masking on PWA and Android. If the selected mask fails or stalls,
  mute outgoing audio and explain the failure; never silently publish raw
  microphone audio. Test device changes, audio interruptions and reconnection.
- Keep controls reachable during a call, while typing, and during screen
  sharing. The invitation and pre-join screen state the temporary lifetime.
- Proposed lifecycle: a short, declared reconnect grace after the last human
  leaves, plus a hard meeting expiry. Agents must not keep the meeting alive
  indefinitely. Support an explicit host end action and expired-link screen.
  Specify partition/reconnection behaviour so an expired meeting cannot revive.
- Enforce expiry and key retirement independently of browser unload callbacks.
  Exercise closing the tab, force-stopping Android, network loss, host loss,
  multiple devices, late joins and stale invitations on supported clients.
- Keep meeting content and credentials out of saved-room lists, archives,
  search indexes, analytics, notification previews, agent memories and routine
  application logs. Verify IndexedDB/local storage, service-worker caches,
  Android databases/backups, owned services and temporary media buffers. Static
  application assets can remain cached; meeting data must not be mixed into them.
- Proposed default: no recording/transcription agents or retained task export.
  Adding any retention requires an explicit change visible to every participant;
  that meeting cannot retain the same no-history promise.
- Define and test network-metadata exposure separately from temporary identity
  and encryption. Voice masking, camera blur and anonymous names are not proof
  of anonymity from other participants or infrastructure operators.

### Teardown claim and current gaps

The product intent is a meeting that disappears when it ends. Release copy
must describe the verified scope of application-managed deletion and avoid an
absolute “without a trace” guarantee: a participant can retain a recording,
invitation copies remain in external messengers, and infrastructure can retain
metadata. [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md)
explicitly permits indefinite relay storage of expired events, so expiration
alone cannot establish erasure.

Existing temporary admission and ephemeral presence events do not establish
this complete lifecycle. The current [voice-mask fallback](../README.md)
prioritises continued speech and can revert to raw audio on a stalled output
clock; G8 requires a fail-closed privacy behaviour. Inspect storage, transport,
agent and teardown paths before claiming this mode meets the goal.

## G9 — One workspace for projects, people and remote agent work

Make KithMoot the single daily control surface across all of a person's
projects. People and agents can be members of multiple projects without
requiring separate accounts, application instances or vendor-specific remote
control tools. Project membership, authority and context remain explicit.

The PWA [shared project directory](shared-projects.md) supplies signed project
identities, deliberate membership joins and encrypted device synchronisation.
Its Oathrun authority mapping, native Android directory and physical-phone
journey remain acceptance work; directory membership grants no task or context
authority by itself.

### Proposed navigation

- **Inbox:** decisions needing this person's judgement, alongside human mentions
  and replies across authorised projects. Routine progress stays in the project;
  completion summaries can be batched. Every item names its project and opens
  the originating conversation or task. Reuse Den's next-action projection and
  the canonical assignment ID instead of creating another editable task store.
- **Projects:** switch projects and their rooms directly. Inside a project,
  conversation is the main surface; work, files, people/agents and calls are
  available in context. Switching does not discard drafts or reading position.
- **Work:** a cross-project view of assigned tasks, with project filters and
  visible responsible humans and agents. Users only see work they can access.
- Search and a people/agent directory make existing collaborators easy to
  find and deliberately invite into another project. An invitation does not
  carry another project's conversations, credentials or permissions with it.

On desktop, retain project navigation beside the conversation, with task or
thread detail alongside when useful. On phones, use a small set of stable
navigation destinations and full-screen conversation/task views. These are
layout proposals; validate them through the end-to-end journeys below.
Temporary meetings remain a separate entrance and must not populate this
persistent history by default.

### Remote work acceptance

- From one desktop session and a physical phone, operate at least three
  projects with overlapping and disjoint human/agent memberships. Switch
  between them without signing in again or losing the selected conversation.
- Keep navigation responsive with representative project and conversation
  histories. Load authorised summaries for the inbox and hydrate conversation
  detail as needed; opening navigation must not subscribe to every project's
  complete history. Measure switching, scrolling, reconnect and memory use on
  the physical phone as well as desktop.
- Assign an agent work from chat, a thread or a meeting action; state the
  intended project, scope, responsible principal and authorised capabilities.
  Accept commands only from authorised principals, independently of chat
  membership. Other participants can discuss work without inheriting control.
- Inspect progress and results, answer a question, approve or reject a concrete
  action, redirect a task, request pause/resume, cancel and retry from the PWA
  and Android app. Where a runtime cannot support a control, say so before it
  is requested; do not simulate success.
- Show task states separately from connection state: queued, running, awaiting
  input, awaiting approval, completed, failed and cancelled; host offline,
  reconnecting or status stale. A sent command is not an acknowledged command,
  and a cancel request is not proof that execution has stopped.
- Use a project-bound agent session or equivalent enforced context boundary
  for each task. The same named agent may serve several projects concurrently,
  but membership alone grants no ambient access to their combined histories,
  memories, tools or credentials. Deliberate sharing must be scoped,
  attributable and revocable, with enforcement in execution and retrieval.
- Closing the PWA or Android app must not stop tasks on an available host.
  The user can resume control from another device over mobile data without
  entering a vendor remote-control tool. If the execution host is asleep or
  disconnected, show unavailability; do not imply work is continuing.
- Exercise locked-phone notifications, expired approvals, concurrent decisions
  from two devices, lost acknowledgements, duplicate delivery, host restart
  and membership revocation. Reconnection must not execute an action twice
  or replay stale authority. Task context, identity and approval state survive
  supported recovery without leaking into another project.
- Results, code changes, files and decision records return to the originating
  project with a useful summary and an inspectable result. Task completion,
  review, merge and deployment remain distinguishable states.

Runtime adapters may connect independent agent hosts, including an Oathrun
host where appropriate. The user-facing work controls must not depend on
knowing which provider or harness powers an agent. This goal does not claim
that current chat, host controls or approval messages already form a complete
remote work interface.

### Minimal supervision, context and efficient execution

- Starting work should need an outcome and any new constraints. Reuse the
  project's deliberately selected agent profile, available host, tool grants,
  budget and completion criteria. Show inherited choices compactly and permit
  overrides; do not silently expand permission when switching projects.
- Within that authority, agents retrieve evidence, resolve routine implementation
  choices, run checks and coordinate authorised work without involving the
  principal in every tool call. Bring a concrete decision, recommendation and
  consequences when judgement, new authority or an unresolved trade-off is
  required. Do not merely suppress requests while execution remains blocked.
- Establish reusable, bounded execution and communication permissions explicitly.
  Oathrun currently reviews each outgoing room draft; routine progress and
  results need a reviewed delivery policy before they can flow automatically.
  Preserve separate approval where an action exceeds the standing authority.
- Continue from an authorised task checkpoint after an interruption. Avoid
  repeated context gathering and duplicate execution. A permission renewal,
  reconnect or retry must not silently revive cancelled or uncertain work.
- Extend the existing signed context collections with retrieval of relevant
  decisions, code relationships, task history and evidence. Graphify-like links
  should be attributable, correctable and derived from authorised sources.
  Enforce project boundaries before retrieval and before releasing derived
  output; shared membership never permits a combined cross-project memory.
- Reuse Oathrun's task profiles, model selection, cache scoping, bounded inputs
  and usage accounting. Measure cost and tokens per accepted outcome including
  retries and human review; cache hit rate alone is not success. Model escalation
  and delegation must remain within an explicitly authorised profile and budget.
- Record a baseline and compare the same representative tasks after changes:
  human minutes directing/reviewing, avoidable interruptions per accepted result,
  time to useful work, repeated context requests, duplicate execution and total
  cost. Demonstrate the journey from a physical phone as well as desktop.

Already implemented: shared assignment creation, progress, questions, exact
result review, cancellation/handoff and Den links; hosted-agent discovery;
Oathrun project policies, context verification and prompt-efficiency controls.
Remaining work includes the assignment-to-Oathrun execution bridge, unified
project/attention surfaces, native Android work controls, durable session
integration and graph retrieval. This is not a new task-engine proposal.

## Delivery and evidence

G9 defines the product shell and remote work journey; G7 fits daily calls into
that workspace, and G8 provides the separate temporary meeting experience.
Prioritise a complete desktop-to-phone journey through project selection,
conversation, task assignment, an approval and a returned result.

Preserve the existing protocol, archive, search and push dependencies described
in the README. G1 spans those releases; G4 integrates them into an owned deployment.
Investigate G5 and G6 independently so external-service restrictions do not
hold up native messaging improvements.

For each goal, link implementation work and acceptance evidence here as it
lands. Evidence must name revisions, devices, service versions, configuration,
observed results and unresolved limits, using synthetic or consented data with
no credentials or recovery keys. Automated checks, physical-device acceptance
and published availability are separate states. Adding this roadmap does not
change the [current limitations](../README.md#what-does-not-work-yet).
