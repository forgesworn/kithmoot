# Node calls and network changes

A person can use KithMoot in a web browser, the desktop app or the mobile app.
Managing rooms is a role belonging to their account, not a special physical
device. Each device still needs its own admission and room keys.

Turning a VPN on or off, changing Wi-Fi and moving to mobile data must retain
the room and recover its connection. Node rooms keep using their chosen node.
They do not fall back to public relays or another TURN service.

The browser fetches fresh node credentials when an established connection
loses its route and asks the room protocol to rebuild that participant pair.
Other participants keep their healthy native connections. The original global
rotation and oldest allocation expiry remain in force: a per-peer login must
not postpone renewal for peers still using an older login. Scheduled renewal,
explicit local network recovery and recovery near expiry rotate every pair.
Concurrent failed pairs share one credential request; a failure during an
in-flight renewal is retained, even if the issuer returns the same login.

A native ICE restart can retain a TURN allocation tied to an earlier username,
which then expires even while the app holds a newer login. Fresh native
connections allocate with the installed credentials. Profile 2 keeps its
generation history; legacy pairs restart on TURN. Returning online or changing
the network type also reconnects the room relay and admission inbox. Only
physical network type changes trigger that watcher. Estimated effective
connection type, latency and throughput do not restart a call. A peer that
never connected cannot restart healthy calls; an established peer requests
one refresh per failure episode.

An established connection losing its route also reopens the authenticated room
signalling socket before rebuilding peers. A WebSocket can still report itself open
after a route change while its offers go nowhere. Refreshing TURN alone cannot
repair that socket. Concurrent recovery requests share the same reconnect.

The browser also checks the authenticated room and admission sockets every five
seconds, independently of the HTTP refresh. A socket that has heard nothing for
five seconds gets a bounded read probe in its existing room partition. A silent
socket is replaced and its subscriptions restored, even when no chat message is
being sent and the HTTP endpoint remains reachable.

Subscription retries also wait for the authenticated connection to open.
Previously an eleven-second handshake queued three generations of requests;
obsolete readers all sent before their queued closes, overflowing the room
relay's sixteen-subscription limit. The corrected client checks that a reader
is still current before sending and starts its silence timer after connection.
The relay's capacity and admission policy stay the same.

Node connections also register with the browser's media receiver registry.
Video tile binding and recovery use that registry when a browser omits a track
notification during a rebuild. Registering each native peer through the pinned
factory keeps its node policy while letting the UI find and restore live video.

Node sessions start the call manager on its TURN route, including after a retry.
Their factory already requires relay-only ICE. Applying the shorter direct-route
timer first created a second TURN connection and interrupted the first attempt.
The regression checks that the first connection gets its relay budget and a
retry starts on TURN again.

HTTP 408, 425, 429 and server failures are temporary unavailability. They do not
revoke a valid signed admission. Explicit refusal, signed removal and closure
retain their existing enforcement. Old TURN credentials still expire within
five monotonic minutes; reconnecting cannot extend an expired login.

The room reports reconnection and clears that notice after a successful node
check. The Archy controls are a separate private management connection. A
stopped SSH tunnel must not be described as proof that the public room service
or a call has failed.

## Verification

- The [delayed authentication regression](evidence/kithmoot-node-subscription-recovery-20261103.json)
  holds a real NIP-42 signer for eleven seconds. Eleven readers are opened and
  one cancelled. The previous client sends thirty-one requests; the corrected
  client sends exactly the ten current requests and stays below the relay cap.

- The [socket liveness regression](evidence/kithmoot-node-socket-liveness-20261103.json)
  uses a real WebSocket server and device-signed NIP-42 authentication. It stops
  answering the initial socket without closing it, then verifies reconnection,
  reauthentication and resubscription without publishing an event. The previous
  no-op probe fails this check.

- Focused SDK/access/admission/closure tests cover temporary failure, retry,
  concurrent reconnection, fresh relay-only allocations, generation progression,
  withdrawal and expiry. SDK users without a protocol rebuild callback retain
  the native ICE restart fallback; the browser runtime supplies the callback.
- The actual-process Chromium journey injects a temporary credential HTTP 503,
  triggers the online event, verifies retry and recovery, then admits guests,
  exchanges encrypted chat and verifies removal and room closure.
