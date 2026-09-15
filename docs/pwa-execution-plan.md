# KithMoot PWA execution plan

Recorded 14 September 2026; delivery state refreshed 15 September 2026. This
is the working order for the PWA phases in the [client roadmap](client-roadmap.md).
It is an execution checklist, not a claim that a phase is complete. The
[day-end handover](2026-09-15-pwa-day-end.md) records the exact release and
the remaining named physical checks.

Desktop packaging and new native Apple work remain outside this plan. Android
browser behaviour is included where it provides PWA compatibility evidence;
native Android product work keeps its own release gate.

## P0.1 automated baseline

The annotation repair candidate was reviewed locally. Using Node 24.19.0 on
14 September 2026:

- typecheck passed;
- the production PWA build passed;
- the focused mesh file passed 36 tests;
- the Chromium share-viewer file passed all 4 tests, including lost pointer
  capture, the sharer notice and both preview surfaces;
- the complete unit suite passed 120 files and 1,814 tests.

These results establish the automated baseline. They do not by themselves
establish merge, deployment or physical acceptance; those evidence classes
must be recorded from the exact release separately.

## Current P0 delivery record — 15 September 2026

The two fixes found in the physical-room session are on `main` and in the
current production PWA release:

| Finding | Merged change | Delivery evidence | Still required |
| --- | --- | --- | --- |
| A paired iPhone's completed annotation did not reach the sharer's preview | PR #98, `bbe69d1` | Automated share-viewer checks passed; the release was included in production release `20260915T055605Z` from `26793d1` | A real iPhone must complete a stroke and the desktop sharer must see it in KithMoot's preview |
| An update banner could block the controls needed to leave an active call | PR #99, `17ba8cc` and `3c3cedb` | Browser update checks passed; the release was included in production release `20260915T055605Z` from `26793d1` | A physical iPhone must show and use **Leave call and update** while media is active |

The deployed release was checked against the exact `main` tree, its public PWA
assets and service worker were checked, and the live Chromium share-viewer
smoke passed. Those are deployment and browser evidence, not iPhone
acceptance. P0 therefore remains **open**.

## How we will work

Each work package follows the same evidence ladder:

1. reproduce the behaviour or record the current baseline;
2. define the user-visible acceptance check;
3. implement the smallest coherent change and add a regression where useful;
4. run the focused checks, then the proportional full suite;
5. commit and review the exact candidate;
6. deploy only when authorised and verify the deployed files and clean-browser
   behaviour;
7. perform the named physical-device check;
8. mark the package accepted only when every required evidence class exists.

We will record **implemented**, **automated**, **deployed** and **physically
accepted** separately. A green build or a successful deployment never closes
a physical check.

## Model switch points

The model is selected for the work package rather than left at the most
expensive setting for the whole roadmap. The assistant will call out each
switch before starting the next package.

| Work | Model and effort | Reason |
| --- | --- | --- |
| P0 annotation release and P1 call reliability | **Sol High** | Cross-browser input, WebRTC, device identity and asynchronous room state interact here |
| Bounded visual polish, test expansion and evidence recording | **Terra Medium** | The change is local and its acceptance conditions are already known |
| P2 message, update and recovery state | **Sol High** | Delivery, persistence, deduplication and recovery must agree across failure paths |
| P3 workspace implementation slices | **Terra Medium** | Implement one agreed vertical slice at a time after the state contract is fixed |
| P3 state contract and difficult integration failures | **Sol High** | Project, conversation, agent and task lifecycles cross several subsystems |
| P4 exact-release checks and release administration | **Terra Medium** | Mostly deterministic execution against an established gate |
| P4 final security, privacy and architecture challenge | **Astra High** | Reserve the strongest long-horizon review for the final cross-system decision |

Luna is suitable for isolated mechanical rewrites, snapshots or documentation,
but switching to it is not worthwhile while a package still depends on the
active debugging context. Astra is an escalation and final-review model, not
the default implementation model.

## P0 — close the current physical-room findings

### P0.1 Land the annotation repair

Completed: PR #98 merged the paired-device annotation repair. It retains the
WebKit pointer/touch completion fallback, sends annotations to every admitted
device (including a paired device), and has focused mesh and share-viewer
regressions. It was later included in production release `20260915T055605Z`.

Exit: complete — the repair is reviewed, green and live. It is ready for its
physical check; that check is not yet accepted.

Model: **Sol High**. This is the model to select now.

### P0.2 Repeat the desktop/iPhone room check

Use a fresh physical room with a desktop sharing and a physical iPhone viewing
and drawing. Record browser/PWA mode, OS versions and the media route.

Check in this order:

1. join from the link and confirm the join screen makes camera and microphone
   enablement obvious;
2. enable microphone and camera on both devices and compare every control with
   the actual tracks and remote tiles;
3. join late from a second device and confirm the room announces it;
4. start and stop screen sharing repeatedly and confirm the stop action is
   unmistakable;
5. draw from the iPhone and confirm the completed stroke appears on the
   sharer's KithMoot preview;
6. confirm the product explains that a browser cannot paint over an unrelated
   desktop application;
7. exercise chat, search and invite controls without collisions;
8. repeat camera, microphone and share changes after backgrounding the phone.

Exit: each check has a physical pass, an actionable defect, or an explicit
supported-platform limitation.

Model: remain on **Sol High** so a failure can be diagnosed in the same turn.

### P0.3 Close regressions from the check

- Fix protocol, media-state or lifecycle failures on **Sol High**.
- Switch to **Terra Medium** only when the remaining failure is bounded visual
  layout or copy.
