# Combined realtime adapter qualification

24 October 2026. Experimental SDK implementation, not a deployment or a
switch of the existing website or Android call engine.

Subsequent hosted qualification, publication and deployment are recorded in
[the SDK preview delivery](realtime-release-20261024.md).

The adapter now combines **Spry + RelaySwarm + Sapflow**. Spry provides TURN
reachability when explicitly selected; RelaySwarm supplies signed encrypted
rendezvous and bounded datagrams; Sapflow's actual Rust/WASM queue schedules
complete encrypted frames. KithMoot endpoints retain media keys, protected
capture, VP8/Opus encoding and playback. The native WebRTC library is inside
RelaySwarm's Node backend, not an additional hosted service.

See the [integration guide](../realtime-call-adapter.md),
[wire contract](../realtime-wire.md) and
[sanitised numeric evidence](../evidence/realtime-adapter-20261024.json).

## Current evidence

These tests used Chromium and a separate native Node operator on one macOS
arm64 host. Public TURN traffic crossed the internet through the invited
Spry instance. Media consisted of generated 320×180 VP8 pictures at 12 fps
and mono 48 kHz Opus tones, with target rates of 200 and 24 kbit/s. Each
measurement window lasted at least four seconds. No real camera, microphone,
screen recording, browser trace or credential was retained as evidence.

| Gate | Result |
| --- | --- |
| Realtime, build-source and CLI lifecycle tests | 116 passed |
| Full existing unit suite | 7,330 passed; three skipped |
| RelaySwarm native facade/build tests | 15 passed |
| Typecheck, library build, PWA build and telemetry guard | Passed |
| Reviewed-source realtime build and package dry run | Passed |
| Native forwarded direct calls, 2/4/8 participants | Passed |
| Same-codec mesh comparison, 2/4/8 participants | Passed |
| Public Spry UDP, 2/4/8 participants | Passed |
| Public Spry repeat eight-person calls with the same credential | Passed; allocations released between calls |
| Authenticated local native TURN lifecycle matrix | Eight scenarios passed, including delayed nonce challenge and bounded partition cleanup |

Passing media cases require fresh decoded audio and video for every source,
advancing playback clocks, per-source audio energy, exact unordered 250 ms
channel reliability and preservation of caller-owned tracks on close. The
four-person forwarded case also includes a protected share: masks, hide and
resume with silence, covering a changed source until confirmation, injected
datagram loss and switching to another independently selected forwarder.
Recovery must produce new frames; an old cumulative counter cannot pass it.
Operators must exit cleanly without a forced kill, emit only their startup
readiness line and write no diagnostic stderr during a passing run.
The harness allows six seconds for process shutdown: eight deliberately
blackholed native closes measured 4.254 seconds. Successful public operator
shutdowns took about 90–120 ms. No media freshness gate was relaxed.

## Upload and frame age

Application datagram upload excludes IP, DTLS, SCTP and TURN overhead. At
eight participants the direct forwarded run averaged about 16.9 kB/s per
sender, versus 119.4 kB/s for the same-codec mesh run. Each forwarded sender
has one publication upload path; mesh sends seven copies. This is a short
synthetic workload, not a measured saving for arbitrary real-world video.
Forwarding still requires the operator to upload one copy per receiver.

Checksummed synthetic picture markers gave public-Spry frame-age medians of
288 ms (two participants) and 234 ms (four), with p95 values of 338 and
299 ms. The two accepted eight-person runs had medians of 433 and 401 ms,
and p95 values of 692 and **1,431 ms**. The latter tail needs investigation
before a production quality claim. Invalid markers are excluded and counted.
These are picture-age observations using same-host clocks, not a speech
latency, independent-network quality or battery result.

A short correlated observation captured ten active native-operator samples
and nine qualified CPU intervals: median 20.9% and peak 37.7% of one logical
CPU, with peak RSS about 104 MiB. Spry had 16 relay ports during the active
window and zero afterwards; allocation-present CPU observations had median
9.2%, with no sampled throttling, kernel drops or OOM events. This includes
transitions and is not a capacity benchmark or a controlled comparison to
the abandoned backend.

