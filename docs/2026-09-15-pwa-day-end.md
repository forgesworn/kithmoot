# PWA day-end handover — 15 September 2026

## Position at close

The PWA is live at `/j/`. The production release is
`20260915T055605Z`, built from `main` commit `26793d1affc845c3200c1304e3e5cda2e779e941`.
It includes the two repairs found during the desktop/iPhone room session:

| Finding | Shipped repair | What is proven |
| --- | --- | --- |
| A paired iPhone's finished annotation did not reach the sharer's preview | PR #98, commit `bbe69d1` | Focused mesh and share-viewer tests, production file identity and live Chromium share-viewer smoke |
| An update banner could prevent someone leaving an active call | PR #99, commits `17ba8cc` and `3c3cedb` | Browser update checks, including WebKit coverage, and the same exact production release |

The documentation record was then merged as PR #111 (`2b78f67`). Its five
post-merge CI jobs passed: Node 22, Node 24, Chromium, Firefox and WebKit.
This documentation commit did not create a new PWA release; it does not change
the deployed product artefact.

The following deployment evidence was already collected for
`20260915T055605Z`:

- the deployed server tree and 24 public PWA assets matched the expected
  release files;
- `/j/` returned `200` and `/j/sw.js` retained
  `Cache-Control: no-cache, no-store, must-revalidate`;
- the live Chromium share-viewer journey passed all four checks.

## What is not accepted yet

P0 is deliberately still open. Automated, browser and deployment evidence do
not establish a physical iPhone result. The next physical room check needs one
real desktop and one real iPhone, with the browser/PWA mode, OS versions and
media route recorded.

| Check | Passing observation |
| --- | --- |
| Join door | A person joining from a link can clearly see how to enable microphone and camera. |
| Media controls | Microphone and camera controls agree with local tracks and remote tiles on both devices. |
| Late join | The room announces a person who joins after the call has begun. |
| Screen sharing | Starting and stopping share repeatedly is clear; stopping does not require rediscovering the Share control. |
| Annotation | An iPhone finger stroke completes on lift and appears on the desktop sharer's KithMoot share preview. |
| Browser boundary | The UI makes clear that a PWA cannot draw over an unrelated macOS application or the operating-system desktop. |
| Layout | Chat, Search, Invite and call controls do not overlap; participant videos remain useful but compact. |
| Phone lifecycle | Camera, microphone and share recover sensibly after the iPhone backgrounds and returns. |
| Active-call update | With media active, **Leave call and update** is visible and successfully leaves the call before updating. |

For any failed row, capture the exact device/browser state and create a narrow
P1 regression. Do not call P0 complete until the affected row has been fixed,
deployed and physically repeated.

## Working order for the next session

1. Stay on **Sol High** for the physical check and any cross-browser, WebRTC,
   WebKit input, room-identity or asynchronous media-state failure.
2. If the result is only bounded copy, spacing or visual layout, use **Terra
   Medium** for the repair and its focused test.
3. Run the appropriate automated checks, make a reviewable candidate and only
   deploy after explicit release authority.
4. Repeat the exact failed physical step against the deployed release.
5. Once P0 is accepted, start P1: a single call-state model, compact call
   layout, lifecycle/route recovery and the cross-browser physical matrix,
   including a 45-minute call with repeated media and share changes.

## Explicit boundaries

- The PWA is the current product priority. Do not begin desktop packaging or a
  native Apple client merely to work around a browser limitation.
- A browser cannot place a transparent drawing overlay above arbitrary desktop
  applications. A future signed desktop shell may provide an operating-system
  overlay; that is a separate roadmap and security/release programme.
- Android remains an independent native client with its own parity, signing,
  publication and physical-accessibility gates. It is not part of this PWA
  acceptance claim.

## Repository close-out

At day end, `main` is clean and aligned with `origin/main` at `2b78f67`.
There is no unshipped product-code candidate. The next meaningful work is the
named physical P0 evidence, not a duplicate deployment.
