# Local video recording

The PWA's recording confirmation offers audio only, gallery with audio,
speaker with audio, or a selected screen share with that sharer's camera and
audio. It states local retention, paused-timeline behaviour, unsupported
capabilities and the changed retention promise in a self-destructing room.
Recordings remain local until Save or an explicit encrypted room share.

Add to message keeps the local Save/Discard copy while staging the file. With
uploads off, it holds the file in the originating conversation draft until a
storage destination is allowed and Upload selected files is pressed. A failed
upload leaves both the local recording and held file available for retry.
After upload, Send is still required before another person receives the message.
On a phone, Add opens Chat so the storage choice and Send are visible while the
call continues.
Recipients fetch and decrypt the recording only after pressing Show. Discarding
the local recording does not remove a file already added to a message draft or
recall saved/sent copies; the confirmation explains that distinction.

## Capture and ownership

One locally composed 1280×720 canvas at 15 frames per second is combined with
the existing authorised call-audio mix in one MediaRecorder. Camera inputs
are the privacy-processed outgoing track and the original call's authorised
incoming tracks. It does not capture the page, browser display or a raw camera
as a privacy fallback. Every exported view carries the originating room and
call, participant key and device key alongside current display names.

Gallery order follows endpoint identities, not changing display names. It
includes camera-off and unsupported clients by name. Up to 24 call devices
receive gallery tiles; further devices receive an explicit audio-only overflow
tile. This rendering limit is not a qualified call capacity. Speaker selection
uses the existing hold interval and decodes only the selected camera. The
screen layout remains bound to the selected participant and device through
share replacement, and reports an ended share or departed owner instead of
switching to another person's screen.

Only devices advertising recording-profile 2 can contribute video; this
ensures their client explains video recording. An older client is excluded
from video, appears with a named update fallback, and can still contribute
audio under the unchanged legacy warning. Capability claims do not prove
identity or consent. All inputs are checked against the originating call and
meeting access rules repeatedly, including after roster or track changes.

Independent muted video elements decode only the chosen layout's inputs.
Gallery paging, collapse and popouts therefore cannot freeze the export or
duplicate audio. Ended, muted, disabled or stale video produces a named
fallback. Five seconds without a decoded frame is treated as unavailable;
an unusually sparse static share can consequently show this fallback.
Replacing or excluding an input releases its decoder; stopping releases the
compositor's own output track without stopping any call-owned track.

## Pause, interruption and limits

Paused time is omitted from the exported audio/video timeline. A video
recording pauses when the document becomes hidden, releases its input decoders
and requires an explicit Resume after returning. This avoids promising live
background canvas capture on a phone. The signed warning stays visible on all
clients throughout a pause. Audio-only recording retains its existing browser
behaviour; locked-phone and platform interruptions remain physical tests.

Leaving or losing the originating call, expiry, permission changes handled by
the room, compositor failure and the existing recorder errors/size cap stop
capture. Destruction also discards unsaved clips, including clips finalising
asynchronously. Saved and shared copies cannot be recalled by room teardown.

Video formats are probed before selection, preferring WebM with VP8/Opus,
then VP9/Opus, then supported MP4. The requested video bitrate is 640 kbit/s
plus the existing 32 kbit/s audio mix; actual output can differ by browser.
The 95% upload-source limit leaves headroom for final chunks and sealing.
Chunks remain in memory until stop, bounded by that file-size limit plus one
chunk; this is not disk streaming or proof of acceptable phone memory use.

## Evidence and open G11 acceptance

The browser journeys decode actual saved audio and video with synthetic
cameras and screen shares. They check paused duration, audio energy, expected
camera colours, an independently collapsed gallery, the selected sharer's
camera and replacement-share frames. The existing recording and original-call
navigation journeys remain regression checks.

Before G11 can close, qualify 45-minute playback/export, A/V synchronisation,
memory, file size, interruptions, encrypted sharing and physical permission/
expiry behaviour on each supported device. Native Android recording/export
is still required separately; its signed notices do not implement capture.
Gallery capacity and battery measurements must be repeated with recording
enabled. Browser feature detection and short synthetic recordings do not
establish those physical gates.

## Long synthetic stress check

Run the desktop gallery journey in real time, then play back the complete
export in Chromium:

```bash
RECORDING_SOAK_SECONDS=2700 E2E_PORT=4876 \
  npx playwright test test/recording-video.spec.ts --project=chromium \
  --grep 'gallery.*desktop'
```

The opt-in duration affects only the desktop gallery test. Ordinary CI retains
the short journeys. The stress run measures the entire test browser's process
RSS as well as JavaScript heap, because encoded Blob storage is outside that
heap. Its progress receipt records the source commit, synthetic input boundary,
minute samples and recording/playback/passed/failed phase. The saved WebM and
export receipt remain under that test's output directory. The test requires
continuous recording, a file within the room's 256 MiB upload limit, complete
decoding, audible audio, both camera colours and paired track durations.

This checks a two-device synthetic gallery on the named test host. It is not
phone memory qualification, a battery baseline, an instantaneous A/V offset
measurement or encrypted sharing acceptance. Repeat real permission,
interruption and 45-minute journeys on physical supported devices.
