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