- Add the narrowest reliable automated regression for every fixed defect.
- Repeat the affected physical step after deployment.

Exit: no unresolved defect from the 14 September room findings remains. P0 is
physically accepted.

## P1 — make calls boringly reliable

### P1.1 Establish one call-state model

- Audit microphone, camera, screen-share and annotation ownership from join to
  leave.
- Give connecting, live, muted, stopped, failed and reconnecting states a
  single source of truth.
- Ensure controls, local preview, remote tiles and announcements all render
  from that state.
- Add diagnostics that identify the failed stage without exposing room or
  identity secrets.

Model: **Sol High**.

### P1.2 Finish the compact call experience

- Keep useful participant videos visible without crowding out conversation.
- Make screen share the temporary focus while preserving compact people tiles.
- Keep search, invite, chat and call controls from overlapping at phone,
  narrow-desktop and normal-desktop widths.
- Make permission denial, autoplay blocking and unavailable devices explicit
  with a visible recovery action.

Model: **Terra Medium** after P1.1 fixes the state contract.

### P1.3 Make lifecycle and routing recoverable

- Exercise sleep/wake, background/foreground, device changes and another
  application taking a camera or microphone.
- Exercise direct, assisted, forwarder and TURN paths without presenting an
  implementation-specific error to the person in the room.
- Recover from Wi-Fi/mobile changes without duplicate or stale media.
- Make an unrecoverable failure leave a clear retry or rejoin action.

Model: switch back to **Sol High**.

### P1.4 Run the browser and physical matrix

- Chrome and Safari on macOS and Firefox on desktop.
- Ordinary Safari and installed PWA on a physical iPhone.
- Android Chrome/PWA as a compatibility client.
- Two-person, three-person, same-person/two-device and late-join rooms.
- Camera, microphone, share, annotation, backgrounding and route transitions.
- One 45-minute soak with repeated state changes.

Model: **Terra Medium** for deterministic execution. Return to **Sol High** for
any cross-browser, media or state failure that is not immediately local.

Exit: supported PWA call claims have named physical evidence and no person can
be stranded without a visible recovery action.

## P2 — make messaging, updates and recovery trustworthy

### P2.1 Message lifecycle and reconnection

- Specify and implement pending, acknowledged, failed and retrying states.
- Prove reconnect and retry do not publish or render a message twice.
- Preserve drafts and reading position through room switches and suspension.

Model: **Sol High**.

### P2.2 Storage, identity and PWA update recovery

- Rehearse browser suspension, restart, network changes and a fresh-browser
  recovery from every supported method.
- Make identity and room-loss boundaries explicit before the person depends on
  local-only state.
- Update the service worker without losing a draft, acknowledged message,
  unfinished file or active call.
- Audit IndexedDB, local storage, caches and logs against the privacy claim.

Model: remain on **Sol High**.

### P2.3 Files, search and notifications

- Give encrypted file transfer visible progress, failure and recovery.
- State the search/history window honestly.
- Add restrained, consented notifications and verify their lock-screen text.

Model: **Terra Medium** once the P2 state and recovery rules are fixed.

Exit: the complete G1 phone journey, failure injection and fresh-browser
recovery all pass physically.

## P3 — make it a daily workspace

### P3.1 Fix the workspace state contract

- Define project, conversation, temporary meeting, participant, agent, task,
  approval and result lifecycles.
- Define which state is local, relay-backed or host-backed and how each state
  recovers.
- Define subscription and pagination boundaries before adding more views.

Model: **Sol High**.

### P3.2 Deliver vertical slices

Implement and physically accept one complete slice at a time:

1. Inbox to conversation and back, preserving position and drafts;
2. Projects to conversation with scoped files, people and agents;
3. conversation assignment to visible task progress and returned result;
4. phone approval or answer reflected in the originating desktop project;
5. host reconnect without duplicate execution.

Model: **Terra Medium** for each agreed slice. Use **Sol High** for state or
protocol failures crossing slices.

Exit: one desktop and one physical phone can run the three-project journey in
the client roadmap without losing context or executing work twice.

## P4 — release-quality gate

### P4.1 Candidate evidence

- Freeze the candidate commit and run unit, protocol, compatibility, browser
  and deployment checks from it.
- Verify clean-browser and installed-PWA upgrades against production.
- Record accessibility, keyboard, reduced-motion, performance, memory, battery
  and thermal results on representative devices.
- Rehearse rollback and recovery.

Model: **Terra Medium**.

### P4.2 Final challenge

- Review identity, invitation, room epoch, attachment, media-route, signer,
  local-storage and service-worker boundaries.
- Challenge supported claims against the collected physical evidence.
- Confirm every known limitation is hidden, disabled or explained before use.
- Confirm there is no severity-one or severity-two defect and no stranding
  failure without a visible recovery action.

Model: switch to **Astra High** for this final independent challenge.

### P4.3 Release decision

Release from the exact reviewed commit, verify deployed-file identity, perform
the clean-browser and installed-PWA smoke checks, and publish limitations and
release notes.

Exit: the PWA release gate in the client roadmap is accepted. Only then does a
desktop shell or new native Apple client become the primary product lane.

## Next session

P0.1 is already merged and deployed. Start on **Sol High** with P0.2's
desktop/iPhone room check against production release `20260915T055605Z`.
Record each result as a physical pass, an actionable defect, or an explicit
platform limitation. There is no new product candidate to deploy until that
check identifies one.
