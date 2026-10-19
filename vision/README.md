# KithMoot Vision

Original MIT library for learned, local camera effects. **Experimental: no
qualified camera model is included.** This is a separate training library
inside the checkout, rather than another vendor's face SDK. The live inference
engine is [Rust, compiled natively and to WASM SIMD](runtime/README.md).
Python/PyTorch is used for offline model development and training.

`CameraVision` starts with random weights. It has a shared image encoder,
an anchor-free multiple-face detection head and a dense foreground alpha
head. Matting accepts RGB, an optional empty-background reference, a
reference-validity map and the preceding matte. Faces depend only on current
RGB. The foreground target includes people, hands and held objects. No face
identity embeddings, recognition database or named identities are involved.

`MobileCameraVision` keeps the same inputs and face branch with a separable
foreground head. It is now the training CLI's default (`--architecture mobile-v2`);
use `--architecture v1` to reproduce the earlier dense experiments. Its smaller
calculation budget does not establish equivalent visual quality. The
[mobile smoke run](experiments/2026-10-18-mobile-smoke.json) is recorded separately.

The architecture needs empirical work on capacity, edge refinement, temporal
stability and pose/occlusion handling. The apps do not use these experimental
weights. Tracked masking remains unavailable; Avatar is independent of ML.

## Run locally

For a separate local source-rights review and general-training annotation tool,
use the [Model Workshop](workshop/README.md): `npm run vision:workshop` from the
repository root. It accepts face-only and foreground-only reviewed examples,
preserves detailed source pictures, and prepares data for offline M4/Metal
training. Resumable checkpoints retain dataset and training-source provenance.
The source catalogue remains pending human review; no real-camera model is
qualified by creating a dataset or finishing a training run.

For live camera/file previews, face boxes, background effects, reviewed
personal captures and a complete local training/test loop, use the
[Local Camera Lab](lab/README.md). From the repository root:

```sh
npm run vision:lab -- --prepare
```

