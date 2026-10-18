# Local Camera Lab

Test the owned Rust/WASM face detector and foreground model on camera frames,
local images or clips. This is a separate development preview; the released
desktop and native Android call settings keep their existing qualification
gates. No Google face SDK, hosted inference or frame upload is used.

From the repository root, with Node 24, Python training dependencies installed
as described in [Vision](../README.md), and the Rust WASM target installed:

```sh
npm run vision:lab -- --prepare
```

On Apple Silicon, append `--device mps` for the initial drawing-model training.
Preparation reuses `vision/runtime/target`, creates original procedural drawings
under `vision/runs/lab-drawings-v1`, and trains/exports a small smoke model under
`vision/runs/lab-model-1000-v1` (1,000 bounded training steps). It downloads no images or weights. Existing model
experiments are reused, never overwritten. Later starts need only
`npm run vision:lab`. Open **http://localhost:4388**; Ctrl-C stops the server.

The default weights were trained on drawings. They demonstrate the pipeline,
not real-face accuracy. Load your own local `.kvm` export and matching `.json`
card to test a personal model. The card's SHA-256 must match the weights.

## What to exercise

- Live front/rear camera, an image or a short local video up to 32 MiB.
  Nothing requests the microphone. Stop input ends camera capture.
- Face-only, foreground-only and combined inference; face boxes, opaque masks,
  replacement background, blur and a separate predicted-matte view.
- Optional empty-room reference and previous predicted matte. Changing the
  input clears reference and temporal evidence. Portrait and ultrawide inputs
  retain their edges through letterboxing.
- Multiple people, turning faces, movement, dark/light backgrounds and held
  books, mugs or phones. Compare the raw input and prediction carefully.
- Worker inference time, end-to-end processing time, processed fps and model
  workspace. One inference frame is in flight; its result paints only that
  captured frame. Source/model/reference changes invalidate stale results.

This exposes per-frame learned detections, not identity recognition. A model
can miss a face confidently; this preview cannot establish safe anonymity.
Camera access starts only after Start camera and browser permission.

## Personal capture → training → test

Choose a split before starting each input. Capture a frame, draw every face
box and paint a foreground label that includes hands and held objects. Mark
held-object regions separately for recall measurements. A predicted matte can
be used as a draft, followed by human review. Drawing examples have optional
known labels so the complete workflow can be tried without personal footage.

Add samples only after checking the three review declarations. Stop the input
before choosing the next split and recording a separate take. Up to 32 samples
stay in memory per export. Export all three takes together, or export several
files and list them in the importer. From `vision/`:

```sh
python3 -m kithmoot_vision.capture ~/Downloads/kithmoot-vision-*.json --output data/personal-test
python3 -m kithmoot_vision.train data/personal-test/manifest.jsonl runs/personal-test --personal --steps 1000 --device cpu
python3 -m kithmoot_vision.evaluate runs/personal-test/experimental.pt data/personal-test/manifest.jsonl
python3 -m kithmoot_vision.export runs/personal-test/experimental.pt runs/personal-test/experimental.kvm
```

Load the resulting `experimental.kvm` and `experimental.json` into the lab.
Choose fresh data/model directory names for each experiment; existing captures
and checkpoints are never overwritten. Import either one combined export or
non-overlapping exports from separate takes.
This trains both heads from scratch as a private experiment. The bounded
`MatteAdapter` remains a separate experiment.

Personal data cannot enter the default general-training path. Local permission
does not grant commercial/public MIT model-release rights. The importer
validates review declarations, PNG sizes, face boxes and retained object
labels; shared takes or identical pictures across splits are refused. A
personal experiment can share its people/room across independent takes: those
scores measure that context, not generalisation to other people or rooms.
Declarations still need an actual human permission and label review.

Captures and loaded personal models stay in this tab; the server has no upload
endpoint. Clear lab stops the camera and releases captures, personal model,
reference and labels. Closing the tab also ends the session. Exports/imported
data and checkpoints are separate local files; delete those separately.
`vision/data/` and `vision/runs/` are ignored by Git. Never add personal exports
or footage to source control.

## Android browser testing

The same WASM lab can run in an Android browser. With USB debugging already
enabled and your device selected, forward only this local service:

```sh
adb -s YOUR_DEVICE_SERIAL reverse tcp:4388 tcp:4388
```

Open `http://localhost:4388` in the phone browser. The server stays bound to
desktop loopback. When finished, stop the lab and remove the forwarding:

```sh
adb -s YOUR_DEVICE_SERIAL reverse --remove tcp:4388
```

This tests the shared WASM model on that browser/camera. A native Kotlin/JNI
camera bridge, real-call integration and device performance qualification
remain separate work.

## Verification

```sh
cd vision
python3 -m unittest discover -s tests -v
cd ..
node --test vision/lab/core.test.mjs
node --test vision/lab/browser.test.mjs
```

Browser checks require prepared assets and the installed Playwright Chromium.
They use a synthetic camera, real Rust/WASM inference and real local training:
matched-frame background rendering, camera/source replacement, reviewed export,
private training/evaluation, model reload, mobile layout and clear/reset. They
do not access a physical camera or prove real-face/held-object accuracy.

All software/art is original MIT. The runtime's standard-library copyright
and licence notices are served through the lab footer. This local tool does
not enable unqualified models in calls or change published release manifests.
