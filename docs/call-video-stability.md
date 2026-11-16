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
