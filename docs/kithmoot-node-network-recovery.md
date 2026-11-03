# Node calls and network changes

A person can use KithMoot in a web browser, the desktop app or the mobile app.
Managing rooms is a role belonging to their account, not a special physical
device. Each device still needs its own admission and room keys.

Turning a VPN on or off, changing Wi-Fi and moving to mobile data must retain
the room and recover its connection. Node rooms keep using their chosen node.
They do not fall back to public relays or another TURN service.

The browser now refreshes node credentials and restarts ICE on retained peers
when their connection disconnects or fails. Returning online or changing the
network type also reconnects the room relay and admission inbox. Concurrent
refreshes share one request; a retry can restart ICE even if the issuer returns
the same still-valid login. Only physical network type changes trigger that watcher. Estimated effective
connection type, latency and throughput do not restart a call. A peer that
never connected cannot restart healthy calls; an established peer requests
one refresh per failure episode.

An established connection losing its route also reopens the authenticated room
signalling socket before ICE restarts. A WebSocket can still report itself open
after a route change while its offers go nowhere. Refreshing TURN alone cannot
repair that socket. Concurrent recovery requests share the same reconnect.

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

- Focused SDK/access/admission/closure tests cover temporary failure, retry,
  concurrent reconnection, retained relay-only peers, withdrawal and expiry.
- The actual-process Chromium journey injects a temporary credential HTTP 503,
  triggers the online event, verifies retry and recovery, then admits guests,
  exchanges encrypted chat and verifies removal and room closure.
- The first production public call run used two admitted browser guests in an
  isolated container whose firewall allowed media only over TCP443. Both
  received audio and decoded video through `turns:turn.demo.forgesworn.dev:443`.
  A transient disconnect was followed by new media in both browsers. That run
  did not instrument the physical network route or qualify every VPN.

Longer public credential-renewal, controlled VPN switching, independent mobile
networks and physical GrapheneOS remain distinct evidence gates. Record actual
results and limits rather than treating the availability of four TURN URLs as
proof that each route worked.

The longer demo run has exposed intermittent TLS connection failures and a
failed VPN route recovery. Short raw-transport and application video successes
do not clear that qualification. The signalling regression passes a check that
reconnection precedes ICE restart and occurs once per established failure episode.
