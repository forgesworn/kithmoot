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
seamless playback. The later bounded media handover and production qualification below address
that sampled renewal pause separately from route recovery.

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

## Deployed handover and reader correction, 4 November

[PR694](https://github.com/forgesworn/kithmoot/pull/694) adds bounded media
handover; [PR695](https://github.com/forgesworn/kithmoot/pull/695) restores room
readers promptly on a recovered socket. [PR696](https://github.com/forgesworn/kithmoot/pull/696)
adds legacy answer sequencing and reliable redial deadlines. Web merge
`0102c468`, release `20261104T061508Z`, serves `main-BFWLf0Zy.js`, SHA-256
`c040497d7a78d1d4785c71d74af03bc573464b9e71cdf47b18d28f094205825f`.
Normal public TLS readback verifies index, entry and main byte equality and
the absence of the production diagnostic hook. The private node image remains
`8961b322e310`, with the controller and host revisions unchanged.

The reader correction passes 110 pool, authentication, dial-gate, node-client
and browser-node-runtime tests. The earlier handover correction passes 174
focused tests with three existing skips. Typecheck, web and desktop builds,
secret scans, and all five applicable PR checks pass. Three real Spry/Shelter
browser journeys pass in two minutes. The obsolete desktop Calls-row assertion
now includes the existing node row first; its desktop-browser regression passes
in four seconds, with no UI change.

The reader candidate passes 430 seconds, including 312 seconds after final
recovery across both previous login expiries. Recovery takes
13.151/12.774/6.348 seconds for VPN-on, VPN-off and the twelve-second outage.
Both devices renew logins lasting at most 300 seconds. All 133 checked steady
samples per guest advance received video/audio and attached video-element
playback. This candidate result remains distinct from production qualification.

The [actual deployed production receipt](evidence/kithmoot-node-renewal-continuity-20261104.json)
passes 442 seconds of matched-pair audio/video, including 310 seconds
after final confirmed recovery. VPN-on, VPN-off and outage recovery take
18.006/16.736/2.100 seconds, all below twenty seconds. Both guests renew
credentials and continue beyond the prior expiry. Every one of the 132 checked
steady samples per guest advances received video/audio and presented frames.
There are no page errors, authentication refusals or subscription overflows,
and recovery creates no new admission. This replaces the earlier sampled
seven-second renewal pause with no zero-progress samples at roughly two-second
polls; it does not establish gap-free playback below that interval.

The legacy fix passes 230 related tests (five existing skips). After the redial
correction, 228 pool/auth/node/mesh/peer tests pass (three skips), and hosted
Node24 runs pass 8,861 tests (eight skips). The earlier idle-socket CI failure
and its red/green deadline regression remain in the private evidence archive.

The harness observes credential expiry and lifetime inside the browser without
recording credential secrets. A previous inspector-only receipt missed one
browser's renewal response and is retained as inconclusive. Another production
attempt stopped when a different room participant's peer-reflexive address was
redacted in a statistics snapshot. Endpoint qualification now follows the same
controlled guest pair as media qualification: recovery counts only when fresh
media comes from matched native connections with verified node endpoints.
Missing endpoint evidence does not count as recovery; the twenty-second
deadline remains unchanged. Exposed non-node addresses and non-node signalled
candidates still fail the test. Other room participants' redacted statistics
are outside the controlled-pair endpoint proof and are recorded as such.

A playback counter snapshot during an earlier production attempt reset across
connection replacement and could not distinguish a freeze from a new stream.
The final harness counts presented frames with requestVideoFrameCallback and
receiver object identity, retaining counters across closed generations. Recovery
uses the first of two consecutive verified media samples: the first must arrive
within twenty seconds and the next must confirm it within four seconds. The
post-recovery soak starts at confirmation. These measurement corrections do not
remove the route deadline or the requirement for audio and displayed video.

These checks qualify the controlled Chromium browser case. Roughly two-second
sampling cannot establish gap-free playback below that interval. Physical
Wi-Fi/cellular handoff, commercial VPNs, GrapheneOS and capacity remain separate.
No new APK, public signed node/Shelter release or official Archy approval is
implied. Official Archy maintainer acceptance remains pending.

## Longer soak and abandoned allocations, 5 November

Extending qualification to ten minutes after final confirmed recovery exposed
another bounded resource problem. Two production-browser attempts reached the
node's 32-allocation limit after route changes. One froze at routine login
renewal; a repeat with a single slower private metrics observer failed before
its first scheduled renewal. These failed results are retained with the private
reproduction material. Staggering client renewals was considered locally and
reverted because it did not address the earlier outage failure.

[Spry PR37](https://github.com/forgesworn/spry-turn/pull/37) adds a validated
allocation lifetime cap and sets the private node profile to renewable
30-second leases. A vanished route can release its relay port without waiting
for the five-minute login to expire. Healthy Chromium WebRTC refreshes a short
allocation lease at half its lifetime. Admission, revocation, login expiry,
relay ports, total allocations and connection limits are unchanged. The
standalone default remains 3,600 seconds. Socket regressions cover Allocate,
Refresh, passive stream expiry, port reuse and explicit deallocation; a private
profile regression proves that allocation and login lifetimes are separate.

The private demo received only the Spry binary and its updated bundle inventory.
The controller, Shelter, supervisor, room data, access grants, settings, host
and other five apps were preserved. The update waited for zero relay sockets
and retained the prior image and a cold data backup. The public web renderer
remained at `a49a2ac5`, release `20261104T112032Z`.

The [sustained-media record](evidence/kithmoot-node-sustained-media-20261105.json)
records a 736-second run, including 611 seconds after final confirmed recovery.
VPN-on, VPN-off and outage recovery took 13.859/11.687/2.340 seconds. Each
guest advanced audio, received video and displayed frames at all 264 checked
steady samples. Both renewed their 300-second logins and continued beyond
their predecessors' expiry. The record also preserves the earlier failed
attempts, RTP loss/jitter/freeze counters and missing endpoint observations.
One-second socket counts still reached the 32-port ceiling and the passing run
observed five transient TURN486 refusals. Short leases bound abandoned
occupancy; this is not a claim that capacity pressure or all recovery failures
have been eliminated.
The native desktop Chromium guests use their existing admitted identities and
synthetic audio/video. Non-proxied WebRTC UDP is disabled, and an opaque CONNECT
proxy accepts port 443 only. The proxy container's node route changes through an
isolated WireGuard/NAT fixture; the Mac's VPN and firewall remain unchanged.
Normal certificate verification stays enabled, and no renderer or TURN URL is
intercepted. Mutual DTLS fingerprints identify the test pair. Reception and
visible presentation are counted across replacement generations.

This is controlled browser evidence. Earlier post-update attempts also missed
the twenty-second recovery gate, including an attempt with TURN quota
refusals. The record retains them rather than treating one passing run as
proof of universal recovery or capacity. Missing selected-candidate telemetry
is reported separately from media progress; only verified endpoints count for
recovery. The browser is sampled about every two seconds and private aggregate
relay statistics every ten seconds. Node totals include other room devices and
both forwarding legs. No physical phone, independent NATs, commercial VPN,
hardware capture, perceptual audio quality or subsecond gap-free playback is
qualified. Official Archy maintainer acceptance remains pending.


## One owner for native ICE recovery, 5 November

A node route failure could start two recovery paths. The node factory fetched
fresh credentials while Peer or SlotPeer immediately restarted native ICE with
the old login; SlotPeer could also send that stale restart offer. The optional
factory recovery hook now defers the whole restart. After credentials arrive,
the owner either rebuilds that connection or continues native negotiation.
Closed, replaced and retiring connections cannot resume deferred work. Other
factories retain their previous behaviour. Relay-only routing, scoped peer
repair, original credential deadlines and resource limits remain in force.

The integration regression fails before the correction in both protocols, then
passes for both rebuild and native fallback. The full SDK suite passes 8,863
tests with eight intentional skips; the focused suites pass 289 with three
skips. Library/app type checks, production build and hosted checks pass.
[Client PR709](https://github.com/forgesworn/kithmoot/pull/709) is merged.

[Spry PR38](https://github.com/forgesworn/spry-turn/pull/38) also reclaims
already-expired allocation capacity before refusing a new Allocate, rather
than waiting for the periodic sweep. Separate private aggregate counters now
distinguish server allocation limits, username limits and relay bind failures.
They contain no participant addresses, usernames or room identifiers.

The [measured comparison](evidence/kithmoot-node-allocation-recovery-20261105.json)
retains a backend-only production-renderer run, the client candidate and the
final public run. The candidate passes 733 seconds, including 611 seconds after
final recovery. Public release `20261105T143709Z` deploys its exact 598 files;
index, entry, main and service worker match on both domains with normal TLS.
The website and native update feeds are unchanged; no native package release
is claimed by this app-only delivery.

The final production run passes 749 seconds with 610 seconds after final
recovery. VPN on/off recover in 16.556/16.894 seconds and the twelve-second
outage in 2.088 seconds. Both guests renew credentials beyond old expiry,
advance received audio/video and displayed frames at all 269 checked steady
samples, and expose no TURN486/508 errors. No new whole-server allocation
refusals occur in its observation window. Per-login request refusals remain
in node-wide counters; they cannot identify a client or establish failed calls.
The original 32 total allocations, eight per username and 64 streams remain.

These are controlled Chromium tests using synthetic capture and a shared
WireGuard/NAT carrier over TURN TLS443. They do not qualify independent NATs,
physical Wi-Fi/mobile hand-offs, commercial VPNs, larger-room capacity or
perceptual video smoothness. Earlier failures and counter-scope limitations
remain explicit. Archy maintainer UI acceptance is still pending.

## Sequential TURN routes, 5 November

The [route-gathering regression](evidence/kithmoot-node-turn-route-gathering-20261105.json)
reproduces a concrete per-login refusal without filling the node. BUNDLE shares
media sections, but each advertised TURN URL can still allocate on several
interfaces. In the native SDK baseline, two connected pairs use 22 allocations
and already expose six per-login refusals. A third pair cannot connect within
twenty seconds. The final fixture counters report 13 per-login refusals and
zero whole-server or bind refusals. The first two pairs remain connected.

Node connections now gather one pinned TURN URL at a time: UDP first, then
TLS on port 443, then the remaining advertised TLS and TCP routes. An empty
gathering round gets four seconds before switching. That window lets a valid
IPv4 candidate follow an address-family lookup error and lets negotiation
rollback finish without abandoning a working route. A successful route is
reused for subsequent peers. Explicit network recovery starts with UDP again;
healthy existing peers keep their current transport.

Fallback obtains fresh credentials through the existing recovery owner. Both
call protocols register their restart continuation, so a factory-initiated
restart also sends the fixed-slot protocol's explicit restart offer. Closed,
replaced and retiring connections cannot resume recovery. Authentication and
capacity errors do not trigger transport fallback. The relay-only policy and
the signed node endpoint restrictions remain in force.

Chromium 151 passes all four native cases:

| Protocol | Client route | Connected pairs | Allocations | Per-login refusals |
| --- | --- | ---: | ---: | ---: |
| Legacy | UDP | 4 | 8 | 0 |
| Fixed slots | UDP | 4 | 8 | 0 |
| Legacy | UDP disabled, TLS 443 | 4 | 16 | 0 |
| Fixed slots | UDP disabled, TLS 443 | 4 | 16 | 0 |

Each case checks eight current native connections at seven two-second samples.
Every checked interval advances decoded video and received audio, with positive
synthetic audio energy. Closing the factories releases every allocation. The
full SDK suite passes 8,884 tests with eight skipped; typecheck and the web
build pass. The original route-selection and fixed-slot offer regressions were
observed failing before their corrections.

These fixtures use one browser, synthetic capture, fixture authority responses
and a real loopback Spry packet relay. TLS 443 uses a task-owned TCP forwarder
and an explicitly trusted ephemeral certificate. They are four pairs sharing a
central factory, not a complete five-person mesh or a room-capacity claim.
They do not qualify public certificates, physical hand-offs, perceived video
smoothness or a new credential-expiry soak. The earlier 28 node-wide per-login
requests remain unattributed; reproducing this failure class does not identify
their senders. Server limits, admission, logging and deployed server code are
unchanged by this client correction.

### Legacy connection continuity during node renewal, 5 November

The actual Mesh owner exposed a gap which direct Peer/SlotPeer fixtures did not
cover: profile-1 renewal closed the working transport before its replacement
could carry media. Node-owned legacy replacement now keeps one connected old
transport, stops its signalling and buffers new receivers until the replacement
has connected and had one second to settle. The overlap ends after at most
twenty seconds or the old login's original monotonic deadline. Repeated repairs
keep that original deadline and cannot accumulate retiring transports.

Publication and audience changes silence retiring senders. Removal, standing
down and call teardown close them immediately. Factories which have not opted
into retirement keep their existing close behaviour. The regression failed on
the previous implementation, then passed alongside deadline, receiver buffering,
repeated repair, audience, removal and teardown cases.

A controlled native Chromium run using the actual Mesh rebuild owner sustained
673 seconds, including UDP loss to TLS443, return to UDP, a twelve-second outage
and two credential renewals. Six incoming audio/video streams continued to
advance at the sampled intervals, with displayed video and non-silent synthetic
audio checked separately. The healthy pair was unchanged during the handoffs;
relay quota refusals and final allocations were zero. Credential HTTP, roster,
signalling delivery and capture were fixtures; the Spry packet relay and WebRTC
were real. This is not physical-phone, public TLS, full-PWA-UI or perceived
quality acceptance. The earlier bare native ICE-restart expiry failure, legacy
renewal failure and renderer-fixture corrections remain in private evidence.
SDK embedders must supply the owned connection-rebuild callback for fresh TURN
allocations; changing credentials with a native ICE restart alone did not
replace the old allocation in the baseline experiment.

## Admission at a timed room's end

A device grant cannot outlast its room. Once a grant reaches the signed room
end, the managing app reuses its signed event instead of trying to renew it to
the same expiry. This applies to scheduled renewal and returning devices after
an app restart. Android already follows this rule.

Earlier web and desktop versions could save a newer signed confirmation before
the node rejected its unchanged expiry with `renewal-must-extend`. The node now
accepts that confirmation only when it has the same grant ID, room, device and
scopes, a strictly newer timestamp, and the same expiry exactly at the signed
room end. It persists that accepted event so client and server agree after a
restart. This does not extend access. Shorter expiries, changed scopes, stale
confirmations, revoked grants, reset grants and closing or expired rooms retain
their existing refusals. Untimed rooms still require a renewal to extend expiry.

Regression checks cover lost acknowledgements, returning devices, a maximum
30-day room, durable node recovery and the authenticated HTTP access response.
These checks establish admission behaviour; they do not establish physical
network roaming or sustained audio/video quality on released clients.
