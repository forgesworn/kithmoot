# Desktop Spry hosting: first implementation and acceptance

Owner direction, 26 October 2026: KithMoot desktop is the first app to explore
optional Spry hosting. Privacy and performance are acceptance criteria. The
initial environment uses a commercial Proton VPN, not a shared private mesh.
ForgeSworn supplies software and runs no relay, credential broker or directory
for this design. The owner's Archipelago node remains private and unchanged.

## Implemented development preview

`desktop/spry-hosting.mjs` supervises the separately supplied native process.
The desktop main process now imports it through native controls in
`desktop/spry-hosting-controls.mjs`. The File menu exposes Start/Stop only in an
unpackaged run with an explicit absolute `KITHMOOT_DESKTOP_SPRY_CONFIG` path.
Packaged and unconfigured builds show no hosting entries. There is no renderer,
PWA or preload command for starting hosting, choosing an executable or obtaining
its credentials. This is a local development preview, not a released hosting
capability; no native executable is bundled.

Hosting is Off on every launch. Only an explicit native action reads the owner
configuration: at most 8 KiB of JSON, exact keys, a regular file, an absolute
executable path and validated addresses/ports. Nonblocking open refuses a FIFO
without waiting for a writer. The owner must review the executable; an absolute
path alone does not authenticate it. A native warning defaults to Cancel and
states the listener, allocation range, resource limits, metadata, bandwidth,
applicable laws and ISP/VPN terms. Nothing is advertised or shared.

For a local development check, use this shape in an owner-controlled file:

```json
{
  "executable": "/absolute/path/to/reviewed/spry-turn",
  "listenIp": "127.0.0.1",
  "port": 3478,
  "relayPorts": [49160, 49191]
}
```

After building the desktop web bundle using the existing desktop instructions,
launch with `KITHMOOT_DESKTOP_SPRY_CONFIG=/absolute/path/to/owner.json` in the
environment. Open **File → Local call relay: Off…**, review the warning and
explicitly choose Start. Running (local bind) is not a reachability result.
The separate Stop menu item cancels a pending start or stops the current process.
This example binds loopback and offers no Internet hosting.

Construction opens no sockets, starts no process and schedules no background
work. An explicit `start()` supplies a concrete local IPv4 address, a listener
port and a separate UDP relay range of at most 32 ports. The trusted host must
supply an absolute path to its reviewed native executable; the module neither
downloads a binary nor searches `PATH` or executes a shell.

Each run gets a new random 32-byte secret, passed to the child in its environment
and never returned in state, credentials, errors or observer notifications.
Inherited `SPRY_*` variables are removed before configuration, so a pre-existing
public-mode setting cannot silently enable another profile. Other environment
variables remain inherited. JavaScript strings and OS process environments are
not reliably zeroised by this module.

The child receives fixed caps: 32 allocations, eight allocations per credential,
32 TCP connections and 1,000,000 aggregate bytes per second **per allocation**.
This is not a total bandwidth or monthly data cap. Enforcement depends on the
chosen native executable. No media or room keys pass through the supervisor;
the native process owns TURN authentication and packet forwarding.

State is `off`, `starting`, `running`, `stopping` or `failed`. Running requires
the expected native readiness line with the configured endpoint. The
`locally-bound` exposure value means that the process reported a local bind;
it does not mean loopback-only, restricted to a VPN or externally reachable.
Raw stdout is discarded. Only a bounded readiness-line buffer is parsed from
stderr, without retaining or forwarding raw child logs.

`credentials({ ttlSeconds })` creates an opaque, unique TURN REST login while
running. The default lifetime is five minutes and the maximum is one hour,
using the trusted host's clock. A later UI or encrypted access adapter owns
sharing and renewal; no such sharing path is implemented here.

Stop cancels an unfinished start, removes local credential-minting authority,
requests termination and escalates to a kill if needed. It waits for observed
child exit before reporting Off. An unreaped child leaves a failure and blocks
replacement; stale output cannot make a stopped generation Running again.
Normal application exit awaits Stop. The supervisor also exclusively owns a
private stdin pipe and supplies native `serve --exit-on-stdin-close`. The Rust
process watches EOF/read errors on a separate blocking thread, independently
of forwarding work. Loss of the parent closes the pipe and ends the entire
native process; that hard exit bypasses destructors and relies on OS socket
cleanup. It is opt-in and does not change standalone server behaviour.

