# Desktop default-route prototype for Proton

The aim is direct audio/video over the person's existing VPN when their network
allows it, without starting Spry, requesting port mappings or sending media over
Nostr. This prototype is separate from optional Spry hosting. ForgeSworn adds no
call service, credential broker or relay directory.

## Run the prototype

After the normal desktop setup and build, run from the repository root:

```sh
KITHMOOT_DESKTOP_PROTON_ROUTING=1 npm start --prefix desktop
```

Only the exact value `1` in an unpackaged run enables it. Stop and restart
without the variable to return to ordinary development behaviour. Packaged apps
ignore the variable. It creates no stored setting, renderer IPC, public
announcement or new network listener and does not change Proton's configuration.

The main process sets Electron's `default_public_interface_only` policy on each
main window immediately after construction, before navigation or any peer
connection. It reads the policy back and refuses that window if it cannot confirm
the requested value. Reloads and invitation navigation retain it; a recreated
window applies it again. Auxiliary capture windows retain their existing rules.

Electron documents that this policy uses the default HTTP route and suppresses
local addresses. **It does not identify or pin a VPN.** If Proton disconnects,
the default route may become the physical network. Use Proton's own protection
as appropriate; this prototype makes no VPN-loss privacy guarantee. A policy
readback alone does not prove the route used by a call. Reduced local candidates
may also prevent a direct LAN call.

Hide IP remains a separate, stricter room choice: usable TURN credentials and
`iceTransportPolicy: 'relay'` are required. Missing or failed TURN must not fall
back to direct media. This prototype does not change that choice or the SDK's
peer-connection configuration.

## Verification and acceptance

Dependency-free checks run with `npm test --prefix desktop`. To exercise the
actual native entry point with a disposable profile and an offline synthetic
page:

```sh
ELECTRON_EXECUTABLE=/absolute/path/to/electron node desktop/test/prototype-routing-electron.mjs
```

That check covers default versus explicit opt-in, policy before navigation and
page-created peer connections, reload, invitation navigation, macOS window
recreation and a refused policy before navigation. It does not prove a VPN route.

The 26 October development check also exercised the actual desktop entry point
and bundled frontend with an internet browser peer: room creation, invitation,
admission, joining the call and enabling synthetic camera/microphone input.
Both ends received moving video and decoded audio with the expected opposite
test tone. The selected pairs were direct, actual peer configurations contained
Cloudflare STUN and no TURN, and the peer's selected public address matched a
contemporaneous tunnel-bound STUN request. The selected local UDP port matched
an owned Electron socket; a passive socket-counter sample showed traffic in both
directions on the pinned Proton tunnel interface. The selected port stayed stable
across seven media samples. Raw route and identity evidence stays in the private
task artefacts. This establishes a bounded development call;
the release acceptance matrix below remains necessary.

Network qualification must use fresh synthetic identities and calibrated
synthetic audio/video. Record selected pairs per peer, increasing decoded video
and audio energy, and passive interface/socket evidence matched to the selected
local port. Retain raw candidates, endpoints and test identities privately;
publish only redacted results. Keep Nostr signalling on an owned test fixture.

Before changing the released default, qualify:

- A real desktop room with an internet peer through Proton, without TURN, with
  two-way media and passive selected-socket evidence on the tunnel.
- At least three participants, checking every connection, replacement peers,
  room switches and ICE restart rather than just aggregate traffic.
- LAN-only, LAN plus VPN, ordinary internet access, sleep/wake and interface
  changes. Unsupported combinations remain explicit acceptance gaps.
- Hide IP with working TURN, missing/expired credentials, renewal failure and
  relay loss, with no direct fallback and chat remaining available.
- Deliberate VPN loss, reconnect and exit changes in an isolated or separately
  authorised network environment. Define any promised failure behaviour before
  enabling it generally; following the default route is not a kill switch.
- Signed application identities on macOS, Windows and Linux, then physical
  camera, microphone and output-device acceptance. Electron supplies no mobile
  guarantee; GrapheneOS needs separate native qualification without Google Play.

Direct peers learn the selected public endpoint and receive the call's media.
A STUN server sees mapping requests but carries no media. A TURN media relay
forwards encrypted WebRTC packets and sees endpoints, timing and volume; merely
forwarding them does not decrypt them. A Nostr relay handles setup, admission and
messages, with visible connection/routing metadata; it never carries call media.
The VPN provider can observe tunnel destinations, timing and volume. This
prototype changes candidate routing, not these observers' entire knowledge.

Source: [Electron WebRTC IP handling policy](https://www.electronjs.org/docs/latest/api/web-contents/#contentssetwebrtciphandlingpolicypolicy).
