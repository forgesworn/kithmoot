# KithMoot client roadmap

Recorded 14 September 2026; delivery state refreshed 15 September 2026. This roadmap sequences the clients; it does not
declare any milestone complete. The immediate product is the PWA. Desktop and
native clients follow only after the PWA has met the exit gate below.

The detailed product outcomes remain in [product goals](product-goals.md).
The [PWA execution plan](pwa-execution-plan.md) turns phases P0-P4 into ordered
work packages and names the model switch points for each package.
This document answers a different question: in what order should the client
work land, and what evidence is required before the team moves to the next
platform?

## New physical-test feedback

### Desktop space usage — 19 September 2026

Open: the installed Mac 0.1.9 chat view leaves roughly half a wide window
empty while the message list and composer remain in a narrow left column.
The submitted screenshot shows this in a private room with the call inactive.

- Let the conversation workspace use the available width and height while
  keeping individual message lines readable.
- Make chat width adjustable; place the composer with the conversation and
  use spare space deliberately when call, people or work panes are open.
- Check wide monitors, ordinary laptop windows and live resizing, including
  chat-only rooms and transitions into and out of calls. Accept on the actual
  Mac and Linux clients with screenshots; a CSS change alone is not closure.

### Mac screen-recording permission after upgrades — 19 September 2026

Open release defect: after installing 0.1.9 over 0.1.7, screen capture was
refused. Both bundles use ad-hoc signatures whose designated requirements are
different code hashes. That prevents relying on macOS retaining permission
across rebuilds. Removing and re-adding the app in Screen Recording is a
recovery step, not an acceptable recurring update flow.

Package with a stable Developer ID identity and notarisation, then prove an
in-place upgrade preserves screen-capture consent on a real Mac. Neither this
Mac nor M4 currently has a Developer ID Application identity in its signing
keychain. Keep this gate separate from signature verification and build smoke
tests, and include whole-screen, window and floating-area capture in acceptance.

The [15 September feedback register](2026-09-15-testing-feedback.md) tracks
notification interruption recovery, readable laptop video, clipboard files,
attachment viewing, project/room notification preferences, upside-down iPhone
use while charging, and unanswered agent requests. P0 remains open; local
implementation, browser checks and physical acceptance are recorded separately.

## Direction

KithMoot should become one product and one protocol available through several
clients:

- the PWA is the zero-install client, invitation door and reference user
  experience;
- a desktop shell will add operating-system integration that a browser cannot
  supply reliably, while reusing the PWA and TypeScript protocol core;
- the existing native Android client remains an independent implementation of
  the published protocol;
- one universal Apple client will serve iPhone and iPad with layouts suited to
  each device;
- every client must continue to interoperate through published vectors and
  observed cross-client journeys. Platform parity is not inferred from a
  shared design or a green build.

The PWA is not a prototype to throw away. It remains the fastest way into a
room, the fallback on an unmanaged computer, and the behaviour against which
the installed clients are judged.

## Current state

| Client | State on 14 September 2026 | Current boundary |
| --- | --- | --- |
| PWA | Implemented and deployed under `/j/` (release `20260915T055605Z`, `main` `26793d1`) | The iPhone annotation and active-call-update repairs have automated and exact-release deployment evidence; P0 remains open until physical acceptance is recorded |
| Android | Native Kotlin client exists | Its repository has its own incomplete parity, signing, publication and physical-accessibility gates |
| iPhone and iPad | PWA only | There is no native Apple client; mobile browser screen sharing remains platform-limited |
| macOS, Windows and Linux | Browser/PWA only | There is no packaged desktop client or privileged desktop overlay |

“Implemented”, “automated checks passed”, “deployed”, “installed”, “physically
accepted” and “publicly available” are separate states throughout this
roadmap.

## Phase P0 — finish the physical room repair

Ship and accept the fixes found during the 14 September physical room check
before widening the roadmap.

Acceptance:

- an iPhone stroke is completed and sent when the finger lifts, including
  when WebKit retargets or cancels the final pointer event;
- annotations are addressed to every admitted room device rather than only
  devices that have a media peer;
