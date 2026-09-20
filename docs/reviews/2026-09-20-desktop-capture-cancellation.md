# Desktop capture cancellation — 20 September 2026

Desktop sharing and audio is the user-selected delivery priority.

Cancelling the area-sharing frame while the display chooser is pending rejects
`start()` immediately. The chooser can still return a stream afterwards. Its
promise previously resolved into an already rejected wrapper, leaving neither
`start()` nor `stop()` responsible for disposing the newly returned tracks.

The capture completion handler now stops every returned track when its frame
has been cancelled, closed or replaced. This includes screen audio as well as
video. The existing post-resolution cancellation guard remains in place.

## Verification

- Node 24.21.0: `npm run typecheck` passed.
- `npm test --prefix desktop`: all 10 tests passed.
- `E2E_PORT=5490 npx playwright test test/screen-share-audio.spec.ts --project=chromium`:
  all four tests passed, including shared audio, video-only fallback, cropped
  pixels/invalid bounds and the new late-result cancellation regression.
- Both web and desktop acceptance builds completed during that browser run.
- `npm run test:smoke --prefix desktop` passed: real Electron frame,
  resizing, chooser gesture, closure, sandbox boundaries and profile restart.
  Capture enumeration was stubbed; no real desktop pixels were captured.
- The new regression keeps synthetic video/audio sources in the owner window
  so popup closure cannot itself hide an application track leak.

These are local candidate checks. They do not establish packaging, deployment,
real display capture, audible system sound or echo exclusion.

## Worker use and review

Two local `qwen3.8:latest` calls used thinking disabled through the existing M4
tunnel (serving daemon reported 0.32.14). Initial budget: at most three calls;
two used. Provider-reported usage: 9,880 prompt tokens and 2,281 completion tokens
(12,161 total). No cloud worker was called.

The first packet extracted the delivery backlog; its unsupported release/CI
attributions were rejected. The second reviewed capture lifecycle code; it
misidentified the cancellation ordering and suggested guards already present.
Neither answer was applied as a patch. Codex reviewed the actual promise
lifecycle, implemented the fix and verified it with the real browser tests.

The existing main commit `2f5166fa067c61200e1d6ffe856ead246f3a6d0f` matches the
remote main branch and its [CI run](https://github.com/forgesworn/kithmoot/actions/runs/35441070356)
passed Node 22/24 checks and Chromium, Firefox and WebKit acceptance. That CI
covers the base commit, not this new local candidate.

## Remaining desktop acceptance

Use the packaged candidate on a real Mac to check native and fallback pickers,
audio consent, audible remote system sound, no feedback from remote callers,
frame movement/resizing, drawing alignment, cancellation and stop/leave.
Capture must preserve the explicitly chosen listening device. Signed upgrades
must separately prove permission continuity. See the existing
[sharing and listening record](../2026-09-19-sharing-and-listening.md) and
[Mac signing instructions](../../desktop/README.md#mac-signing-and-permission-continuity).
