# Share screen from chat

## Screens for review

KithMoot’s room header, the room’s More menu at 320 px with Huge text, and the
call controls after a screen share starts. The header action uses the same
icon-button treatment as **Start call**.

## Candidate

Local changes over KithMoot commit `de852f9e0fdb529cf33d0fb5226e26cb2ce11af6`.
The web preview at `https://localhost:5482/j/` served `main-0929JSdA.js`.
The desktop renderer preview at `https://localhost:5483/j/` and the disposable
Electron app used `main-Df3ifx-6.js`. Both previews are stopped. The builds
include the participant-photo changes already present in the working tree.
The screen-sharing patch applies on its own to the base commit.

Run these commands from the candidate checkout. The browser runner builds
both acceptance previews and starts the local test relay.

```sh
npm run build:lib
E2E_PORT=5482 npm run test:e2e -- test/call-mic-on-join.spec.ts \
  --project=chromium --project=chromium-desktop --workers=1
```

## Manual review

Use two disposable profiles in a test room. Keep a harmless document open
for sharing. Review the standalone browser and the desktop app. For embedded
review, open this revision in the Archipelago test package with display
capture, camera and microphone delegated to the KithMoot frame. Record the
package build ID with the maintainer’s decision.

| Action | Expected result |
| --- | --- |
| In chat, tab from **Start call** to **Share screen** and press Enter. Cancel the picker. | Both actions have visible focus. The picker opens directly. Cancelling closes it and leaves both participants in chat. |
| Select the test window. On the second profile, answer the room’s usual incoming call. | The viewer receives the screen. The presenter’s microphone and camera are off. Keyboard focus moves to the stop-sharing control. |
| Turn on the mic, then the camera. Stop sharing. | Voice and camera join the existing session. Stopping the screen leaves voice and camera available. |
| Resize to 390, 768 and 1440 px and phone landscape. At 320 px, switch to Huge text and open the room’s **More** menu. | The header action fits at standard text sizes. At 320 px with Huge text, **Share screen** is in the menu and still opens the picker. |
| Repeat from chat while the second participant is recording an existing call. Decline the recording prompt after choosing the test window. | The capture closes and the presenter stays in chat. Choosing to join allows the share on that call. |

## Evidence

- Type checking and 23 browser tests passed. Two Chromium profiles verified
  decoded screen video, a stable call ID when adding voice and camera, and
  release of capture on relay refusal.
- Both renderers asked for recording consent, stopped the capture when the
  presenter declined, and sent the screen on the existing call after consent.
- The web and desktop renderer passed keyboard focus and touch-layout checks at
  320, 390, 768, 844 landscape and 1440 px. An isolated macOS Electron run
  reached the native capture chooser with stubbed source enumeration, then
  started and stopped a synthetic share through the desktop redaction bridge.
- Native selection with real screen pixels and the Archipelago embedded package
  await manual review.

[Focused room header](2026-11-27-share-screen-from-chat/room-header.png) ·
[320 px room menu](2026-11-27-share-screen-from-chat/room-menu.png) ·
[Screen-only call controls](2026-11-27-share-screen-from-chat/call-controls.png)

## Archipelago integration

Archipelago builds its embedded KithMoot preview from a pinned upstream
commit. This change is for the standalone KithMoot source. Adoption in
Archipelago needs a package revision for the maintainer to review.
[Archipelago package Dockerfile](https://source.archipelago-foundation.org/lfg2025/archy/src/commit/1407fb72f4e3b446061cb2e0c63ba11a5438ebc2/docker/kithmoot/Dockerfile)

Maintainer must review and approve UI work on the embedded KithMoot room header, room menu and call controls before merging or approval. ZAT pending.
