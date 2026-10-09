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
local relay, joins isolated Chromium clients through the real call controls and
waits for decoded video from every other client. It saves per-stream counters,
selected route types, video playback counters and renderer metrics every two
seconds. Clients wait for the existing call before joining it. Reports distinguish
requested publishers from successful joins and include the actual measurement
start and elapsed time, including when setup fails. Run it separately from normal CI:

```sh
E2E_PORT=4273 PERF_DEVICES=2 PERF_SECONDS=45 npx playwright test -c playwright.performance.config.ts
```

Change `PERF_DEVICES` for the capacity matrix and `PERF_SECONDS` up to 2700 for
a 45-minute synthetic soak. The private JSON is under the run's ignored
`test-results/.../performance/baseline.json` directory. Reports always declare
`qualified: false`, zero physical devices and unavailable battery/thermal data.
This first collector covers all-camera/all-audio direct mesh on one host;
chat-only, route forcing, network impairment, churn, popouts and physical device
capture remain additional work. It performs no third-party analytics uploads.

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
