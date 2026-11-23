# Visual audio activity

Calls show two short traces: **Your mic** and **Incoming audio**. The trace
shows signed peaks from the current audio sample block, with **Sound**, **Quiet**, **Muted**,
**Off** or **Waiting** beside it. It is an activity display, not speech
recognition or a calibrated loudness meter. Incoming audio includes shared
sound as well as microphones.

The web app and desktop client use the same display. Native Android has the
same two signals in its call view, conversation and dock. The display remains
available with cameras off and when call buttons fade. Incoming activity is
measured before playback volume, so turning the speakers down does not hide
the sound. Meeting restrictions still apply.

The white baseline stays flat while quiet; live sound draws a cyan trace.
Each trace contains at most 128 min/max pairs, preserving brief peaks instead
of smoothing several seconds of loudness into a filled shape. Microphone and
incoming traces update at most twenty times per second. Android landscape
calls put compact meters over the video and five labelled controls in a side
rail; portrait retains the bottom bar.

Reduced motion replaces the changing trace with a current-level bar.
Words and shape carry the information without relying on colour. The text
is available to assistive technology but is never a live announcement over
the call. No additional capture permission, recording, upload or dependency
is introduced; only the current bounded peak snapshot and levels are held in memory. Peaks
are replaced on each poll and cleared when samples stop, a track is muted or
removed, or the call ends. They are never saved or sent.

## Verification

- `app/src/speaking-monitor.test.ts`: silent analyser output, unavailable and
  muted tracks, replacement, teardown, and simultaneous microphone/share taps.
- `test/audio-activity.spec.ts`: real WebRTC tone on web and desktop, camera
  off, quiet playback, microphone mute, reduced motion, forced colours and
  narrow-screen conversation layout.
- `test/speaking.spec.ts` and `test/speaking-quiet-device.spec.ts`: speaking
  cues and visual levels continue to agree during mute and companion mode.
- Android `AudioActivityUiTest`: words, semantics, reduced motion and the
  camera-off call/conversation display.
- Android `BrowserCallInteropTest.audioActivitySurvivesMutedPlayback`: decoded
  browser tone reaches the native level meter with receiver volume at zero;
  removing its inputs clears the level.

Browser fixtures and Android emulation do not establish physical microphone,
speaker-route or GrapheneOS acceptance. Check those on the intended devices
with another caller before claiming physical-device acceptance.