- the person sharing sees the line on their KithMoot share preview, with a
  conspicuous notice or supported floating surface when that preview is not
  in view;
- the interface states the PWA boundary honestly: it cannot promise to paint
  over an unrelated application or the operating-system desktop;
- camera and microphone remain in sync, late arrivals are announced, screen
  sharing has an obvious stop action, video tiles remain compact, and call
  controls do not collide with chat;
- automated protocol and browser checks pass, followed by a recorded physical
  call using a real desktop and real iPhone. Automation alone does not close
  this phase.

## Phase P1 — make calls boringly reliable

The PWA call should survive ordinary real-world behaviour without the people
in it thinking about WebRTC, relays or browser state.

Deliver:

- deterministic microphone, camera and screen-share state before and after
  joining;
- visible connecting, live, muted, stopped, failed and reconnecting states;
- recovery from device changes, sleep/wake, background/foreground, network
  changes and an ICE route moving between direct, assist, forwarder and TURN;
- screen-share expansion, zoom, annotations and stopping that behave the same
  way in every supported layout;
- explicit handling for browser autoplay, permission denial/revocation and a
  camera or microphone taken by another application;
- a compact call stage that preserves a useful conversation and composer on
  small phones and narrow desktop windows.

Acceptance matrix:

- Chrome and Safari on macOS, Firefox on desktop, and installed/ordinary Safari
  on a physical iPhone;
- Android Chrome/PWA as a compatibility client, with unreliable mobile browser
  screen capture still labelled as such;
- two-person and three-person rooms, two devices belonging to one person, a
  late joiner, camera plus screen share, and screen-share audio where the
  platform offers it;
- home Wi-Fi, a Wi-Fi/mobile-data transition and the supported VPN path;
- at least one 45-minute call with repeated camera, microphone, annotation and
  screen-share changes and no unrecovered black, frozen, silent or duplicated
  media.

For every row, record client versions, device/OS versions, chosen route,
permissions, observed outcome and any unsupported capability.

## Phase P2 — trustworthy everyday messaging and recovery

Make the PWA dependable when it is treated as a daily application rather than
an open demonstration tab.

Deliver:

- acknowledged, pending, failed and retrying message states without duplicate
  delivery;
- reconnection after suspension, restart and network changes;
- room switching that preserves drafts, reading position and unfinished file
  work;
- encrypted file send/retrieval with clear progress and recovery;
- search and history behaviour that states the loaded window and does not
  imply an archive that is not present;
- safe service-worker updates that do not interrupt calls, drafts or pending
  sends;
- recoverable identity and room access, with an explicit explanation of what
  is lost when no recovery method was saved;
- consented notifications with restrained lock-screen content, followed later
  by the complete pocket-notification work in G2.

Acceptance:

- complete the G1 physical iPhone and Android-browser journey;
- reopen after browser suspension, a device restart and a network change;
- recover on a fresh browser from each supported recovery method;
- exercise relay rejection, offline publication, duplicate delivery, expired
  credentials and a service-worker update during unfinished work;
- verify IndexedDB, local storage, caches and logs contain only the state the
  product claims they contain.

## Phase P3 — make the PWA the daily workspace

Finish the desktop-to-phone journey defined by G7 and G9 before wrapping the
same gaps in installed applications.

Deliver:

- stable Inbox, Projects, Work and conversation navigation;
- conversation-first rooms with calls, files, people, agents and work in
  context;
- attributed transcripts, decisions, approvals, task progress and results;
- clear agent ownership, media access and project-scoped authority;
- responsive project switching without subscribing to every complete history;
- temporary meetings that remain visibly distinct from persistent workspace
  rooms and do not silently retain history or agent work.

Acceptance:

- from one desktop and one physical phone, operate three representative
  projects with overlapping people and agents;
- assign work from a conversation, answer a question or approval from the
  phone, and inspect the returned result in the originating project;
- retain the draft, reading position, thread and call across navigation;
- show queued, running, awaiting input, awaiting approval, completed, failed
  and cancelled separately from host connectivity;
