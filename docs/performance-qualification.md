# Battery and call-capacity qualification

This is the measurement plan for product goals G10 and G12. No supported
headcount or battery target has been established by this document. Keep local
browser measurements separate from named physical-device acceptance.

## Record each run

Record the client version and source commit, operating system, browser/runtime,
device model, power source, start/end times and elapsed measurement time. Count
people, devices, agents and simultaneous camera/audio/share publishers separately.
Record the route actually selected from connection statistics; a requested mesh,
assist, forwarder or TURN route is not evidence that media used it.

Record other work running on the measurement host. Run browser regressions and
capacity workloads separately. Host load averages give context, but cannot
identify another process's contribution or establish a supported capacity.

Use a private local report directory. Do not include room links, signing keys,
chat contents, public keys, IP addresses or ICE candidate strings. Reports need
anonymous device labels, counters, candidate types and codec names. Collecting a
report must not contact an analytics provider.

## Workload matrix

| Workload | Publishers | Variations |
| --- | --- | --- |
| Idle | None | Foreground, background and locked |
| Chat | None | Repeated messages, joins/leaves and reconnect bursts |
| Audio | Every device | Foreground, docked and background/locked |
| Video | Every device | Gallery, speaker view and manually pinned participant |
| Video and share | Every camera, then one and multiple shares | Gallery, share stage and popouts |

For capacity, run 2, 4, 8, 12, 16 and 24 devices, and an explicit above-cap
attempt where the configuration permits it. Run routes separately, then mixed
clients and constrained uplinks. Record the first bottleneck and whether excess
participants receive a usable explanation. A local process with 24 contexts is
24 synthetic browser clients on one host, not 24 physical devices.

For battery, measure at least 45 minutes on a laptop, iPhone and Android phone.
Keep brightness, audio volume, camera resolution, blur/masking, connectivity,
gallery page and popout count fixed across before/after comparisons. Record any
change instead of treating the runs as comparable. A plugged-in Mac mini can
provide CPU and media measurements, but no battery result.

## Measurements and acceptance

The opt-in local collector starts a production PWA build and a deterministic
local relay and joins isolated Chromium clients through the real room controls.
Choose idle, chat-only, audio, video or video with one screen share. Media
workloads wait for usable audio and decoded video from every expected publisher;
idle and chat-only clients keep capture off. It saves per-stream counters,
selected route types, video playback counters, transport counters and renderer
metrics every two seconds. Clients wait for the existing call before joining it. Reports distinguish
requested publishers from successful joins and include the actual measurement
start and elapsed time, including when setup fails. Run it separately from normal CI:

```sh
E2E_PORT=4273 PERF_DEVICES=2 PERF_SECONDS=45 npx playwright test -c playwright.performance.config.ts
```

The default remains a video call. Run the complete synthetic workload matrix
with `PERF_WORKLOADS=idle,chat,audio,video,share`. Chat sends one message per
collection step, rotates the sender and waits for delivery to every client;
reports contain delivery counts and latency, never message contents.

Use `PERF_WORKLOAD=audio PERF_DOCKED=1` to measure a call while one client is
on Home. Use `PERF_WORKLOAD=share PERF_DOCKED=1 PERF_POPOUT=1` to keep a live
share popout open alongside that docked call. The collector measures the
popout as a separate renderer target, verifies both its share and owner-camera
views are decoded, and checks that it has no duplicate audio elements. Primary
and popout samples carry an anonymous device index and presentation label.

Change `PERF_DEVICES` for the capacity matrix and `PERF_SECONDS` up to 2700 for
a 45-minute synthetic soak. The private JSON is under the run's ignored
`test-results/.../performance/baseline.json` directory. Reports always declare
`qualified: false`, zero physical devices and unavailable battery/thermal data.
This collector covers foreground workloads, a docked call and one share popout
on one host. Background/locked operation, route forcing, network impairment,
churn, multiple shares, gallery/speaker/pin comparisons and physical-device
capture remain additional work. It performs no third-party analytics uploads.

HTTP request/response/failure counts and encoded response bytes, plus WebSocket
connection/frame counts and payload bytes, are cumulative from each monitored
target's setup. URLs and frame bodies are discarded. RTP and candidate-pair
counters remain separate from these signalling/file counters. Renderer task,
script and layout durations are also cumulative per CDP target. Compare sample
deltas over elapsed time; these counters are not whole-device CPU, total network
use, or measurements of background service workers and forwarding hosts.

The [10 October workload smoke receipt](evidence/performance-workloads-2026-10-10.json)
records five foreground workloads, docked audio, and a docked share with a live
popout. Each used two synthetic clients for ten seconds on an M1 Mac mini.
These runs establish collector operation and report privacy only; G10 and G12
remain open.

Collect join successes/failures and time to first usable audio/video. Sample
per-stream RTP counters, decoded/encoded frames, packet loss, jitter, audio energy,
round-trip time and selected candidate types. Keep each stream's counters separate:
one healthy stream must not conceal another participant's frozen video or silence.
Treat a counter reset or track replacement as a new series, not negative traffic.

Collect renderer/process CPU and memory, client and forwarding bandwidth,
speaking-indicator delay, visible frame progression, long UI tasks and foreground
recovery. CPU time divided by elapsed time is a per-process ratio; do not label it
whole-device utilisation. Record unavailable platform counters as unavailable,
rather than zero. Read native thermal state and battery level at both ends where
the physical platform supports them.

Set thresholds in the run configuration before qualification. Store that
configuration with the report. A short smoke run establishes that the collector
works; it cannot satisfy the 45-minute gate. Report incomplete samples, collection
errors and failed joins alongside successful measurements. Do not issue a pass
when required metrics are absent.

Optimise the largest observed cost first, then repeat the same configuration.
Re-run with gallery paging, persistent call surfaces, popouts and recording once
those features land, because they change the workload. Keep G10/G12 open until
the required physical runs and supported-envelope report exist.
