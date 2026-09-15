# Testing feedback — 15 September 2026

User feedback from an iPhone and laptop room session. These findings reopen
physical acceptance; they are not evidence that the current PWA gate passed.
The local candidate extends an already dirty worktree containing independent
file-storage, push, context and product-goal work. Nothing in this record
claims that the candidate was committed, deployed or tested on a real iPhone.

## Findings and acceptance

| Priority | Feedback | Local candidate / next step | Acceptance |
| --- | --- | --- | --- |
| P0 | iPhone microphone and camera did not return after a notification | Resume interrupted audio contexts; recover ended/muted device sources without replacing the camera canvas or discarding effect settings; retry from More → Resume call media | Desktop receives fresh moving frames and increasing audio energy after a real iPhone notification, Control Centre, background/return and lock/unlock. Repeat with microphone muted, camera off, paired-device audio ownership and Leave during recovery; none may be silently re-enabled. |
| P1 | Laptop video windows are too small | Use 16–20rem desktop tiles with a 4:3 camera picture | Two people can read faces at laptop sizes; chat remains reachable, multiple rows scroll, and a shared screen remains expandable. |
| P1 | Copy a desktop file and paste it into chat | Handle clipboard files through the existing consent/encryption/upload/draft path | File stays staged until Send; ordinary text paste works; refused uploads, cancellation, multiple files and room switching preserve draft ownership. Repeat native Finder/Explorer copy and screenshot paste in target browsers; some clipboard formats may not expose files to a web page. |
| P1 | View attachments | Images remain inline; add audio/video controls, PDF view link, bounded inert text/JSON/XML preview, and an explicit save/open fallback | Decrypt and verify only after Show. HTML must render as text, never execute. Check PDF support and real audio/video codecs on phone and desktop. Office documents/archives still require a compatible external app; a universal document renderer is not implemented. |
| P1 | Configure notifications by project, room, etc. | Open-app settings: account default → project → room, plus the device master switch. Shared projects use stable project identities; personal labels remain separate. Settings persist per account on this device. An explicit project Off wins across overlapping projects unless the room overrides it. | Cover inheritance/reset, same-name projects, project membership changes, multiple accounts and master pause. Complete the closed-app push integration below before claiming a unified notification policy. |
| P2 | Use iPhone upside down while charging, with readable chat and screen shares | Added to roadmap; not implemented | Test Safari and Home Screen PWA in portrait upside down with keyboard, composer, remote video, expanded screen share, annotations and safe areas. Outgoing camera orientation and local preview must remain correct. Native keyboard orientation must be proven; a CSS rotation alone cannot establish this requirement. |
| P1 investigation | An @Tally roadmap request went unanswered; repeated agent departures/arrivals | Reliability fixes included; original live incident remains uncorrelated | See [agent reliability investigation](2026-09-15-agent-reliability.md) for reproduced failures, checks and the unresolved runtime location. |

The pasted assignment was **offered**, assigned to the human owner, and showed
**Start work**. That records an offer awaiting its owner's action, not proof
that an agent started the task. No external assignment state was changed here.

## Notification completion work

The existing local push candidate sends generic room activity through an owned
push host and a keeper. Its subscription has no project/room policy snapshot,
and the keeper currently observes room chat, not assignment transitions.
Therefore the new project/room switches are explicitly labelled **open-app**
in the UI. They do not silently claim to mute closed-app delivery.

The next notification slice must:

- apply the same effective policy before a push is dispatched, including a
  device-wide pause and subscription removal;
- carry assignment offers, questions, requested decisions and completed results
  through the same policy, with event-type controls where useful;
- update policy when shared-project membership or room organisation changes,
  resolve overlapping projects deterministically, and avoid replaying history;
- make delivery state and preference synchronisation visible across devices;
- route a tapped generic push to the saved room/assignment, or clearly show
  why that destination is unavailable;
- prove foreground/background/closed/locked delivery and suppression on an
  installed iPhone PWA and desktop, including an expired subscription.

WebKit documents Home Screen installation and a user gesture as part of the
[iOS Web Push permission flow](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
MDN documents the iOS audio
[`interrupted` state and resume behaviour](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state).
These platform references informed the candidate; they do not prove this
particular physical interruption is fixed.

## Local evidence

Executed locally on 15 September 2026 with Node v24.14.0:

- `npm run typecheck`: passed on the final candidate.
- `npx vitest run`: 134 files, 1,874 tests passed on the final candidate.
- Production PWA builds completed for the browser runs. The existing large
  bundle warning remains.
- Seven focused browser checks passed: clipboard staging/inert HTML preview
  and persisted notification overrides in Chromium, Firefox and WebKit;
  two-party capture recovery and readable desktop tiles in Chromium.
- The Chromium media check passed again after the final media-output guard.
  Recovery requires new moving remote pixels and increasing received audio
  energy after both raw device sources are stopped. This is simulated OS
  capture loss, not a notification on a physical iPhone.
- The rendered laptop screenshot was inspected after restoring a 4:3 camera
  picture in the larger tiles.
- `git diff --check`: passed. Existing unrelated local edits were retained.

Still open: physical iPhone interruption and native clipboard checks,
real-device PDF/audio/video compatibility, complete closed-app notification
policy and assignment alerts, upside-down keyboard behaviour, agent response
investigation, and release/deployment. No external messages or assignment
operations were sent.

## Release-check follow-up

The broader release checks found a second desktop test that still required
210px thumbnails, a macOS WebKit keyboard check that needed Option-Tab for
links, and a reproducible chat resize failure. WebKit adjusted `scrollTop`
during viewport resize; the previous strict position comparison mistook that
layout adjustment for a reading gesture and stopped following the latest
messages. Scroll tracking now distinguishes unchanged-layout scrolling from
resize anchoring. Explicit reading gestures still stop following.

The 15 focused home, website, reading-position and viewport checks passed in
Chromium, Firefox and WebKit. An expanded regression also verifies that a
reader of older messages stays in place through resizing; that check passed
in all three engines. Typechecking passed. Physical phone acceptance remains
separate from these desktop browser-engine checks.
