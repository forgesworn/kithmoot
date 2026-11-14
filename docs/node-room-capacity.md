# Local node room and call capacity

This is a measurement of one self-hosted node holding up to 64 rooms and
running several two-person calls at once. Everything is a disposable local
fixture: synthetic keys, Chromium fake media, loopback TURN and a loopback
Shelter relay. No live host, public relay or real room is involved. Companion
to [node-call-endurance.md](node-call-endurance.md), whose fixture it reuses.

Measured on one 64 GB Apple M4 Max under macOS 26.6.2 with Node 24.14.0. The
node supervisor, 13 to 17 Chromium contexts and the test run on that one
machine, so process figures are upper bounds on what a node alone would use and
media figures say nothing about Internet quality.

## What was run

Backends, built with the pinned fixture script layout and left unmodified:

| Backend | Source commit | Binary SHA-256 |
|---------|---------------|----------------|
| spry-node (Spry) | `56232d52f0fbfd2f3795a50917890ed6c85e6dc9` (forgesworn/spry-turn) | `91785badc2d9209fea0d7f263a31c9d2087d8cf3f6b6bd663d2acb88c170a440` |
| spry-turn | same commit | `02f2e4c65b8feca58fd7adc2dc2ba1c4c42930c5e0dcf091a404ed02214c9e86` |
| bothyd (Shelter) | `9d75c2c05453b9dbc9f96af1d79455a2cee92382` (sibling checkout, only untracked files present) | `620b2425d9df190a4df03182bec80cbdb0aeb5f0548013f5a41664124a6c5964` |

KithMoot at `2cbff7f0` (origin/main when this branch was cut) plus this branch.
Commands, from the repository root, backend paths absolute:

```sh
export E2E_NODE_CAPACITY=local-only E2E_PORT=4391 E2E_RELAY_PORT=7791 \
  E2E_NODE_CAPACITY_OUT=/absolute/output/dir \
  E2E_NODE_SPRY_BINARY=/absolute/path/to/spry-node \
  E2E_NODE_SHELTER_BINARY=/absolute/path/to/bothyd

# Q1, idle scale. Unpaced is the default; the paced run sleeps 1.5 s before each enrol and each grant.
E2E_NODE_CAPACITY_PACE_MS=1500 npm run test:node-capacity -- -g idle
# Q2 and Q3, call ramps
E2E_NODE_CAPACITY_STEPS=2,4,8 npm run test:node-capacity -- -g concurrent
E2E_NODE_CAPACITY_STEPS=2,4,6,8 npm run test:node-capacity -- -g concurrent
E2E_NODE_CAPACITY_BYTES=8000000 E2E_NODE_CAPACITY_STEPS=2,4,8 npm run test:node-capacity -- -g concurrent
E2E_NODE_CAPACITY_PROFILE=thirtytwo E2E_NODE_CAPACITY_STEPS=2,4,8 npm run test:node-capacity -- -g concurrent
E2E_NODE_CAPACITY_PROFILE=tiny E2E_NODE_CAPACITY_STEPS=1,2,3,4 npm run test:node-capacity -- -g concurrent
```

Profiles: `full` is 512 relay ports, `thirtytwo` is the shipped 32-port default,
`tiny` is 8. Aggregate bandwidth is 2,000,000 B/s unless stated. The suite is
opt-in and skipped without `E2E_NODE_CAPACITY=local-only`; `npm test` and CI are
unchanged. Sanitised results are in
[`evidence/node-room-capacity-20261114.json`](evidence/node-room-capacity-20261114.json).

Fixture choices that a real deployment does not share: the supervisor ticks
every 2 s (as production does); every simulated room and device sends a distinct
`x-forwarded-for`, because all loopback traffic would otherwise share the
desk's 120 requests per minute per source; the node's own supervisor to Spry
traffic still shares one source, which matters below. The fixture gained
additive options (`maxRooms`, `relayPortFirst`, `heartbeatMs`, `diagnostics()`)
with unchanged defaults.

## Q1: 64 rooms, no calls

With `maxRooms` 64, 64 rooms and 191 granted devices (two to four per room) were
enrolled, then the node idled for 360 s with polling, including every device
asking for credentials after the five minute lifetime.

| Measure | Paced (1.5 s per mutation) |
|---------|----------------------------|
| Enrol and grant, 255 mutations | 397.9 s, no failures |
| Enrol latency (p50 / p95 / max) | 50 / 83 / 190 ms |
| Grant latency | 60 / 80 / 225 ms |
| Ready after the last mutation | 5 ms |
| Forced reconcile tick at 64 rooms (p50 / max) | 10.4 / 11.6 ms |
| One mutation at full size | 204 ms |
| 65th room | 429 `too-many-rooms` |
| Access poll (736 polls, p50 / p95 / max) | 158 / 207 / 232 ms |
| Credential request (736, p50 / p95 / max) | 45 / 121 / 163 ms |
| spry-node RSS, empty to 64 rooms | 3.6 to 7.1 MB, CPU about 0.1 per cent |
| bothyd RSS, empty to 64 rooms | 9.3 to 34.2 MB, CPU about 0.1 per cent |
| Test worker (hosts the supervisor) RSS | 185 to 352 MB |
| Spry refusals | 0 |

Idle is cheap. Credential renewal past 300 s produced no problems across all
192 devices polled. Every poll was answered with no problem recorded. The node reports 192 devices
against 191 granted by the test; the extra one was not identified.

### Finding: a burst of enrolments is refused by the node's own Spry client