The lab uses the Rust/WASM engine in a worker. Its procedural default weights
are explicitly unqualified for real faces; personal models can be loaded
without enabling them in calls. Android can exercise the same lab through a
loopback USB forward in its browser. iPhone/Safari and Android can also open
the separate [HTTPS preview](https://kithmoot.forgesworn.dev/camera-lab/), with
an opt-in local microphone level test. Native JNI integration remains open.

Python 3.11+; dependencies are in `pyproject.toml`. The development machine
already has PyTorch 2.10.0, NumPy and Pillow. On a fresh machine install into
a virtual environment. Dependency installation requires network access;
training and inference have no model downloads, network clients or telemetry.

From this directory:

```sh
python3 -m unittest discover -s tests -v
python3 -m kithmoot_vision.synthetic runs/smoke-data --count 36
python3 -m kithmoot_vision.train runs/smoke-data/manifest.jsonl runs/smoke-model --steps 100 --device mps
python3 -m kithmoot_vision.evaluate runs/smoke-model/experimental.pt runs/smoke-data/manifest.jsonl
```

Use `--device cpu` without Apple Silicon; CUDA is also supported. Work is
bounded by `--steps` and `--batch-size`, with two CPU threads and no data-loader
workers. Existing output directories are refused. The original procedural
drawings verify learning and reporting plumbing only. They cannot qualify
real-face inference. Do not bundle their checkpoint as a product model.

The [18 October smoke results](experiments/2026-10-18-procedural-smoke.json)
retain both the initial failed pilot and the longer learning run. These are
small drawing experiments, with weak held-object retention, not camera results.

## Training data

`data.py` accepts local JSONL manifests and checks every referenced image
and rights-review file by SHA-256. A row contains:

| Field | Meaning |
|---|---|
| `id`, `scope` | Unique example; `general` or `personal` |
| `split` | `train`, `validation` or `test` |
| `subjects`, `scene`, `sequence` | Opaque group IDs preventing split leakage |
| `rgb`, `alpha` | Image and, when reviewed, foreground alpha, each with local `path` and `sha256` |
| `labels` | Explicit `faces` and `foreground` booleans for partial supervision; legacy rows reviewed both |
| `reference`, `previous_alpha` | Optional empty room and preceding matte |
| `held_objects` | Optional labelled object region for evaluation |
| `faces` | Every visible face as normalised `[x, y, width, height]` |
| `faces_complete` | All visible faces annotated, including bystanders |
| `foreground_includes_held_objects` | Labels retain objects brought to camera |
| `synthetic` | Whether the imagery is generated |
| `rights` | Licence, permission declarations and hashed review evidence |

The generated smoke manifest is a complete format example. For general training, `rights` requires
`licence`, `training`, `commercial`, `mit_weights`, `evidence` and
`evidence_sha256`. Real footage also requires reviewed `subject_permission`.
The allow-list is `PROJECT-OWNED`, `CC0-1.0`, `MIT` and
`PUBLIC-DOMAIN-REVIEWED` (with a documented basis and scope). This is a
conservative project policy, not an exhaustive list of compatible licences.
Research-only, non-commercial, unknown and other unreviewed material is refused.
Declarations cannot prove ownership: a person must review the actual terms
and permissions before setting them.

For general training, people, scenes, sequences and identical RGB images cannot
cross held-out splits. Adjacent frames from one clip are not independent validation.
Personal captures cannot enter general training. `data/`, `runs/` and model
weight formats are ignored by Git; keep private footage and permissions there
and out of Git.

The lab importer writes `PERSONAL-LOCAL` manifests. `--personal` explicitly
selects private training with reviewed local permission and no commercial or
public-weight grant. Same-person/room context is allowed across independent
takes, with sequence and identical-image leakage still refused. Evaluation
records that narrower held-out policy; private checkpoints/exports retain
`public_release_allowed: false` and `qualified: false`.

## Learning someone's room

The proposed optional setup records an empty room, then the person moving,
turning and showing objects to camera. It needs a separate validation segment.
A broadly trained base model must also work without setup.

An empty picture provides reference evidence, not face labels. Occupied
footage alone supplies no reliable matte. Shadows, screens and lighting changes
make image subtraction an unreliable ground-truth label. Base training needs
reviewed face boxes and foreground mattes. Later, a qualified base model could
produce confidence-filtered pseudo-labels for local adaptation, excluding
uncertain pixels and checking held objects before accepting the adapter.
The Camera Lab provides reviewed frame/label capture and private experiments.
Automatic labelling and an in-app adaptation product flow remain open.

`MatteAdapter` and `adapt_step` implement a neural residual trained against
reviewed local matte labels. Base weights and face predictions stay unchanged.
The residual changes alpha by at most 0.1 per pixel: this limits damage but
cannot fix a fundamentally wrong base prediction. Capture storage, adapter
validation/rollback and desktop/Android training backends remain open.

Personal recordings must stay local, be discarded after adaptation by default,
and have a visible delete/reset action. Tie adapters to the base-model hash
and camera/room version; invalidate them when the source changes. Do not share
them or incorporate them into public weights through implicit consent.
Training must run outside the call render loop and be cancellable. Mobile
battery, heat and memory costs need measurement.

## Rights and dependencies

Checked 18 October 2026. These findings cover the named sources, not every
possible intellectual-property right:

- Our architecture, training, decoder, adapter and procedural drawings are MIT.
  No pretrained weights are used. Intended public weights are also MIT,
  subject to provenance review.
- [PyTorch's licence](https://github.com/pytorch/pytorch/blob/main/LICENSE)
  permits commercial use with required notices. It is a development numerical
  framework, not a hosted service or pretrained camera model, and is not added
  to either app. Development dependencies keep their own licences; MIT does
  not replace their required notices.
- [FaceSynthetics](https://github.com/microsoft/FaceSynthetics/blob/main/LICENSE.txt)
  restricts commercial product use of its data **and results**. Excluded;
  no download or training performed.
- [MakeHuman's core assets](https://static.makehumancommunity.org/about/license.html)
  and [output terms](https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md)
  offer a possible CC0 route to rendering varied people ourselves. Community
  assets have separate terms. Its GPL/AGPL authoring tools would remain outside
  our distributed library. No code or assets imported.
- [VideoMatte240K's author confirms MIT terms](https://github.com/PeterL1n/BackgroundMattingV2/issues/208).
  A candidate for foreground training; actual archive terms, subject permissions
  and held-object coverage still need review. No download or training performed.
  This does not clear other datasets linked by the same project.

## Release gates still open

1. Acquire/render reviewed training data and independent real tests: diverse
   faces, rooms, lighting, profiles, several people, negatives and occlusions.
   Label hands, books, phones, mugs and reflective/transparent held items.
2. Train and iterate. `train.py` records hashes, seed, framework and losses.
   `evaluate.py` reports face matches, false positives, unusable detections,
   foreground IoU and held-object recall. Neither can mark a model qualified.
   Add boundary quality, temporal flicker and demographic/lighting slices;
   a good aggregate score cannot hide a failing slice.
3. The Rust engine, weight export, C ABI, WASM host and local lab camera Worker
   are implemented. Complete the production camera Worker/JNI/native adapters,
   orientation and source-epoch fencing,
   real browser/device benchmarks and final runtime qualification. No network
   or vendor-model fallback.
4. Measure actual latency, memory, battery and heat. Verify remote calls and
   recordings as well as previews on intended hardware.
5. Evaluate objects occluding a face: padded face rectangles can cover part
   of an object. Preserving such objects safely needs an occlusion policy.
6. Review evidence and provenance before release. Production calls still have
   no qualified model or integrated inference runtime; the separate developer
   lab and personal-training loop remain experimental.
