# Camera mask performance

G10 remains open. This change reduces the cost of one measured camera-mask
operation; physical call CPU, battery and thermal acceptance are still required.

`fillMaskHoles` now visits border-connected background in horizontal spans,
using its existing scratch arrays. When every pixel is reachable background,
it skips the enclosed-hole scan. Enclosed-hole size limits, confidence values,
default blur and fail-closed camera behaviour retain their existing semantics.

## Reproduction and results

Run `node test/bench-camera-mask.mjs` from the checkout with dependencies and
Playwright Chromium installed. The baseline defaults to
`40a79b2e37ba7029e86b0cc813bce2ec88355ee7`; use `--base <40-character SHA>`
to compare a different source revision. This manual benchmark is not a CI gate.

Measured on 2026-10-09 using an Apple M1 Mac mini (Macmini9,1, 16 GB), Node
24.21.0 and headless Chromium 151.0.7922.34. The candidate source SHA-256 is
`d5e3dbf331f1c0152d5713d711bdf403659db5911cf0bef407556c248ef8ef14`.
The [raw report](evidence/camera-mask-m1-20261009.json) retains every sample.

Each synthetic fixture has 80 warm-up iterations followed by seven rounds.
Execution order alternates between baseline and candidate. Timings include
resetting the input mask; both versions reuse their scratch arrays. Small
fixtures run 160 iterations per round and large fixtures run 60. Outputs are
byte-identical for every fixture.

| Mask | Shape | Baseline median (ms) | Candidate median (ms) | Improvement |
| --- | --- | ---: | ---: | ---: |
| 256 × 256 | Background | 0.4644 | 0.2813 | 39.4% |
| 256 × 256 | Silhouette | 0.3850 | 0.3456 | 10.2% |
| 256 × 256 | Enclosed points | 0.1431 | 0.1044 | 27.1% |
| 256 × 256 | Checkerboard | 0.3650 | 0.3519 | 3.6% |
| 640 × 480 | Background | 2.2967 | 1.2833 | 44.1% |
| 640 × 480 | Silhouette | 1.7750 | 1.5217 | 14.3% |
| 640 × 480 | Enclosed points | 0.6767 | 0.5050 | 25.4% |
| 640 × 480 | Checkerboard | 1.7417 | 1.6583 | 4.8% |

The preselected local targets were at least 20% improvement on background
masks and no fixture regression above 10%. Both runs met those targets;
the first run measured 39.8% and 44.8% on the two background sizes.

## Correctness and privacy

- All 91 focused video-effects tests passed, including ten new tests using an
  independent coordinate-set component oracle and dirty reusable scratch arrays.
- A separate oracle comparison covered 19,212 exhaustive small binary cases and
  4,000 seeded finite-confidence cases; baseline and candidate were byte-identical.
- Type checking passed.
- Three Chromium privacy journeys passed: default blur visibly blurs, camera
  switching never publishes an unblurred frame, and unavailable segmentation
  fails closed with a visible explanation.

These timings cover synthetic masks in an isolated algorithm, not complete
camera capture, segmentation, compositing, encoding or a live call. They do
not establish an equivalent percentage reduction in whole-call CPU or battery
use. G10 still requires the named laptop, iPhone and Android 45-minute call
measurements, including battery, thermal, memory and network evidence with
privacy defaults enabled. Room-capacity qualification under G12 remains separate.