- The [video recovery regression](evidence/kithmoot-node-video-recovery-20261103.json)
  suppresses video track notifications. The prior production renderer leaves
  empty tiles; the corrected renderer recovers moving remote pixels and real
  synthetic microphone audio in both browsers. It also restores detached video
  elements and completes the admission, removal and closure journey.
- The first production public call run used two admitted browser guests in an
  isolated container whose firewall allowed media only over TCP443. Both
  received audio and decoded video through `turns:turn.demo.forgesworn.dev:443`.
  A transient disconnect was followed by new media in both browsers. That run
  did not instrument the physical network route or qualify every VPN.

The strict public test matches the two test browsers by their mutual DTLS
fingerprints and counts only media they exchange with each other. Room-wide
media totals can hide a frozen pair when another participant still sends.
Production release `20261103T155431Z` and the subsequent rotation-grace candidate
failed that stricter renewal gate. The [allocation replacement candidate](evidence/kithmoot-node-matched-pair-tls443-20261103.json)
passed 479 seconds over TURN TLS443, including VPN on/off, a 12-second outage
and renewed credentials in both browsers. Media continued for 314 seconds after
the final recovery, without a steady media gap over 25 seconds. VPN recovery
took 42 seconds on and 11 seconds off; outage recovery took 15 seconds.
There were no subscription overflows or browser errors.

That run served source `599467de` under production headers against the real
public node, with a controlled WireGuard route carried through private SSH.
Release `20261103T165540Z`, merge `3de4f219`, deploys the same main script bytes.
Its public index, entry script and main script were compared byte for byte.
Two fresh production browsers then exchanged matched-pair video and audio for
28 seconds without candidate interception.
Independent mobile networks, commercial VPNs, physical GrapheneOS and capacity
remain distinct evidence gates.


The subsequent [scoped recovery run](evidence/kithmoot-node-scoped-recovery-tls443-20261103.json)
checks source `44a923c9`. A three-browser native regression first shows that
a failed pair closes while the healthy participant keeps the same native
connection with increasing decoded video and received audio. The previous
production source fails that check by closing the healthy connection. Both
the complete native room journey and this regression pass with the correction.

The public matched-pair run passed 459 seconds, including 312 seconds after
final recovery across the prior login expiry. VPN recovery took 13 seconds on
and 36 seconds off; recovery after the 12-second outage took 8 seconds. The
25-second steady media-gap limit remained in force. Scheduled renewal retained
the original allocation deadline despite earlier per-peer refreshes. There
were no browser errors or subscription overflows; peak subscriptions were 13.
A cached-login-only candidate had failed the VPN-off recovery gate and was
replaced by this fresh-per-peer-login implementation before merge. These
results do not establish instantaneous handoff or eliminate every visible pause.

PR688 merged as `d7ce79ef`; release `20261103T221208Z` deploys the qualified
main script (`57a1391e03c04fabed2636201e3ae8cccefbc8474b31147cd6fbcd10f323be0f`).
The public index, entry script and main script match the local build byte for
byte, with no diagnostic hook in the production renderer.

Two browsers using the deployed renderer then passed a 24-second direct-route
matched-pair smoke test over node TLS443 without candidate interception. They
received 420/443 decoded video frames and 1,240/1,332 audio packets. One earlier
repeated startup timed out before the second guest reached the call stage;
subsequent device-signed access checks returned active in about half a second,
and the accepted production run needed no manual retry. The cause of that
startup timeout is not established. This does not qualify every initial join
or replace the longer credential-renewal gate.


## Startup retry and allocation pressure, 4 November

The [startup and allocation regression](evidence/kithmoot-node-startup-allocation-20261103.json)
reproduces two further defects. Initial access and TURN-login requests now get
at most three attempts after temporary unavailability, with cancellable 500 ms
and 1,000 ms waits and a fresh signed proof each time. Refusal, invalid data,
navigation and cancellation remain terminal. This improves initial connection
resilience; it does not establish the cause of the earlier production timeout.