The first, unpaced run enrolled rooms about 20 ms apart. Rooms 0 to 14 were
accepted; from room 15 every enrol returned 503 `children-pending`. Tracing the
supervisor's backend calls showed 49 Spry refusals, all HTTP 429 (one `offer`,
48 `register`). Cause: every mutation reconciles the whole node, and each
reconcile makes at least one `POST /v1/node/lease` plus registrations, all from
the supervisor's single source address, while Spry limits each source to 120
POSTs per minute (`count` in `spry-access`). In this run 387 supervisor calls were
made in under two seconds. The node recovered unaided and reached ready after
59 s as the window rolled, but the failed enrols had already been written to the
ledger and their devices were never granted. At the production 2 s tick the
tick alone is about 30 lease POSTs per minute, leaving roughly 90 for
mutations, so sustained enrolment above about 45 mutations a minute (two POSTs
each) is refused with 503 while rooms and devices created by a person at a
keyboard are far below that. Not measured: whether the shipped client retries
a 503 enrol, and whether a bulk restore or migration of many rooms would hit it.
The paced run (1.5 s, about 40 mutations a minute) never did.

## Q2: concurrent two-person calls

Each call is two guests in its own room, real browser media (fake camera and
synthetic microphone) over relay/relay candidates. A call counts as proven only
if both directions advance decoded frames, audio packets and audio energy over a
10 s window. The relay figure is Spry's `udpForwardedBytes` delta over that window.

| K | Result (full profile, 2 MB/s) | Relay B/s | Live allocations | Refusals |
|---|-------------------------------|-----------|------------------|----------|
| 2 | 2 of 2 proven (every run) | 441,000 to 486,000 | 8 | 0 |
| 4 | 4 of 4 proven (every run) | 925,000 to 985,000 | 16 | 0 |
| 6 | 5 of 6 proven (4 of 4 runs) | 1,302,000 to 1,446,000 | 24 | 0 |
| 8 | 4 of 8 proven (2 runs: 2 MB/s and 8 MB/s) | 1,831,000 to 1,844,000 | 31 to 34 | 0 |

Every call connected on relay candidates at every K, in 0.4 to 2.1 s. Relay
traffic is about 230 to 245 KB/s per call, linear in K. K=8 used about 92 per
cent of the 2,000,000 B/s limit; extrapolating that linear rate puts the limit
near nine calls, which was not run. Raising the limit to 8,000,000 B/s changed
nothing at K=8, and no allocation, quota or bind refusal was counted, so the
bandwidth limit was not what failed.

### The K=6 and K=8 failures are not attributed to the node

At K=6 exactly one call is not proven, in all four runs (rooms 5, 6, 5, 6). In
every case the sender had a live, enabled, unmuted audio track but sent zero
audio RTP packets while video flowed in both directions through the relay (about
570 video packets and 520 KB over the window). At K=8 four calls show the same
audio-sender stall (rooms 5 to 8). A 30 s settling re-check did not recover any
of them. The same stall appears on the 32-port profile (K=8: 4 of 8). It does
not occur at K=2 or K=4 in any run, which is before the shared Chromium holds more than ten guest pages (the keeper
makes eleven at K=5). The evidence points at the capture
side (a live track producing no samples) rather than the relay, which forwarded
the traffic and reported no refusal. It is unresolved: a harness limit of 12 or
more fake-audio streams in one browser and an application fault are both
consistent with it, and no control run separates them. So the first K at which
something failed in this harness is 6, but the first K at which the node
refused anything is not 6. Treat K=6 and K=8 as not measured for node capacity.

## Q3: overload and what the user sees

The 32-port shipped default was run to K=8 and held 31 live allocations with zero
refusals (about four allocations per call, plus some restarts), so it is at the
edge for eight calls and cannot take a ninth; a ninth call was not run because
the audio stall above ends every ramp at K=8. To see a real refusal the `tiny`
profile (8 ports, so two calls) was used.

| K | Result (tiny, 8 ports) | Allocations | Allocation quota refusals |
|---|------------------------|-------------|---------------------------|
| 1 | proven | 4 | 0 |
| 2 | proven | 8 | 0 |
| 3 | not connected, 2 of 3 proven | 8 | 22 (30 after the 40 s re-check) |

What the third call showed:

- Browser: ICE candidate errors 486 ("TURN allocate error") on the UDP and TCP
  TURN URLs and 701 on the TLS URLs; no connected pair, in either direction.
- Screen: the ordinary in-call view, "On the call with Guest.", with the Leave
  button. No message, no banner, no failure state. Nothing in the visible text
  differs from a working call.
- Node status: `ownerStatus` stays `ready: true`, `turnReady: true`,
  `relayReady: true`, with no capacity or refusal field. The refusals appear only
  in Spry's `/v1/node/status` metrics (`allocationQuotaRefusals`), which the app
  does not read. Process stderr was empty.
- App code (read, not exercised by a screen): ICE error codes 401, 403, 486 and
  508 mark the route `refused` and do not try another route; the "node is full"
  wording is used only for the room cap (`too-many-rooms`).

So, as built, the app cannot tell "node full" from "network broken" for calls. A
room refused at the cap is told so; a call refused at the TURN allocation budget
looks like a call that never connects.

## Not run, and fixture faults

- K above 8, a ninth call on the 32-port profile, a bandwidth override below the
  natural load, and a long soak with calls running (the endurance spec covers six
  people for 45 minutes).
- A paced run at the shipped 2 s tick over a longer period, retry behaviour of
  the shipped client on 503 enrol, and any physical-device result.
- Fixture fault, fixed: the first ramp died on `ECONNRESET` when the harness
  client reused a keep-alive socket the desk had just closed (it closes idle
  sockets after 5 s). The harness now retries and counts these; the later runs
  recorded zero retries.
- Fixture fault, unresolved: the audio-sender stall above.
