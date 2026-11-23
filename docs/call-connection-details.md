# Call connection details

Call bar → More → Connection details shows this device's room relay connections
separately from the selected media path to each caller's device. It reads local
WebRTC statistics while open; it makes no operator, IP-location or discovery
requests and does not save or export the results. Closing stops polling.

A room's KithMoot node is named independently of media selection. A configured
TURN server, a route-ladder rung or a nominated backup is not proof of the
selected media path. The selected transport pair decides whether media goes
directly to the endpoint or through TURN. The selected local relay's hostname
is shown only when the browser supplies its TURN URL. Remote relay addresses,
peer IPs, SDP, credentials, room URLs and URL query parameters are excluded.
The hostname is not proof of the operator's identity. When the selected local
relay hostname matches the room node's origin, it is labelled as the room node
TURN relay. A remote-only relay's server name remains unknown.

An assisting volunteer or forwarder is identified as the connection endpoint.
The UDP/TCP label on a direct path describes that transport. For a local TURN
path, the separately labelled UDP/TCP/TLS value describes this device's leg to
the relay; it does not claim that the whole route uses that transport.
Multiple independent selected transports, missing selections and failed stats
remain explicitly unavailable. A disconnected connection's previously selected
path is marked as historical. Direct connections may run over a VPN; this
panel cannot establish the route between two other people in the room.

Traffic, round-trip time, decoded inbound video frames and packet loss help
compare a visible interruption with transport or decoding progress. Counts are
cumulative, not a diagnosis or a guarantee of good picture quality. The view
updates every two seconds while open and preserves the call's media elements.

The accompanying playback repair uses presented-frame progress as independent
evidence when `currentTime` stalls. The previous clock-only watchdog could
reset an otherwise decoding sink after 15 seconds. Dropped frames alone do not
count as picture progress; genuinely stalled decoders still have their existing
recovery path. This is a reproducible software failure path, not a confirmed
explanation of every interruption in a physical Android-to-desktop call.

Review the standalone web and desktop call menu and Connection details panel:

1. Join two disposable profiles with cameras and microphones. Open the panel;
   each other caller should show a device, connection state and observed path.
2. Check a direct call and a TURN-only call. A selected TURN URL should show its
   server, without credentials or a query. A configured but unused relay must
   not make the direct call read as relayed. Missing stats must read unavailable.
3. Check a node-hosted room and a volunteer/forwarded call. Room routing and
   media endpoints must remain distinct. Another operator's identity is not
   inferred from the ForgeSworn software name.
4. Keep video playing with a fixed element playback clock for over 15 seconds.
   Decoded frames must continue without replacing its MediaStream. Actually
   frozen media must retain the existing bounded recovery.
5. Check 320/390/768/1440px widths, keyboard Escape and Close focus return.
   Closing must stop panel updates; reopening must read fresh observations.
6. Repeat with the actual updated Android and desktop devices. Automated
   browser checks do not establish physical-device or live-call acceptance.

These are standalone KithMoot screens; Archipelago launch/embedded screens and
node service configuration are unchanged. Publication and live mixed-client
acceptance are separate from local implementation and automated verification.