Native controls invalidate pending configuration/consent on Stop, accepted
close, quit, suspend or renderer crash. Close/quit await confirmed native exit;
newly active calls are rechecked before an asynchronous reclose. Cancelled
unsaved-work/call prompts invalidate older quit continuations. Update installation
awaits Stop and rechecks the trusted main-frame caller, call and lifecycle state.
Resume requests Stop again and enables only another explicit start. No automatic
restart is provided. Actual OS suspension may freeze the process before shutdown
finishes; synthetic lifecycle events do not prove zero traffic on wake or VPN loss.

## Proton is a route to qualify

Proton's [port-forwarding guide](https://protonvpn.com/support/port-forwarding),
checked 26 October 2026, documents paid-plan/P2P support on desktop, with macOS
marked early access. The assigned port can change on reconnect. Its
[manual configuration guide](https://protonvpn.com/support/port-forwarding-manual-setup)
documents the same assigned port for UDP/TCP, a 60-second lease and renewal
every 45 seconds.

That establishes a feature to investigate, not working Spry hosting. Standard
TURN needs both its client listener and reachable UDP allocation endpoints.
Proton's documented single forwarded port does not cover the current Spry
UDP/TCP listener plus its separate UDP allocation ports. The documentation does
not establish supported multiple distinct mappings, arbitrary requested ports
or a contiguous range; this does not prove Proton rejects every such request
or that all TURN designs are impossible through Proton. Neither the required
mappings nor their advertised ports have been tested through Proton.
This supervisor has no Proton API integration, mapping renewal,
route enforcement, interface monitoring or VPN kill-switch proof. It neither
changes VPN settings nor falls back to another bind address.

A separate [operator-run mapping diagnostic](2026-10-26-proton-mapping-diagnostic.md)
now validates an explicit source/gateway plan without network traffic by default.
Its explicit live mode requests a bounded set of mappings and one renewal cycle;
it is not connected to the hosting controls. Initial local wire fixtures passed
offline. A later live address-only Proton preflight returned connection refused
before any mapping requests. Mapping replies alone cannot establish ownership,
independent expiry, reachability or VPN confinement.

The native development source now accepts exact local/public UDP allocation
pairs, with separate ownership accounting and local socket tests. Desktop
hosting controls still need the route/lease adapter, listener advertisement and
encrypted Nostr access integration. See the
[privacy and one-click requirements](2026-10-26-call-privacy-and-one-click.md):
audio/video never goes over Nostr relays, and TURN media encryption does not hide
connection metadata from the chosen TURN operator.

Before offering a Proton route, establish supported distinct mappings and
independent lease renewal. Noncontiguous allocation mappings need an explicit
allowed-port set; translated external ports need a matching native adapter.
An advertised public IP alone does not translate ports. Then prove inbound
listener and allocated-peer traffic from a separate network, exact address/port mapping, lease renewal,
reconnect and route-loss behaviour. Do not publish an untested endpoint, silently
switch to a home address, split-tunnel the process or weaken relay-only mode.
Any independent transport alternative remains selected by the user.

## Nostr announcements and access

Use the user's selected independently operated public Nostr relays for the
bounded control path. Keep high-volume media on native transport. Public relay
use does not mean access messages must be public plaintext.

Existing Spry `spry-link` uses signed NIP-44 encrypted request/response kinds
24181/24182, with recipient tags and 30-second expiry, for paired private access.
These kinds are ephemeral under [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).
They are not NIP-59 gift wraps. The existing private-node profile needs an IPv6
ULA peer route; a commercial VPN alone does not supply it. Reusing the control
protocol with ordinary desktop TURN needs a host adapter and cross-client tests.

Existing public kind 31478 adverts use expiration/renewal/withdrawal and describe
an operator's HTTPS credential endpoint. They are separate from ephemeral
live access messages. Anonymous public credentials over Nostr are not currently
supported by that protocol. Do not reinterpret the advert format or create a
second encrypted access protocol without reviewing the operator/client contract.

Ephemeral requests suit online exchanges with bounded timeouts, replay checks,
deduplication and retries. Announcements for later arrivals need independently
discoverable, expiring state. [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md)
does not guarantee deletion from relays or observers. Encryption protects
content, while connection addresses, timing, kinds and public author/recipient
tags can still reveal metadata. Keep root secrets, room keys and reusable logins
out of public announcements. Hosting and advertising remain separate opt-ins.

## Acceptance and next integration

The supervisor unit tests cover configuration rejection, explicit activation,
credential lifetime and secret redaction, duplicate starts, cancellation,
startup failure, stale callbacks and bounded termination escalation. A generated
local executable separately exercises real process and socket lifecycle.

The native acceptance test requires a task-owned Spry executable:

```sh
KITHMOOT_TEST_SPRY_BINARY=/absolute/path/to/reviewed/spry-turn \
  node --test desktop/test/spry-hosting-native.test.mjs
```

It uses loopback and generated credentials only: UDP/TCP STUN binding,
anonymous allocation refusal, an authenticated TURN allocation with verified
response integrity, allocation/listener release on Stop, restart and refusal
of the preceding run's login. A second test creates an authenticated allocation,
kills a separate Node supervisor with SIGKILL during incoming traffic, and
requires allocation UDP and listener UDP/TCP ports to become bindable within
three seconds. It prints the executable hash. These are local
protocol/process checks, not a media call, Proton test or performance result.

The [26 October receipt](evidence/desktop-spry-hosting-20261026.json) records
the final desktop test counts, native and Electron checks, source hashes and
unpassed gates. The task-owned native build is removed after recording the
evidence; reproduce the check from the recorded Spry base plus the separately
hashed native changes. No uncommitted binary is a distributable release.

`desktop/test/spry-hosting-electron.mjs` separately exercises the actual desktop
main/menu/preload entry points copied into a disposable offline fixture, using
a real native Spry executable and a synthetic page. Native dialog answers are
injected; no camera, microphone, account, screen capture or public relay is used.
Run it with reviewed `ELECTRON_EXECUTABLE` and `KITHMOOT_TEST_SPRY_BINARY` paths;
it imports the existing Playwright dependency. `KITHMOOT_TEST_PLAYWRIGHT` can
select an absolute test-only module path when reusing an existing installation.
The macOS Electron 44.4.1 check passed Start/Cancel/Stop, stale consent,
synthetic suspend/resume without restart, refused development update, renderer
crash cleanup, a newly arriving call during asynchronous Stop, call/unsaved-work
quit cancellation, close/reopen Off, normal quit and unconfigured menu hiding.
This checks lifecycle integration, rather than the full KithMoot web bundle,
real system sleep or a packaged installation/update. The receipt records the
completed scenarios and their limits.

Before a desktop hosting button can ship:

1. Supply reviewed binaries and source/licence material for the selected desktop
   platforms; verify packaged paths and signatures without runtime downloading.
2. Qualify native parent-pipe supervision and desktop lifecycle on each supported
   installed platform, including full-bundle close/quit cancellation, updates,
   physical sleep/wake, crash recovery and firewall refusal.
3. Replace the owner configuration preview with a reviewed production hosting
   flow while preserving Off, explicit consent, bounded limits and Stop. Public
   hosting and advertising need separate explicit choices. Add enforceable total
   data/bandwidth policy before promising a total cap.
4. Qualify the selected route, including Proton if used, and keep Running
   separate from tested external reachability. No publisher-operated probe.
5. Integrate existing encrypted access and optional adverts only after route
   and operator/client protocol qualification. Keep private scope separate.
6. Compare idle-off/idle-on CPU, memory, wakeups and network use, and measure
   throughput, latency, jitter, loss and Stop latency under sustained traffic.
   Native poll timeouts alone do not bound total event-loop work.
7. Refresh privacy/operator wording from actual behaviour, perform installed
   app and independent-network media acceptance, and record the exact revision.

The operator boundary remains the draft reading in the
[call transport position](legal/call-transport-position.md), not a legal
exemption. Archipelago UI and its maintainer ZAT remain separate; no Archipelago
screen, package or running node is changed by this preview.
