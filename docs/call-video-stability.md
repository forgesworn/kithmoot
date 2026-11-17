# Call video and audio activity stability

Reported on 16 November 2026: two callers' pictures briefly halved together,
regular video flicker, and Android's video moving as the audio meter updated.

The browser stage counted `awaitingFrame` sinks as cameras even though they
are transparent, one-pixel decoding sinks. A spare receiver therefore reduced
the real camera's width before producing any picture. Screen receivers also
received their presentation class only after a matching roster advert.

The browser's two-second recovery loop could restore a paused, parked picture
without fresh packets, counteracting the one-second video watchdog. It also
retried paused gallery sinks that were intentionally off the current page.

Android's `Incoming audio: Waiting` can wrap where `Incoming audio: Sound`
fits on one line. Reserve two lines so meter state cannot resize the video
beside it. Idle traces are white; sound uses the existing theme accent. A dark
plot background keeps the white line visible in both light and dark themes.
Text states, reduced motion and browser forced colours remain available.

These changes concern local rendering and recovery. They do not change room
membership, encryption, media routing, telemetry or the operator's role.

## Review setup and expected results

Affected screens: web and desktop call gallery, camera/screen-share views and
audio meters; Android chat, call and dock audio meters. Local branches are
`fix/call-video-stability-20261116` in both repositories. The Android checkout
is `../.worktrees/kithmoot-android-call-video-20261116`.

1. Join the same test room from web, desktop and Android with all three
   connected. Enable both cameras, then toggle a camera and a screen share.
   A receiver waiting for its first frame must not halve an existing picture.
   A genuine second camera should still receive its own slot.
2. Interrupt one caller's media, then restore it. A stalled picture must not
   cycle off and on while no media is arriving, and must return when packets
   resume. Test gallery paging as well: off-page sinks should remain paused.
3. Alternate silence, speech, mute and microphone off. Idle traces should be
   white, sound coloured, and the written state should agree with the signal.
4. On a narrow Android screen, alternate `Waiting`, `Quiet` and `Sound`, with
   enlarged text as well. The meter and video bounds must stay constant.
5. Repeat in light/dark themes and with reduced motion. Browser forced colours
   should retain system colours and readable state text.

Browser fixtures use synthetic media and a local relay. They cannot reproduce
the owner's original network incident or establish physical GrapheneOS,
hardware decoder, acoustic or mixed-client acceptance. Those remain separate
checks on the intended devices; no existing rooms need to be migrated.

## Verification on 16 November 2026

- Both video regressions failed against the original production bundle: the
  camera occupied exactly half its tile, and recovery restored a paused parked
  sink without fresh RTP.
- `npm run typecheck`: passed.
- Focused remote-tile, call-layout, gallery and speaking-monitor tests: 109 passed.
- Browser acceptance on web and desktop production builds: 6 passed, including
  both regressions, a genuine second camera, resumed RTP, meter colours, reduced
  motion and forced colours. Desktop meter screenshot inspected.
- Additional Chromium check: a new camera decodes with Hide people without
  video enabled on a narrow screen; passed.
- Desktop unit tests: 304 passed. Packaged notarised Mac startup, renderer
  security, persistence and pairing checks passed.
- Android source and regression fixture are in the companion branch; its build
  checks and physical UI acceptance are recorded separately.

Logs, baseline failure traces, screenshots, exact source hashes and the temporary
Playwright configurations are retained at `~/.codex/artifacts/kithmoot-call-video-20261116T120714Z`. The busy Mac required a
longer server-start allowance; test assertions and case timeouts were retained.

## Follow-up on 17 November 2026

The owner reported further video flashes and a known caller appearing as `Somebody`.
The earlier loss of all media had recovered, with the owner confirming audio
and video in both directions. That recovery preceded these code changes.

The playback watchdog still parked a previously decoded picture when both
its playback clock and RTP progress readings stopped. It did so even when
the sender continued to advertise its camera. Keep the last picture visible
while the role remains advertised, or while roster presence is unknown.
Explicit track endings and the existing unadvertised-track liveness checks
still remove stopped media; the existing decoder recovery remains in place.

Name resolution now falls back to an existing contact name or the saved name
of the exact peer in the call's private room. Current public-profile and
roster names retain their precedence. Local names do not enable profile
lookups or mark the identity as having a public profile.

Affected screens are the standalone web and desktop call gallery and the
person labels that share its name resolver. The task branch is
`fix/call-video-flashes-20261117`, based on `6b9fd6d9`. No Android-native source,
room membership, media routing or live service configuration is changed.

Review with two fresh browser profiles in a disposable room:

1. Join a call with both cameras enabled. A temporary gap in receiver progress
   readings must retain the decoded camera in its tile. When media resumes,
   playback must continue without hiding and restoring the tile.
2. Turn the far camera off and on, leave the call, and change gallery pages.
   Stopped media must disappear; deliberately parked sinks must stay parked
   until the appropriate recovery or user action restores them.
3. Hold a contact named Rowan, disable public-profile lookups, and join a call
   with that exact contact key publishing no roster name. The tile must read
   Rowan. A stranger must not inherit that contact name, and an explicit
   current name from the caller must take precedence over the local fallback.
4. Check the intended web, installed desktop and physical Android clients
   together in the existing room. Automated loopback tests do not establish
   the cause or resolution of every flash on the owner's live connection.

Verification on 17 November:

- The two advertised/unknown-presence watchdog regressions and the local-name
  resolver regression failed before the fix; 49 other focused tests passed.
- After the fix, the remote-tile, profile-name, direct-chat-name, profile-lookup,
  call-layout and gallery-page suites passed: 125 tests.
- `npm run typecheck` passed.
- Web and desktop production builds passed, including the existing artwork,
  bundled-dependency and no-telemetry build checks.
- All four browser cases in `test/call-video-stability.spec.ts` passed on both
  production builds: 8 passed. The temporary test configuration used ports
  4285/4286 and relay 4385, selected `chromium` and `chromium-desktop`, and
  allowed 300 seconds for build startup; assertions and case timeouts were
  retained. Test servers and temporary output were removed afterwards.

These are local checks of the prepared repair. No hosted CI, new installer,
public deployment, physical Android acceptance or live-call resolution is
claimed. Publication and installation remain separate delivery steps.

Tested source SHA-256:

```text
fbc0e15d2c86bda665e09938d1217d4707672bee9c7f269c2cf4d6604d5175fd  app/src/main.ts
c8e4c6f24d02b56a444729bbeea0efa357723167012d5b19ffbeca0a88ff6104  app/src/remote-tiles.ts
f5b60c2f94786dc0ef392982e6140e16a6ff78d6d48c917890478eaf1b4e2823  app/src/profile-name.ts
```