- demonstrate that closing the PWA does not stop authorised work on an
  available host, and that reconnecting does not execute an action twice.

## Phase P4 — PWA release gate

The PWA is “nailed” only when P0–P3 are accepted and this release-quality gate
also passes.

Required evidence:

- complete unit, protocol, compatibility, browser and deployment checks from
  the exact release commit;
- physical iPhone and Android-browser accessibility checks, including large
  text, VoiceOver/TalkBack where applicable, keyboard use and reduced motion;
- representative desktop and phone performance, memory, battery and thermal
  measurements during calls and long conversations;
- security and privacy review of identity, invitation, room epoch, attachment,
  media-route, signer and local-storage boundaries;
- upgrade, rollback and recovery rehearsal, including an old installed PWA
  moving to the candidate without losing acknowledged user state;
- production deployment whose files match the release build, followed by a
  clean-browser and installed-PWA smoke check;
- current limitations and platform differences reflected in the interface,
  README and release notes.

Exit decision:

- no open severity-one or severity-two PWA defect;
- no known call, message, recovery or update defect that strands a person
  without a visible recovery action;
- every supported claim has physical evidence on its named platform;
- unsupported behaviour is hidden, disabled or explained before somebody
  depends on it.

Only then does desktop/native expansion become the primary delivery lane.
Protocol compatibility fixes required by another client may still land, but
they must not displace the PWA exit gate.

## Phase D1 — one hardened desktop shell

Create one Electron-based desktop client for macOS, Windows and Linux, bundling
the reviewed PWA rather than loading privileged remote content.

The shell owns only capabilities that genuinely need the operating system:

- screen and system-audio capture;
- a transparent, always-on-top annotation surface on supported desktops;
- deep links, notifications, tray/dock/taskbar integration and wake handling;
- secure credential storage, signed updates and installers;
- a narrow, versioned preload bridge with context isolation, sandboxing and no
  general Node access from the renderer.

macOS and Windows are the first full-capability targets. Linux ships the same
conversation and call client, but screen capture and overlays require explicit
Wayland/X11/desktop-environment evidence; parity is not assumed from an
Electron build.

Desktop acceptance includes signed/notarised packages, clean-machine install,
update/rollback, capture-permission denial and revocation, multi-monitor/DPI
mapping, overlay exclusion or deliberate inclusion in the outgoing capture,
and two-way interoperation with the PWA.

## Phase M1 — native mobile clients

### Android

Continue the existing independent Kotlin client. Close its documented protocol
and product gaps, including sending as well as receiving screen annotations,
then complete production signing, upgrade, physical-device, TalkBack and
publication gates. Do not replace it with a web wrapper merely to claim parity.

### iPhone and iPad

Build one universal native Apple client with adaptive SwiftUI layouts. It must
implement the published protocol and compatibility vectors independently,
support the platform's approved screen-capture path, and provide camera,
microphone, background, notification, deep-link, signer and lifecycle handling
appropriate to iOS and iPadOS.

Native screen capture does not by itself authorise arbitrary drawing over
other applications. The Apple client must define where annotations are shown
and test that surface on physical devices before making a stronger claim.

## Cross-client release gate

No installed client is complete because it works alone. Each release candidate
must run a consented interoperability matrix against the currently supported
versions of:

- PWA ↔ PWA;
- PWA ↔ desktop;
- PWA ↔ Android;
- PWA ↔ iPhone/iPad;
- desktop ↔ Android and desktop ↔ iPhone/iPad;
- a room containing all four client families.

The matrix covers invitation and recovery, identity/device grouping, chat and
files, calls and route changes, screen sharing and annotations, epochs and
removal, agents and media consent, updates and version skew. The published
protocol vectors remain the first gate; observed cross-client behaviour is the
release gate.

## Immediate next work

1. Repeat the physical desktop/iPhone room check against production release
   `20260915T055605Z` and record the result.
2. Convert every failure from that check into a P1 regression or an explicit
   platform limitation.
3. Run the P1 matrix before starting an Electron, SwiftUI or additional
   Android feature lane.