## Native teardown and source provenance

The original stock-native backend passed public two- and four-person calls but left TURN
allocations behind after all owned native processes had closed. The next
eight-person attempt obtained only two ready links. Twelve server relay
ports remained allocated. The unchanged server allows 32 allocations in
total and eight per full credential username; the observed sequence is
consistent with the earlier operator allocations exhausting that username's
quota. The fix releases allocations; Spry was not restarted, its quota was
not increased and no new credentials were minted to bypass that limit.

Earlier Werift experiments exposed WAN congestion and deadline faults. Their
passing results do not qualify the replacement native backend. An authenticated
local TURN probe subsequently reproduced the missing release with both the
stock native binding and the RelaySwarm facade: close and global cleanup
returned and the client socket was released, but the server received no
Refresh with lifetime zero. This distinguishes the native ICE teardown from
JavaScript ownership. An explicitly versioned native source patch has now
been built and qualified. The final source selection is RelaySwarm
`6ddbc96ea83e644551cf55448cf71133cc8dee5b` and Sapflow
`f25ea21e660418794e2fb2192f264e176e08d379`. The native binary identifies itself
as `0.24.5-forgesworn-turn-close.1`; its SHA-256 is
`ede568c39136031393f87394f8be365cb108c2be9a8ed74c19f7835655dd8e26`.

The patch explicitly serialises lifetime zero, keeps receive processing
alive for a bounded nonce challenge/retry phase, and gives close retries one
owner rather than competing with normal ICE bookkeeping. Synthetic normal,
drop-first-two and delayed-350-ms-nonce cases each prove 8→0→8→0 with the
same credential. Forged success acknowledgements, lost/late acknowledgements
and a blackholed server are tested. A partition still requires server expiry:
the blackhole case deliberately retains eight server allocations while local
cleanup returns. It is not described as successful remote deletion.

On public Spry, the accepted eight-person run was followed by an explicit
zero-port readback. A second eight-person call, then the two- and four-person
gates, passed using the same private profiles; a final readback again found
zero allocations. All sources continued decoding and playing. The first
patched media run failed an eager candidate-stat assertion for one endpoint;
the final harness uses the transport's selected-pair ID and bounded polling
to require actual relay/relay UDP evidence for every endpoint. That failure
and the earlier stock-native failure remain in the sanitised evidence.

Native preparation uses pinned source revisions, complete source checks and
a fresh owned build workspace. Prepared output contains the binary hash,
modified-source patches and dependency licence/source notices. The wrapper
independently verifies its reviewed source closure and prepared artifact;
runtime checks the sidecar hash and actual library identifier. It has no
stock-binary fallback. Browser assets exclude the native backend and binary.

Temporary provider/local credentials, native compilation scratch and the
private browser fixture are removed after recording the results. Local
`dist/realtime-runtime/`, `dist/realtime-forwarder.mjs`,
`app/public/realtime/` and RelaySwarm's `target/realtime-native/` are retained
as review builds while the work remains unmerged. Pre-existing services,
dependencies, emulators and phone users are preserved.
Twenty-one generated-media diagnostic result files remain locally under
`test-results/realtime/historical-results/` for the failure audit; the
sanitised final evidence above is committed. The diagnostics contain no
credentials or real captured media.

## Remaining product gates

The standard website and Android application have not been switched to this
SDK. Native Android/Swift endpoint interoperability, physical no-Play
GrapheneOS acceptance of this adapter, real OS sharing pickers, independent
client networks, blocked-UDP fallback, WAN loss/jitter, longer calls and
battery use remain separate work. Hosted CI, publication and deployment were
not part of this initial snapshot; the subsequent delivery record above
contains those results.

The existing [combined legal assessment](combined-call-transport-20261023.md)
remains unresolved. This implementation does not establish an Online Safety
Act exemption or absence of operating-system/provider metadata. It adds no
mandatory ForgeSworn directory, credential issuer, room-key holder or call
recording service.
