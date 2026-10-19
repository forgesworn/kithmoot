# KithMoot Model Workshop

An original MIT, local development tool for KithMoot face masking and foreground
matting. It prepares reviewed training data; it does not qualify models or
enable camera effects in calls. Source footage, labels and numerical training
dependencies retain their own licences. No pretrained model or external vision
SDK is included.

From the repository root:

```sh
npm run vision:workshop
```

Open **http://localhost:4390** on that computer. The server binds only to
127.0.0.1, serves an explicit static list and refuses uploads. There are no
remote fonts, scripts, model calls or analytics. Files enter the browser only
through its file pickers. Closing the server does not save an open review;
explicitly save the review project before closing the browser.

## Review sources and labels

1. Open a local image or video (at most 128 MiB). Its exact file SHA-256 is
   recorded. Video decoding is supplied by the browser; unsupported codecs
   need a locally converted clip. Keep the original source and conversion
   relationship in the evidence notes.
2. Record source URL, licence, relevant terms, reviewer and the basis relating
   to visible people. Optional `.source.json` notes can fill evidence fields
   only when their SHA-256 matches the opened file. Notes never approve data.
   Review the actual material; a label such as CC0 cannot prove provenance or
   someone else's permissions. Public-domain sources need their reviewed basis
   and scope recorded explicitly.
3. Assign opaque people, scene and take groups, and one of Training, Validation
   or Held-out test. Reuse group IDs when people/scenes recur. The source file,
   subject, scene and sequence cannot cross splits, even when individual
   extracted frames differ. Personal Camera Lab captures remain a separate
   private workflow; they are not general-training grants.
4. Explicitly review training, commercial use, MIT-weight release and subject
   rights before approving the source. The tool records these declarations;
   it does not establish rights automatically or submit external forms.
5. Pause a useful video frame and capture it. Images retain their aspect ratio
   up to 1280 × 960. Select Faces only, Foreground only, or both. Box every
   visible face for face supervision. Paint people, hands and held objects for
   foreground supervision, or import a matching greyscale PNG alpha mask as a
   draft. White keeps, black removes; intermediate values support soft edges.
   Mark opaque held objects separately where useful. Review all selected tasks
   before adding the frame. Previously added frames can be edited or removed.
6. Save review projects to continue later. Up to 24 frames fit one export;
   multiple non-overlapping exports can be imported together (at most 256 per
   pilot). Training export requires all three independent splits. The Python
   importer repeats rights, label, image-size and leakage checks and hashes
   each source review and derived image. Source filenames never determine
   output paths.

Keep review projects and clips in ignored `vision/data/` or outside Git.
The source catalogue contains **pending candidates**, not approved datasets.
VideoMatte240K's author confirms MIT, but the actual download page also describes
stock-derived layers and requests a commercial-use survey. Review the archive,
notices, subject basis and request before admitting it. No survey or message
is submitted by this tool. Stock footage alone does not supply foreground
ground truth; VideoMatte foreground/alpha pairs also need suitable reviewed
backgrounds when constructing training RGB images.

## Train on the M4

Use this source version on the M4 in a clean checkout or an isolated source
snapshot. Preserve existing checkouts and unrelated release work. A Python
3.12 environment is supported; macOS's Xcode Python 3.9 is too old.

```sh
python3.12 -m venv .vision-venv
.vision-venv/bin/python -m pip install --no-cache-dir -e vision
cd vision
../.vision-venv/bin/python -m kithmoot_vision.workshop ~/Downloads/kithmoot-workshop-training-*.json --output data/reviewed-001
../.vision-venv/bin/python -m kithmoot_vision.train data/reviewed-001/manifest.jsonl runs/reviewed-001 --device mps --steps 1000
../.vision-venv/bin/python -m kithmoot_vision.evaluate runs/reviewed-001/experimental.pt data/reviewed-001/manifest.jsonl
../.vision-venv/bin/python -m kithmoot_vision.export runs/reviewed-001/experimental.pt runs/reviewed-001/experimental.kvm
```

This is local Apple Metal training, not a cloud service. Load the resulting
`.kvm` and matching `.json` into Camera Lab on the laptop or iPhone. Checkpoints
and exports remain experimental. Initial training still uses the existing
160 × 96 model graph; retaining better source images enables later architecture
and resolution experiments but does not itself improve that graph's accuracy.

Atomic checkpoints include model/optimiser, shuffling position, CPU/device RNG,
reviewed dataset hash, framework/device and training-source recipe. Resume to a
**new** output directory with the same manifest, scope, seed, batch size,
architecture, framework, device and training source:

```sh
../.vision-venv/bin/python -m kithmoot_vision.train data/reviewed-001/manifest.jsonl runs/reviewed-002 --device mps --steps 2000 --resume runs/reviewed-001/checkpoint.pt
```

`--steps` is the total, including resumed steps. Checkpoint frequency defaults
to 100 steps; use `--checkpoint-every` to change it. Ctrl-C retains the last
complete atomic checkpoint, not a partially interrupted optimiser operation.
Existing datasets, runs and exports are never overwritten. CPU resume parity
is tested; Metal numerical/device reproducibility needs separate measurement.

Face-only examples do not supervise background pixels. Foreground-only examples
do not teach absent-face negatives or decay the inactive face head. The shared
encoder can still change during either task. Each trained task needs independent
validation labels. Evaluation records per-task frame counts and reports null
metrics when a task has no reviewed labels; these never become an accuracy
claim. Real camera qualification, boundary quality, flicker, diversity, held
objects and actual-device latency remain separate work.
Training now letterboxes RGB, masks and optional references together, with face
boxes transformed into the same model coordinates. Portrait and wide footage
must not be stretched into a different geometry from the Camera Lab input.

## Retention and progress

Original clips are unnecessary for inference. After extracting and checking
reviewed examples, they can be discarded according to the source's terms and
review decision. Saved projects and derived frames still contain imagery.
Retain a permitted development/test set for repeatable improvement, or record
the loss of reproducibility when deleting it. Keep source rights evidence,
hashes, recipes, model cards and evaluation reports with a model release.
Do not promote private recordings into public training through implicit consent.

The next quality milestones are approved real-data pilots, augmentation and
capacity comparisons, held-out quality/error slices, temporal training and
edge refinement, then Rust/WASM and actual iPhone/Android/desktop performance
qualification. The workshop is a KithMoot development component; a working
review/import/train loop is not a capable real-camera model.

## Checks

```sh
node --test vision/workshop/browser.test.mjs
cd vision
python -m unittest discover -s tests -v
```

Browser checks use only original synthetic fixtures. They exercise source
approval gates, frame annotation, mask import, export/reopen/edit, split-leak
rejection, local-only requests and phone/light/dark layouts. They never access
a real camera or assert real-face accuracy. Vision CI also imports that actual
browser export and trains/evaluates/exports a bounded model.