The node peer factory now uses `max-bundle`. Previously four media slots could
gather separate TURN transports before negotiation, consuming the existing
allocation quota while old and replacement connections overlapped. The native
regression creates six peers for three devices, then six replacements while
retaining the original batch. The previous factory loses primary relay
candidates and receives quota errors. With the correction, all twelve peers
retain primary candidates without quota errors. The quota is unchanged. This
is an allocation-gathering check over fixture UDP/TCP, not a capacity, TLS or
route-recovery latency measurement.

PR690 merged as `ecf73fea`; release `20261104T013619Z` deploys main script
`b25a7587f7586e3347147f405535f2f5a22350c7c51fa7200f0881882dff3ce2`.
Normal public HTTPS readback verifies byte equality for the index, entry and
main scripts and no production diagnostic hook. Eighty-nine focused tests pass
(two skip), typecheck/build pass, all five applicable hosted checks pass, and
three actual-process native browser journeys pass.

The deployed renderer also passes the complete sixty-second room journey with
real isolated Spry/Shelter processes, including an initial guest HTTP503,
moving remote video and synthetic microphone audio, detached-sink recovery,
silent signalling recovery, removal and room purge. Renderer assets are loaded
directly from the public deployment without interception. Test HTTP forwarding
and WebSocket bridges connect that public page to the private fixture; its
self-signed TLS is accepted only in the test context. Public deployment TLS is
verified separately with normal certificate validation.

At that release point the stricter public VPN gate had **not run**: fresh test
guest admissions could not be completed while the owner's Mac was locked. No owner
keys were accessed and no admission was bypassed. The required recovery limit
remains twenty seconds, followed by a 310-second media soak across the prior
login expiry. The earlier 36-second VPN-off observation remains historical
proof, not a passing result for that tighter gate. A direct/VPN/direct HTTPS
probe passed, which does not qualify media. No physical phone was available;
Wi-Fi/mobile handoff, commercial VPNs and GrapheneOS still need field checks.


## Public recovery follow-up, 4 November

