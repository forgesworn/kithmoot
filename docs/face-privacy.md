# Face privacy and owned camera AI

Desktop 0.1.88 and Android 0.6.91 released, 18 October 2026.
The [publication receipt](evidence/camera-privacy-0.1.88-0.6.91-2026-10-18.json)
records the signed packages, CI and public download checks. Physical acceptance
and real-camera AI qualification remain open.

The target is an MIT, first-party learned vision library for automatic
multiple-face detection and foreground matting, retaining people, hands and
objects shown to camera. An optional empty-room/occupied recording can help
local adaptation; it cannot replace broad base-model training.

See [KithMoot Vision](../vision/README.md) for the implemented neural
architecture, training/evaluation tools, data rights policy and open gates.
A manual image-patch tracker was removed from this draft because it did not
meet the automatic AI requirement.

## Current application behaviour

| Choice | Outgoing picture in this release |
|---|---|
| Off | Camera, subject to the selected background effect |
| Tracked mask | Unavailable until an owned model is qualified; a previously saved mask choice covers the whole picture |
| Avatar | Entire camera picture replaced by the original opaque masked avatar |

Both clients remember the choice before capture starts. Avatar keeps the
camera running locally but publishes a synthetic picture. It runs no detector
or segmenter. Android also avoids camera texture readback on this path.
Screen sharing is a separate track.

The Google MediaPipe dependency, background weights and asset build wiring
are removed in these releases. Consequently, person cut-outs and automatic
framing are unavailable here. Desktop blur uses its whole-picture fallback;
a chosen backdrop replaces the whole picture on both clients. Controls explain
this change. Automatic masking and matting remain disabled.

## Publication boundary

The compositor accepts multiple face boxes for a future qualified runtime.
Each fresh valid box gets a padded, opaque original mask. Missing, invalid or
failed detections cover the whole picture. This cannot detect confidently
missed faces; real-world detector qualification is essential.

Desktop draws on a private staging canvas and copies the completed picture
to the published canvas. Turning concealment on paints the opaque cover
synchronously. Late asynchronous detector loads are fenced by generation.
Android composites before the camera VideoSource. Publication checks the
choice and generation under a lock, including changes away and back while a
worker runs. Busy, hidden and failed-composition frames are dropped. Avatar
bypasses model loading and raw drawing. Mask artwork has no transparent holes.

## Ownership and privacy

The [original artwork](../art/face-mask/README.md), integration and vision
library are MIT. The geometric artwork does not reproduce the licensed
film/comic mask. No stock mask, pretrained Google model, face SDK or hosted
vision service is added.

The training library operates on local files, with no network clients,
telemetry SDKs or auto-downloads. It has no capture UI and currently stores
no personal recordings. Future personal training must be optional and local,
with deletion/reset controls and no implicit contribution to general weights.
Android retains the existing ML Kit QR telemetry exclusions and no-op transport
stubs; removing camera models does not make those QR defences unnecessary.
Android, WebRTC and Chromium are separate existing dependencies. This work
does not claim to remove all Google-origin code from the entire applications.

## Evidence and remaining work

Unit checks cover all-box geometry, invalid/missing detections, model loading,
artwork failures, saved choices, avatar bypass and stale-worker publication.
Browser tests inspect actual canvas pixels, remembered Avatar across restarts
and the unavailable-model path without external requests.

Vision tests perform real backpropagation through face and matte heads,
verify adaptation leaves the base model/face predictions unchanged, decode
several faces and reject restricted/leaking manifests. A procedural-drawing
training experiment exercises optimisation and held-out reporting only.
It does not establish real-camera performance.

Front/profile faces, several people, held objects, dim light, movement,
source switching, actual remote desktop/Android calls, recordings, latency,
battery and heat remain acceptance gates. There are no qualified real-camera
weights, app-integrated Rust runtime or completed local-training product flow.
The separate Rust runtime is built for native macOS, Android ARM64 and WASM
SIMD, with Python/native/WASM numerical parity checks; see vision/runtime.
