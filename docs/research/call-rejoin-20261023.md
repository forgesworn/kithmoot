# First-frame recovery after rejoining a call

23 October 2026. This fixes a demonstrated browser playback defect. It does
not qualify a public relay provider, independent Internet networks, Android,
GrapheneOS or an Online Safety Act exemption.

## Cause and change

A new or rebound remote video entry starts with `last = -1`. The recovery
poll previously called `currentTime > last + 0.001` proof of movement. Its
initial `currentTime = 0` therefore counted as a played frame even while
`videoWidth = 0` and no decoded picture existed. That removed `awaitingFrame`
and marked the entry played. A few quiet recovery polls could then park it
inside `#parked`, which uses `display:none`, before its first frame arrived.
That is an unsafe place to wait for a decoder to start.

`pictureAdvanced` now requires actual picture data, a positive playback
clock and an advance from at least zero. The caller checks
`HAVE_CURRENT_DATA` and non-zero dimensions. A new stream's initial zero
cannot mark it played, including after the fifteen-second rebind path.
First-picture visibility and clock progress are separate: a decoded still
picture may be shown even before the clock advances. Advert-based removal,
explicit off-page gallery pause, meeting controls and user leave remain in
their existing paths.

The three added unit regressions failed with the old clock calculation.
They cover the zero sentinel, clocks without picture data and repeated
recovery polls while a first picture is delayed. Existing parked/stalled
picture recovery tests remain part of the same suite.

## Browser regression

The controlled browser scenario first establishes a real 1:1 call, reloads
one browser and temporarily withholds the outgoing camera canvas's first
paint for twelve seconds. The owned privacy compositor, native capture
track, actual credential issuer, coturn REST authentication and WebRTC
connections remain in use. No raw camera fallback, ICE configuration or
incoming playback element is substituted. Cameras and microphones are
synthetic fixtures, not the machine's real devices.

After several one-second recovery polls, the receiver must still have its
zero-clock, zero-width awaiting-frame element in the room. With the old
code this failed because the element had been parked. After the fix the
same scenario passed and both directions subsequently supplied growing
decoded frames, audio energy and a moving visible video sink over TURN/TLS.
This is stronger than merely observing a connected peer or stale RTP totals.

The existing three-person automatic-credential scenario now performs three
reload/rejoin cycles and checks every receiving direction after each cycle.
Its sampler requires a playing visible sink associated with the actual
native receiver, in addition to decoded frames and audio energy. Stream
epoch changes and counter/clock resets establish a fresh baseline; they
cannot satisfy the requirement without subsequent movement.

An optional `E2E_CALL_OBSERVER_CPU_RATE=4` slows the two existing callers
after the initial group call using Chromium's
[CPU throttling command](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate).
This is a browser scheduling stress case, not a physical-device or network
benchmark. Earlier successful reruns without a fix are retained separately
from failure evidence; a successful rerun alone did not establish a repair.

## Diagnostic boundary and test fixture

The failure helper matches native receivers with all their DOM sinks,
including parked elements, and records bounded media counters, states,
directions and sanitised SDP summaries. It does not export SDP, candidates,
addresses, passwords, keys, media frames or packet captures. Full SDP is
read only inside the synthetic browser to derive section facts and boolean
track matches. The existing opt-in synthetic diagnostic build can also
report camera playback state and compositor counters. The ordinary build's
timeline and export hook remain disabled; this is not a complete client or
host zero-logging audit.

The credential fixture also needs to serve multiple browser sockets.
Python's [HTTP server documentation](https://docs.python.org/3/library/http.server.html#http.server.ThreadingHTTPServer)
specifically identifies pre-opened browser sockets as a case where the
single-threaded server can wait indefinitely. The fixture change uses
threaded, bounded TLS handling; an idle TLS connection must not block the
two fresh browsers' credential requests. This changes only the disposable
local test facade. The existing Node issuer and private deployment are not
changed by the fixture repair.

## Remaining native-media symptom

The clock fix does not explain every intermittent failure. Earlier synthetic
runs at four-times observer CPU slowdown also showed a live, unmuted camera
source and a running privacy compositor while a native sender reported no
source or encoded video frames. Another receiving direction could decode
more frames while its associated native track stayed muted and its playback
clock stayed zero. SDP summaries remained send/receive and the sender's
encoding was active. These observations do not prove the root cause is in
Chromium, capture, signalling or the application.

A diagnostic sender detach/reattach resumed one outgoing stream but did not
restore every receiving sink. The original test still failed. That probe is
not a production repair. Subsequent successful stress runs never exercised
the conditional probe, so they establish no ICE-restart recovery behaviour.
The state-mutating probes were removed before the final ordinary-build gate;
only read-only failure snapshots remain in the acceptance test.

See [the failed native snapshot and partial probe](../evidence/call-rejoin-20261023/native-stall-and-partial-probe.json)
and [the interrupted earlier matrix](../evidence/call-rejoin-20261023/interrupted-earlier-matrix.json).
The latter retained its failures and interruption; the old response-body
credential observer was subsequently replaced by checking the credentials
actually installed in native peer configurations. This observation change
does not establish why every earlier response read failed.

## Qualification record

Final run results and source hashes are recorded in
[`docs/evidence/call-rejoin-20261023`](../evidence/call-rejoin-20261023/).

- The controlled browser regression failed with the old calculation, then
  passed with the fix. The three new unit regressions likewise failed first.
- Ninety-six targeted unit tests passed across four files; these include all
  forty-one remote-tile tests. Library and app type checking passed.
- The final ordinary production-build automatic-call gate passed all four
  cases: two fresh credential consumers while TLS remains idle; delayed
  first frame; 1:1 then three-person group with three successive rejoins;
  and issuer refusal preserving chat without a media peer.
- A separate diagnostic-build gate passed all four cases under four-times
  observer CPU slowdown. Three further repetitions of the group scenario
  passed nine total rejoins. No recovery probe ran in these successful cases.
- The final ordinary production-build publisher/protected-sharing gate passed
  all five cases: crop/redaction, hide/resume, source-change coverage,
  cancellation cleanup, source/compositor failure, source refusal and the
  complete two-browser room/chat/call/share/reconnect journey. The ordinary
  diagnostic hook and call timeline console records were absent in that
  journey. Synthetic pixels supplied the sharing source; no real OS picker
  or real screen contents were used.

Passing reruns qualify these bounded cases. They do not erase the intermittent
native-media failure above or establish unrestricted call reliability.
No hosted CI, public deployment, independent real-network calling, real OS
capture picker, Android or physical GrapheneOS acceptance ran in this increment.
No production service, public provider account or private relay configuration
was changed. The unmerged prototype worktree is retained for follow-up.

The [automatic guest transport record](automatic-guest-transport-20261023.md)
remains the historical evidence for the preceding failed rejoin gate. Its
issuer/operator and legal qualifications continue to apply. The next technical
gate is a deterministic reproduction of the native sender/receiver stall,
followed by a cause-specific fix and ordinary-build regression. Separate-network
and independently operated transport acceptance remain subsequent gates.