Two further failures were reproduced on the public node. Spry reached its
32-TCP-connection ceiling while most relay allocation slots remained free.
[Spry PR35](https://github.com/forgesworn/spry-turn/pull/35) raises the independent
TCP/TLS connection bound to 64. Relay allocations remain capped at 32, eight per
username, with the existing bandwidth, expiry and revocation rules. A real
TCP/STUN regression fails at handshake 33 on the old profile, accepts 64 with
the correction, refuses handshake 65 and retains an existing connection.
Supervised mode retains its default of 16 connections.

A separate profile-2 race left a fresh connection with no remote description
and no media slots. Early ICE candidates can bind both opening channels before
their offers arrive. The polite side then replaced its connection for an offer
addressed to the previous connection, which the new channel correctly refused.
[KithMoot PR692](https://github.com/forgesworn/kithmoot/pull/692) resolves this
addressed opening collision by advancing the generation. Offers addressed to
a retired connection are rejected before glare handling. Two regressions fail
on the previous source and pass after the correction.

Web merge `9e8d547a`, release `20261104T035132Z`, serves
`main-Cu0BWARh.js`, SHA-256
`2ffd840ad371f876562518a3df63e5213bc0ebca7b985b61808e32acf7091153`.
Normal public HTTPS readback verifies byte equality for the index, entry and
main scripts and no production diagnostic hook. The private demo image is
`localhost/kithmoot-node:0.1.0-rc.1-8961b322e310`, with Spry source `b5ce9690`
(merged as `92b3418d`) and binary SHA-256
`d25a45c196da24f3e8f2950e7853642aab0de9c7ded7a7989291ece62b077dbd`.
The controller and other bundled components are unchanged.

The focused suites pass 102 tests, typecheck and production build pass, and all
five applicable web CI checks pass. Three browser journeys with actual isolated
Spry/Shelter processes pass in 1.9 minutes: admission, initial HTTP503 recovery,
chat, moving video, synthetic microphone audio, detached sinks, signalling
recovery, removal, room purge, allocation pressure and a healthy third
participant during another pair's repair. The corrected Spry profile also
passes its workspace/minimal-feature tests, clippy, secret scans and 41
interoperability checks; twelve hosted checks pass, with publication skipped.

The public candidate's short diagnostic recovers in 13 seconds after VPN-on,
13 seconds after VPN-off and four seconds after a twelve-second outage. Its
32-second final soak does not qualify credential renewal. The separate deployed
production receipt records the longer gate. Physical Wi-Fi/mobile handoff,
commercial VPNs and GrapheneOS remain unqualified. Android publication remains
0.6.132; no signed public node or Shelter release is implied.

The [deployed production receipt](evidence/kithmoot-node-public-vpn-recovery-20261104.json)
passes the full gate without renderer interception: 430 seconds of matched-pair
audio/video over publicly trusted TLS on port 443, with recovery in 13.162
seconds after VPN-on, 10.860 seconds after VPN-off and 8.447 seconds after the
twelve-second outage. The call continues 310 seconds after final recovery,
with both guests renewing their logins and media advancing beyond the prior
login expiry. Each observed login lasts at most 300 seconds. There are no page
errors, HTTP authentication refusals or subscription overflows. The existing
admitted device identities are reused; recovery creates no new admissions.
The isolated WireGuard route changes only the test container, with IPv6 and
UDP media blocked. Both selected endpoints and every signalled remote
candidate remain in the node's relay range. This qualifies the controlled
browser case, not physical mobile networks or every VPN.

Scheduled login renewal in that release produces a sampled media pause: two consecutive
checks report no progress, with seven seconds between advancing samples. This
passes the retained 25-second steady-phase guard, but does not establish
seamless playback. It remains a separate quality improvement from the
twenty-second route-recovery gate qualified here.

## Media handover during node login renewal

Node profile-2 connections now retain one connected transport while its
replacement negotiates with a fresh TURN login. The replacement takes over
received tracks one second after connecting. The old transport closes then,
or after twenty seconds if replacement fails. Repeated repairs cannot extend
that deadline or accumulate additional retained generations. Other peer
factories keep their existing immediate replacement behaviour.

Muted tracks and narrower audiences apply to both generations. Closing a peer,
withdrawing access or closing the node factory closes retained transports immediately.
The factory ignores connectivity failures from a retiring generation. The web
receiver registry retains the connected receiver until its replacement connects;
closing the old generation cannot erase the new registry entry. This does not
extend the five-minute TURN login lifetime or change the relay-only policy.

## Restore readers when a relay socket reconnects first

An actual production VPN-on run of `074dbb8f` misses the twenty-second gate.
One browser authenticates a replacement relay socket and receives write
acknowledgements, but its persistent room subscriptions are absent. It cannot
receive the call answers. This failure is retained separately from the passing
429-second handover candidate; matching asset bytes alone do not qualify every
network transition.

Reader recovery previously checked the disconnected-dial cooldown before it
checked whether the socket was already connected. A publish could reopen it,
leaving closed readers waiting fifteen seconds. The cooldown now applies to
disconnected or authenticating sockets. Closed readers on a connected socket
restore on the next five-second recovery tick, preserving healthy readers,
permanent refusals, read-rate holds and individual resend backoffs. The
regression fails on the previous source and passes after this correction.

## Legacy answers after a connection replacement

The full browser matrix and a local replay reproduce a one-way-media failure
after joining through a relay that is half-open for ten seconds. Profile-1
offer numbers restart at one when the route ladder replaces a connection.
A delayed answer for the retired direct offer can therefore settle the new
TURN offer, leaving ICE connected but DTLS unable to carry media.

The mesh now allocates increasing offer numbers per remote endpoint across
connection replacements. Peers still use the existing optional `seq`/`re`
fields; replies without correlation retain their legacy handling. A delayed
answer regression fails on the old source and passes after the correction.
The real browser reproduction now receives host camera and microphone without
pressing Join again. Its 51.3-second run includes the initial ten-second fault
and cold room entry; it is distinct from the established node call's
twenty-second network-recovery gate. The related suites pass 230 tests with
five existing skips.

The redial timer also rechecks the shared backoff deadline when it wakes. A
millisecond-early timer, or a deadline extended by another pool, keeps the
retry pending until it can dial. Previously that retry was consumed by the
dial gate and readers waited for a later recovery cycle. A fake-clock
regression reproduces the early-wake failure before the correction and verifies
that the same pending retry connects as soon as the deadline arrives.
