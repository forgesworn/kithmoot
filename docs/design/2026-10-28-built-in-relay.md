# Built-in call relay for desktop and Android

Design, 28 October 2026. No implementation. Covers spry-turn
(`forgesworn/spry-turn`), KithMoot web and desktop (`forgesworn/kithmoot`) and
KithMoot Android (`forgesworn/kithmoot-android`).

Owner decisions, 28 October 2026: build a **desktop built-in relay** (released,
off by default, automatic router port opening, shared with the owner's rooms)
and an **Android built-in relay**. In-house code, no new third-party
software without saying so and why, nothing sent to Google. ForgeSworn writes
the software and runs no relay, credential broker, directory, DNS name or
reachability probe; each person who turns the relay on runs it.

Tags: **[unverified]** marks a claim not checked against source, documentation
or a device in this design. **[decision]** marks an owner decision listed at
the end.

## Summary

- The built-in relay is a supervised `spry-node` in a new **supervised standard
  mode**: the standard TURN profile, room grants only, sealed to admitted
  devices, no HTTP listener, no anonymous issuer, no advert.
- Guests reach it through the existing `spry:` encrypted Nostr control channel
  (kinds 24181/24182), extended from the private-node profile to the standard
  profile. That avoids the HTTPS-and-DNS requirement of `https:` offers and lets
  the node return TURN URLs with an IP literal and mapped ports.
- To KithMoot's room code the built-in relay is just another Spry pairing, so
  the share rule already on `feat/room-relay-sharing` applies unchanged: own
  grant always; publish the offer only in rooms this device created or after
  **Share my call relay here**.
- Port opening is in-house Rust in spry-turn (PCP, then NAT-PMP, then UPnP
  IGD), owned by the relay process so that leases die with it.
- Reachability is proved by another device on another network, a room member
  or the person's own phone on mobile data, with a new test mode. Running,
  reachable and used are shown as three separate facts.
- Android runs the same Rust code through JNI, in a `specialUse` foreground
  service in its own process, on unmetered Wi-Fi while charging, with a
  visible notification and Stop.

## Verified starting point

Read on 28 October 2026 from kithmoot `origin/main` (622e642b), kithmoot
`feat/room-relay-sharing` (4ee14e18), kithmoot-android `origin/main`, spry-turn
`origin/main` (9bc3feb), `feat/room-grant-seal` (fd214d7) and
`feat/room-relay-caps` (bb26cad).

| Fact | Where |
|---|---|
| `https:` offers need a dotted DNS name; IP literals, `.local`, `.internal` and similar are refused | kithmoot `src/spry.ts` `spryEndpoint` |
| For `https:` offers the TURN URLs must be exactly `turn:<host>:3478` (UDP, TCP) or `turns:<host>:5349`, same host as the endpoint | `src/spry.ts` `spryCredentials`, `allowed` set |
| `spry:` offers are redeemed only when the device holds that pairing; their URL rule already accepts `turn:<ip>:<port>` and requires a node card signed by the `spry:` key; the card parser accepts only profile `spry-peer-v1` with a ULA `[fc..]:3745` address | `src/spry.ts` `spryCredentials`, `src/spry-link.ts` `spryNodeCard`; Android `SpryRoomAccess.kt` |
| The `spry:` control path carries `/v1/credentials`, `/v1/grants`, `/v1/grants/devices` and `/v1/grants/vouch` | spry-turn `feat/room-grant-seal` `crates/spry-link/src/control.rs` `PATHS` |
| The signalling runtime (Nostr control) starts only inside the private-node bridge, which needs an IPv6 ULA mesh route | `crates/spry-service/src/node.rs` `PrivateSettings::start` |
| `spry-node` standard profile listens on loopback HTTP 3744 behind an operator's HTTPS proxy and needs `SPRY_PUBLIC_URL` | spry-turn `docs/standalone.md` |
| `spry-node` spawns `spry-turn` with `stdin(Stdio::null())`, so the `--exit-on-stdin-close` guard does not reach the relay through `spry-node` today | `crates/spry-service/src/lib.rs` `start_relay` |
| Without `SPRY_RELAY_IP`, `spry-node` finds its address by running `ip -j` (Linux only); a non-public bind starts only with a public `SPRY_PUBLIC_IP` | `lib.rs` `node_address`, `start_relay` |
| Node TURN URLs are built from one port for UDP and TCP | `node.rs` (private) and `standard.rs` `urls` |
| `spry-turn serve` has `--relay-port-map LOCAL:PUBLIC` (1 to 1024 pairs, no fallback, 508 on exhaustion) and `--exit-on-stdin-close`; it does not acquire mappings or advertise the listener's public endpoint | spry-turn `docs/mapped-ports.md`, v0.3.0 |
| `SPRY_MAX_ALLOCATIONS` (1 to 32), `SPRY_MAX_ALLOCATIONS_PER_USER` (1 to 8), `SPRY_MAX_TCP_CONNECTIONS` (1 to 32) exist only on the unmerged caps branch | `feat/room-relay-caps` `standard.rs`, CHANGELOG "Unreleased" |
| Room grant sealing (`spryKey` in the roster, `/v1/grants/devices`, `/v1/grants/vouch`, `SPRY_ROOM_SEAL`) is on unmerged branches in spry-turn and kithmoot | spry-turn design `docs/design/2026-10-28-room-grant-seal-and-advert-privacy.md` |
| No aggregate bandwidth cap or total data counter exists; the per-allocation cap is not a total | spry-turn GOALS, kithmoot `docs/2026-10-26-desktop-spry-hosting.md` |
| The desktop preview supervises bare `spry-turn` from an owner JSON file in unpackaged runs only; no binary is bundled | `desktop/spry-hosting.mjs`, `desktop/spry-hosting-controls.mjs` |
| `checkCallRelay` runs two relay-only peers on the same TURN server | `app/src/call-relay-check.ts` |
| macOS builds are Developer ID signed with hardened runtime and notarised; Windows builds are unsigned portable zips; Linux ships tarballs and a deb with an apt route | `desktop/scripts/package*.mjs`, `desktop/README.md` |
| Android already ships Rust libraries through prepared, manifest-verified bundles (`liblink_ffi.so`, `libvmls_ffi.so`) for arm64-v8a and x86_64, `useLegacyPackaging = true`, minSdk 33, targetSdk 35 | kithmoot-android `app/build.gradle.kts` |
| Android already runs a `specialUse` foreground service with a subtype property and declares `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | `AndroidManifest.xml`, `BackgroundCallListenerService.kt` |

## 1. Desktop

### 1.1 Which process

The preview's bare `spry-turn` has no authority, so it cannot hold room grants,
seal them or answer over Nostr. The built-in relay supervises **`spry-node` in a
supervised standard mode** (spry-turn PR S2):

- standard TURN profile only; the private mesh and public mode are refused in
  this mode;
- no HTTP listener at all (no port 3744), so nothing on the machine or LAN can
  call the authority except through the encrypted control channel;
- Nostr control (the existing signalling runtime) started without the mesh;
- the host app's pairing key is trusted at start-up from the supervisor, in
  place of the owner UI and claim code, so no NIP-07 pairing screen exists;
- the relay embedded in-process, as the private profile already embeds it, so
  there is one process, one binary to sign and one stdin guard;
- `--exit-on-stdin-close` on `spry-node` itself;
- every network value passed explicitly: local bind IPv4, advertised public
  IPv4, listener external port per transport, `--relay-port-map` pairs, caps,
  control relays. No `ip -j`, no address guessing.

If embedding the relay in `spry-node` proves larger than expected, a fallback is
two binaries with `spry-node` giving its `spry-turn` child its own stdin pipe
and `--exit-on-stdin-close`. That doubles the signing and hashing surface.

### 1.2 Bundling and signing

No runtime download. The binary is built from a reviewed spry-turn tag in CI,
its SHA-256 recorded in the desktop release evidence, and copied in by the
packaging scripts.

| Platform | Placement and signing |
|---|---|
| macOS (Apple Silicon; Intel only if desktop adds it [decision]) | `Contents/Resources/spry/spry-node`, outside the asar, mode 0755. Signed by `@electron/osx-sign` with hardened runtime and the same Developer ID as the app; no extra entitlements expected [unverified until a notarised build]. Notarisation rejects unsigned Mach-O inside the bundle, so a missing signature fails the release. `codesign --verify --deep --strict` and `spctl` checks in `package.mjs`. |
| Windows x64 | `resources\spry\spry-node.exe`. The app is currently unsigned; Authenticode signing is a purchase and is listed as a decision, not planned. Unsigned, SmartScreen and Defender may warn or block the helper as they do the app. |
| Linux x64 and ARM64 | Tarball: `resources/spry/spry-node`. Deb: under the package's own lib directory (for example `/usr/lib/kithmoot-desktop/spry/`), 0755, owned by root, no setuid, no capabilities (ports are above 1024). The apt route publishes it with the app. |

The supervisor refuses to start a helper whose hash differs from the value
built into the app (the manifest the packager writes), so a replaced binary in
a user-writable install is refused rather than run.

First listen triggers the macOS application firewall prompt (if enabled) and
the Windows Defender Firewall prompt [unverified for a helper binary]. The UI
says to allow it, and treats refusal as "Not reachable" rather than an error.
No firewall rule is added automatically: adding one on Windows needs
administrator rights, which the app does not ask for.

### 1.3 Supervision, start and stop

Reuse the preview's supervisor rules (`desktop/spry-hosting.mjs`): explicit
start, private stdin pipe, readiness line, bounded stop with escalation,
observed exit before Off, stale-generation guard, no raw child logs, secrets
never returned to the renderer. Changes:

- The node keeps a state file (grants, sealed member lists, pairing) in the
  app's user data directory, mode 0600. The TURN secret and node identity
  secret are stored with Electron `safeStorage` (OS keychain) and passed by
  environment or stdin, never written in clear. New storage keys go through
  the existing storage classifier, as the sharing branch did for pairings and
  grants.
- The host app holds the pairing secret for its own node exactly as it holds a
  claimed pairing today, so `SpryRoom` treats it as an ordinary pairing.
- Status is read from a bounded counts-only status line (spry-turn PR S3):
  allocations now, bytes relayed since start, last allocation time from a
  non-local address. No addresses, no logins, no room data.

### 1.4 Autostart

Off on first install and after every upgrade that adds the feature. Two
separate explicit choices:

1. **Turn on** for this session.
2. **Start it when KithMoot opens**, persisted, off by default.

V1 runs only while the KithMoot app is running. Closing the last window on
macOS keeps the app (and so the relay) running only if the app already stays
resident; launch at login and a tray-only resident mode are out of scope
[decision].

### 1.5 Crash, sleep and wake

- **Helper crash.** Supervisor reports Failed, keeps Off, offers Turn on again.
  At most one automatic restart after 10 seconds when the person chose "Start
  it when KithMoot opens", then stay Failed [decision on the restart count].
- **App crash.** The stdin pipe closes, the helper exits, the OS closes its
  sockets. Port mappings lapse at their lease (PCP, NAT-PMP, finite UPnP) or
  are cleaned on next launch (permanent UPnP; see 2.2).
- **Suspend.** Stop the relay and release mappings before sleep, as the
  preview already does on `suspend`. The OS may freeze the process before stop
  finishes; leases then lapse on their own.
- **Resume.** If the person chose "Start it when KithMoot opens" or the relay
  was on before sleep, wait for a network, re-run route detection (the
  gateway may differ), re-acquire mappings and start. Otherwise stay Off.
- **Network change** (new default route, gateway or local address while
  running). Stop forwarding, release mappings on the old gateway if still
  reachable, re-run detection, restart only if the new network can host. A
  café or hotel network shows "Not reachable on this network" and the relay
  stays stopped rather than binding there.
- Offers carry the `spry:` node key, not the IP, so a new public address needs
  no new offer; credentials returned afterwards carry the new address.

### 1.6 Resource caps

Built-in defaults, lower than the server defaults because a home upload is
small and every allocation port is a router entry [decision on values]:

| Setting | Built-in default | Server default |
|---|---|---|
| `SPRY_MAX_ALLOCATIONS` | 16 | 32 |
| `SPRY_MAX_ALLOCATIONS_PER_USER` | 4 | 8 |
| `SPRY_MAX_TCP_CONNECTIONS` | 16 | 32 |
| `SPRY_BYTES_PER_SECOND` (per allocation) | 250000 | 1000000 |
| Aggregate bytes per second (new, PR S3) | 1500000 | none |
| Daily relayed data, enforced by the host stopping the relay | 5 GB, adjustable down | none |

Before fixing the per-user cap, measure how many allocations one browser peer
connection makes when the credential carries both a UDP and a TCP URL
[unverified: libwebrtc may allocate once per TURN URL]. KithMoot calls are a
mesh, so a guest who needs the relay in a five-person call holds four peer
connections; the cap has to cover that or the call partly fails.

## 2. Reachability without ports

### 2.1 What has to be reachable

Standard TURN needs, from the internet:

- the listener, UDP and TCP (one port each; they may differ externally);
- one UDP port per live allocation.

With the defaults above that is up to 18 inbound mappings. The node advertises
the external IP and ports; the local bind is the LAN address of the default
route's interface.

### 2.2 Mapping protocols

A new crate `spry-portmap` in spry-turn (PR S4), used by `spry-node` and so by
desktop and Android alike. The mapping lives and renews inside the relay
process, so a dead relay stops renewing and its leases lapse. No new
dependencies: UDP and TCP from the existing tokio, a small bounded HTTP/1.1
request for UPnP on the LAN only (or the existing hyper client), and a bounded
hand-written XML reader that accepts only the few elements needed, with no
DTD or entity handling.

Try in order, stop at the first that grants the listener:

| Protocol | Use | Ownership and cleanup |
|---|---|---|
| PCP, RFC 6887 (MAP opcode, UDP 5351 to the gateway) | One MAP per port and protocol, requested lifetime 7200 s, renew at half the granted lifetime | Each mapping has a 96-bit nonce; only that nonce can renew or delete it. Persist nonces in the state file so a later start can delete a crashed run's mappings exactly. |
| NAT-PMP, RFC 6886 (UDP 5351) | Same layout, external port suggested equal to internal, accept a translated port | Delete (lifetime 0) on stop only mappings this run created and recorded. After a crash rely on the granted expiry. |
| UPnP IGD (SSDP M-SEARCH to 239.255.255.250:1900 on the LAN interface only, then SOAP `AddPortMapping`, `AddAnyPortMapping` on IGDv2, `GetExternalIPAddress`) | Finite lease (3600 s) where accepted, renew at half | Before deleting, `GetSpecificPortMappingEntry` must show our internal client, port and description tag. IGDv1 routers that accept only permanent leases [decision]: either accept them with deletion on stop and cleanup of recorded entries on next launch, or treat such routers as unable to host. |

Rules shared by all three:

- Talk only to the default gateway (PCP, NAT-PMP) or to SSDP responders whose
  description URL is on the LAN interface's subnet (UPnP). Never follow a
  description URL off the LAN.
- The gateway address comes from the host: on desktop from the OS route table
  (Linux `/proc/net/route`; macOS and Windows by a fixed system route query,
  parsed with bounded input [unverified: exact command and parse per OS]); on
  Android from `LinkProperties`. No guessing `.1`.
- Ask for the listener first. If the listener fails, stop: nothing else is
  useful.
- Then ask for allocation ports from a random block of high ports. Use every
  granted pair, translated or not, as `--relay-port-map`. Start the relay when
  the listener and at least 4 allocation ports are granted; show reduced
  capacity when fewer than asked.
- Renew each mapping independently. If any listener mapping is lost or its
  external port or address changes, restart the relay with the new values. If
  an allocation mapping is lost, restart with the smaller map (allocations
  using it drop; clients renew through ICE).
- Bound everything: at most 40 mapping requests per attempt, 2-second
  timeouts with the RFC 6886 retry schedule capped, no background retry loop
  when the network cannot host. Retry detection only on network change, wake
  or Turn on.

### 2.3 Router families

General knowledge, each [unverified] per model and firmware until tested:

| Family | Expected support |
|---|---|
| miniupnpd-based firmware (OpenWrt package, pfSense, OPNsense, many ASUS, Netgear, TP-Link) | UPnP IGD and NAT-PMP, PCP when built in. Usually on by default in consumer firmware, off by default in OpenWrt, pfSense and OPNsense. |
| AVM FRITZ!Box | UPnP IGD with a per-device permission that recent firmware leaves off; PCP support |
| UK ISP hubs (BT, Virgin Media, Sky, TalkTalk) | UPnP IGD, commonly on by default |
| Mesh systems (eero, Deco and similar) | UPnP varies by vendor and setting |
| Apple AirPort | NAT-PMP (no longer made) |
| Proton VPN with port forwarding | NAT-PMP, one documented assigned port; multiple mappings unestablished (see `docs/2026-10-26-proton-mapping-diagnostic.md`) |
| Most other commercial VPNs | No inbound port forwarding |
| Mobile networks, hotspots | No usable mapping (carrier-grade NAT) |

### 2.4 Detecting networks that cannot host

| Observation | Meaning | Status shown |
|---|---|---|
| No PCP, NAT-PMP or UPnP answer | Mapping off, or no support | "Your router didn't allow automatic setup. Turn on UPnP in its settings, or ask whoever runs your network." |
| External address from the router in 100.64.0.0/10 | Carrier-grade NAT | "Your internet provider shares one address between many customers, so nothing outside can reach this computer." |
| External address private (RFC 1918) | Double NAT (second router) | "There's a second router between you and the internet. Automatic setup can't open it." |
| Default route on a tunnel interface (`utun`, `tun`, `wg`, WireGuard or OpenVPN adapter) | Commercial VPN | "A VPN is on. People can't reach a relay behind it." Hosting never falls back to the home route or splits the tunnel. A Proton route is attempted only after its multi-port contract is established. |
| Mobile data (Android) | Carrier-grade NAT | Relay stays off by policy (Wi-Fi only) |
| Mappings granted but the remote test fails | Upstream NAT, ISP filtering, firewall prompt refused, or IGD lying | "Opened on your router, but people still can't reach it." |
| IPv6 only, or DS-Lite (IPv4 through the carrier) | No IPv4 inbound | Cannot host; IPv6 relaying is separate future work in Spry |

No public address lookup is made to a ForgeSworn server or to any service
picked for this feature. Whether to compare the router's external address with
a STUN answer from the STUN server the person's calls already use is a
[decision]; the remote test in 2.5 decides reachability either way.

Situations that cannot host, stated plainly in the docs and the UI: mobile
data; any carrier-grade NAT without carrier PCP; double NAT without access to
the outer router; routers with UPnP, NAT-PMP and PCP all off when the person
cannot change them; commercial VPNs without multi-port forwarding; guest,
hotel, café, school and workplace networks; IPv6-only service.

### 2.5 Reachability check with no ForgeSworn server

`checkCallRelay` puts both peers on the host's relay, so test traffic passes
allocation to allocation inside the host. That proves the listener is
reachable from the tester's network and says nothing about inbound allocation
ports. A new **outside test mode** (kithmoot PR K2, Android A2):

- Peer A is relay-only on the host relay.
- Peer B uses no TURN, and uses the host relay's listener as its STUN server,
  so it learns its own public address and A can install a permission for it.
- B's checks reach A's relayed address from the tester's public address,
  through the host's allocation port mapping. A data-channel echo plus the
  existing stats check (A's local candidate `relay`, B's local candidate not
  `relay`, bytes received) proves listener and allocation inbound together.

Who runs it:

1. **The person's own other device**, for example their Android phone on
   mobile data, through account sync of the pairing. A "Test from my phone"
   action on desktop sends a request to the phone in the existing encrypted
   account channel [unverified: which account channel fits].
2. **A room member's app**, when it first redeems the host's offer and the
   room allows it [decision on automatic versus host-requested]. It costs the
   member a few kilobytes and, like any relay use, shows the member's IP to
   the host's relay.

The result (pass or fail, which part failed, time) goes back to the host only,
inside the room's or account's existing encrypted channel, signed by the
tester's device key. It names no addresses and goes nowhere else. ForgeSworn
receives nothing. A test from the host's own LAN (hairpin) is shown only as a
hint, never as reachable.

## 3. How the relay becomes a room offer

### 3.1 The problem

KithMoot clients redeem another member's offer only when it is `https:` on a
DNS name with TURN on ports 3478 and 5349 of the same host. A home machine has
neither a DNS name nor, usually, external ports 3478 and 5349 free. `spry:`
offers carry any `turn:<ip>:<port>` URL but are redeemed only by the device's
own pairing.

### 3.2 Options

| Option | Needs | Verdict |
|---|---|---|
| A. Extend `spry:` control to admitted room guests in the standard profile | Signalling runtime without the mesh (S2); client accepts a foreign standard `spry:` offer (K1, A1); sealing so only admitted devices redeem | **Chosen for v1.** Reuses grants, sealing, vouching and the existing 24181/24182 client code on web and Android. No DNS, no certificate, no extra port. Also gives any standard Spry node (VPS, Archipelago) a no-HTTPS route. |
| B. DNS name for a home IP | A dynamic DNS provider (the person's own domain with a provider API, or a third-party dynamic DNS service), an in-house ACME client and either inbound port 80 (HTTP-01) or provider API access (DNS-01), an HTTPS listener on the home machine, and external ports 3478 and 5349 | **Rejected for v1.** Third-party services or a ForgeSworn service; certificate transparency logs publish the hostname permanently, which for IP-in-name services publishes the home IP; more open ports; ports 3478 and 5349 are often taken on a shared router. Possible later as an advanced "use my own domain" option. |
| C. The host app mints TURN credentials and sends them to admitted devices inside room signalling | A new descriptor offer type and a request and reply in the room channel | Not chosen. Works only for rooms whose sessions the host app has open, bypasses the sealing just built, and needs a third protocol. Kept as a fallback if A stalls. |

### 3.3 Option A in detail

**Node (S2).** In supervised standard mode the node runs the signalling
runtime on a bounded set of control relays supplied by the host (at most 8).
All authority paths already listed in `control.rs` work over it. The node
returns TURN URLs `turn:<public IPv4>:<external UDP port>?transport=udp` and
`turn:<public IPv4>:<external TCP port>?transport=tcp` and a node card signed
by its key. No `turns:` in v1 (no certificate).

**Offer.** The descriptor's `spry` offer is the existing shape with endpoint
`spry://<node key>?relay=wss://...`. V1 gives the node **one fixed control
relay list** (1 to 4, from the host's own configured relays), carried by every
offer and by the host's pairing. Clients compare `spry:` endpoints as whole
strings, relays included (`spryCredentials` checks
`own?.endpoint !== offer.endpoint`; `SpryRoom` returns early when
`next.endpoint !== this.pairing?.endpoint`), so per-room relay subsets would
make the host's own offer fail on its own device. The cost: a guest sends
small control requests to the host's relays, which may not be relays that
guest otherwise uses for the room. A later change could compare the node
public key (`parseSpryControl(...).publicKey`) and treat the relay list as a
routing hint, allowing per-room subsets drawn from each room's relays.

**Client rule (K1 web and desktop renderer, A1 Android).** Accept a foreign
`spry:` offer when all hold:

- the credential answer carries a node card (kind 24183) signed by the `spry:`
  key, as private offers already require, with a new content profile
  `spry-standard-v1` and no mesh address. Today's `spryNodeCard` accepts only
  `spry-peer-v1` with a ULA `[fc..]:3745` address, so old clients drop the new
  card and with it the offer's `node`; they already refuse foreign `spry:`
  offers, so nothing changes for them. The private mesh must never treat a
  standard card as a peer route;
- every returned URL is `turn:` with a public unicast IPv4 literal (same
  `public_v4` rule as Spry: not private, loopback, link-local, CGNAT,
  documentation, benchmarking, multicast or reserved), a port from 1024 to
  65535, at most two URLs, and the same IP in each;
- the existing timing, login and expiry checks pass.

A foreign `spry:` offer can make a guest's TURN client send packets to an
address a member chose. Any member can already do that with ICE candidates in
SDP, and TURN packets are small, so the added exposure is similar; the public
address rule keeps it off the guest's LAN.

**Sealing.** With the seal, a copied grant token without an admitted device's
registered `spryKey` gets "Call access has expired." The built-in relay runs
`SPRY_ROOM_SEAL=required`: there is no installed base of old guests to protect
on a brand-new relay, and old clients cannot redeem a foreign `spry:` offer
anyway [decision: `required` versus `auto`].

**Share rule, unchanged from `feat/room-relay-sharing`.** The host device
always holds its own grant per room and uses its own relay for its own calls.
It publishes the offer automatically only in rooms it created; elsewhere it
waits for **Share my call relay here**. Turning sharing off removes the
grant. Registration, sealing and vouching are the same code.

Old clients see a `spry:` offer that is not their pairing and skip it; their
calls use the room's other paths, as today.

### 3.4 Privacy

| Who | Learns |
|---|---|
| Guests who redeem | The host's current public IP and the fact that it relays for this room. Not shown to room members who never redeem. Not in the descriptor. |
| Host's relay | Each redeeming guest's IP, ports, timing and volume, a per-room per-device Spry key; no room id, names or media keys |
| Control Nostr relays | That a key sent small encrypted requests to the node key, with timing and IP; the same class of metadata as room signalling |
| ForgeSworn | Nothing |

Hide my IP cuts both ways. A guest with Hide my IP on who uses a member's
relay reveals their IP to that member; a host with Hide my IP on who turns the
relay on reveals theirs to every guest who uses it. Proposed behaviour
[decision]: with Hide my IP on, a guest uses a member-hosted relay only after
a one-time choice naming the host; the host's Turn on dialog says plainly that
hosting shows their internet address to people who use it, and is not offered
while Hide my IP is on unless they confirm.

Media stays DTLS-SRTP end to end; the relay forwards ciphertext. No audio or
video ever travels as Nostr events.

### 3.5 Legal position

Share with my rooms only. No "Open to anyone", no advert and no anonymous
issuer in the built-in relay [decision to confirm]. Each person who turns it
on is the operator of their relay; ForgeSworn publishes software, runs no part
of the data or control path and receives no reports, including reachability
results. Before release, refresh spry-turn `docs/legal/transport-position.md`
and kithmoot `docs/legal/call-transport-position.md` from the shipped
behaviour, as spry-turn GOALS G8 requires, using jurisdiction-kit's GB
online-services note. Its application to a home TURN relay serving private
room members remains unresolved there and is not settled here. The Turn on
dialog carries the proportionate notice from G7 (bandwidth, address exposure,
the person's own legal and ISP terms), adapted to share-with-rooms.

## 4. Android

### 4.1 Native route

Same Rust as desktop: `spry-node` supervised mode plus `spry-portmap`, built
as a shared library for arm64-v8a and x86_64 and delivered as a prepared,
manifest-verified bundle exactly like the Link and VMLS bridges (never
committed, verified at build time).

| Route | Verdict |
|---|---|
| JNI library with a small C ABI: `start(config) -> handle`, `stop(handle)`, `status(handle) -> counts`, `credentials` not exposed (the node answers guests itself) | **Chosen.** Supported route; the app already loads two such libraries. Binding generator [decision]: UniFFI (a new dependency in spry-turn, consistent with the existing bridges [unverified that they use UniFFI]) or a hand-written JNI shim with no crate. |
| Bundled executable started from `nativeLibraryDir` | Not chosen. Android 10 and later forbid executing files from writable app storage; running a `lib*.so`-named executable from `nativeLibraryDir` works on many builds but is not a documented app pattern [unverified on GrapheneOS]. |

The relay runs in its own process (`android:process=":relay"`) so a native
fault ends the relay, not the app. The main process talks to it through a bound
service. Pairing secret and TURN secret come from the existing account vault
pattern (`SpryAccountVault`) and pass to the relay process over the binder,
not on disk in clear.

### 4.2 Foreground service

- Type `specialUse`, with a `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` such as "Relay
  encrypted call traffic for the person's own KithMoot rooms while they choose
  to run it". `dataSync` is ruled out because Android 15 limits it to six hours
  a day for apps targeting API 35 [unverified against current docs]. KithMoot
  ships outside Google Play, so no Play declaration is involved.
- Ongoing notification on a dedicated low-importance channel: "Call relay on.
  2 people using it." with a **Stop** action that stops the service directly.
- Partial wake lock and a Wi-Fi low-latency lock held only while at least one
  allocation is live; released when idle [unverified: forwarding latency with
  locks released while idle].
- No Google Play services, Firebase or Google endpoint. Everything is
  platform API (`ConnectivityManager`, `BatteryManager`, `PowerManager`).

### 4.3 Gates

Policy objects in plain Kotlin with JVM tests, checked before start and on
every change:

| Gate | Default | On violation |
|---|---|---|
| Network is Wi-Fi and not metered (`NET_CAPABILITY_NOT_METERED`) | Required | Stop, notification says why, resumes when back on unmetered Wi-Fi if the person left it on |
| Charging | Required [decision: required or default-on but changeable] | Same |
| Battery temperature below 40 °C and thermal status below `THERMAL_STATUS_MODERATE` | Required | Stop; resume after 10 minutes cool |
| Battery level at least 50% | Required | Stop |
| Daily relayed data | 2 GB | Stop until midnight |
| Built-in caps | 8 allocations, 2 per user, 150000 bytes per second each, 800000 aggregate | Enforced by the node |

Battery optimisation exemption is asked for only when the person turns the
relay on, with a plain reason [unverified: whether a `specialUse` foreground
service needs it for network access in Doze].

### 4.4 Phone reachability

Mobile data is almost always carrier-grade NAT, so phones host only on Wi-Fi
behind a router that grants mappings, with the same tests and messages as
desktop. Hotspot tethering cannot host. The phone is more useful as the
**tester** of a desktop relay (2.5) than as a relay; say so in the Android
screen.

## 5. UI

Plain-language principle: the person never sees ports, NAT, UPnP or IP
addresses unless they open details.

**Where.** Desktop: Settings, **Privacy and connection**, a section **Call
relay on this computer**. Android: the same section in Settings, titled **Call
relay on this phone**. The per-room **Share my call relay here** row from the
sharing branch stays where it is and appears once the relay is on or a pairing
exists.

**Wording (draft for owner review).**

> **Call relay on this computer** (switch, off)
>
> When two people can't connect directly, a call relay passes their encrypted
> audio and video along. Turn this on to let people in rooms you made use this
> computer as their relay. It uses your upload bandwidth while they're on a
> call, and they'll see your internet address. You run it, and you can stop it
> at any time.

Turn on opens a short dialog with the notice from 3.5 and **Turn on** /
**Cancel** (Cancel default).

**Status: three separate facts, never merged.**

| Fact | Lines |
|---|---|
| Running | "Off" · "Starting..." · "Running on this computer" · "Stopped: <reason>" |
| Reachable | "Not checked from outside yet" · "Reachable, checked from <device or member name> at 14:02" · "Can't be reached: <plain reason from 2.4>" · "Opened on your router, but people still can't reach it" |
| Used | "Not used yet" · "In use: 2 people now" · "Relayed 1.2 GB today" |

A **Stop** button is visible whenever it runs. Desktop shows a small "Relay on"
indicator in the app's connection area while running, so hosting is never
hidden. Details (collapsed) show the router method, mapped port count and
external address for people who want them.

**Review gates.** KithMoot desktop and Android screens follow the owner's UI
review, with the Signal-like simplicity bar. The Archipelago maintainer ZAT
gate does not apply to KithMoot screens; it applies only if a spry-turn PR
changes the Spry Archipelago package's installation, pairing, hosting
settings, public-mode or status and Stop screens, in which case spry-turn
GOALS G8's review pack and maintainer approval are required before merge.

## 6. Tests and acceptance

### 6.1 Automatable

| Area | Test |
|---|---|
| `spry-portmap` codecs | Unit and property tests for PCP, NAT-PMP and IGD SOAP and XML: truncated, oversized, wrong-source, wrong-nonce, translated-port, epoch-reset and lease-shortened replies; fuzz targets beside the existing ones |
| Mapping lifecycle | In-house fake gateways on loopback (UDP 5351, SSDP and HTTP) with a fixture clock: renewal, loss, address change, partial grant, permanent-only IGDv1, cleanup by nonce and by description |
| Router software | Optional CI job with miniupnpd in a network namespace as a real gateway [decision: third-party software in test infrastructure only] |
| Supervised mode | Rust integration tests: no HTTP listener, stdin EOF ends the process and frees ports within 3 s, pre-trusted pairing, control-only credentials, URLs from explicit values, relay-port-map passthrough, caps, aggregate cap, counts-only status |
| Simulated networks | Linux namespaces with iptables NAT: home NAT plus mappings, CGNAT, double NAT, symmetric NAT guests, UDP blocked (TCP fallback). Local evidence only. |
| Clients | Vectors for the standard-profile offer marker and URL rule (web and Android, merged by hand into Android's vendored copy); `spry-room-relay.spec` extended with a guest redeeming a foreign standard `spry:` offer through the offline relay `test/ws-relay.mjs`; outside-test mode against a local node |
| Desktop | Extend `desktop/test/spry-hosting-electron.mjs` to the packaged helper path, hash refusal, suspend and resume, network change, Start-on-open |
| Android | JVM tests for gates and status wording; instrumented service lifecycle on the emulator (proves lifecycle only; the emulator cannot prove hosting); `compileDebugAndroidTestKotlin` in CI |

### 6.2 Needs real hardware and networks

- Router matrix: one each of a UK ISP hub, a FRITZ!Box, an OpenWrt or
  OPNsense router, a mesh system, Proton VPN, a CGNAT line, a double NAT.
  Record method, granted mappings, lease behaviour, external tests.
- Signed and notarised macOS install, firewall prompt, sleep and wake on a real
  lid close, Wi-Fi change; Debian deb install from apt; clean Windows machine
  with Defender.
- Real calls from mobile data and another home network through the relay,
  UDP and TCP, five-person mesh, rejoin, expiry and renewal, Stop under load.
- Android: a no-Play GrapheneOS handset (spry-turn GOALS G4): screen-off
  hosting, Stop from the notification, process death, Wi-Fi to mobile
  transition, charger unplugged, thermal stop, measured battery, temperature
  and data use. The existing test phone for the outside test on mobile data.
- Measurements (G9): idle off versus idle on CPU, memory, wakeups; throughput,
  latency, jitter, loss and Stop latency under sustained traffic.

Each gate is recorded separately with the exact revision; only the gate
actually passed is marked.

## 7. PR order

Smallest shippable first. Each ships independently once its own tests pass;
nothing is visible to users until K5 and A5.

| # | Repository | PR | Depends on |
|---|---|---|---|
| S1 | spry-turn | Merge `feat/room-relay-caps` and `feat/room-grant-seal` (existing branches) | none |
| K0 | kithmoot | Merge `feat/room-relay-sharing` (share rule, `spryKey`, registration, vouching) | S1 |
| A0 | kithmoot-android | Sharing parity: `spryKey` roster field, share rule, registration and vouching (planned in the seal design, not on `origin/main`) | S1 |
| S2 | spry-turn | Supervised standard mode for `spry-node`: no HTTP, Nostr control without the mesh, pre-trusted pairing key, embedded relay, `--exit-on-stdin-close`, explicit bind and public values, per-transport listener ports, relay-port-map passthrough, `spry-standard-v1` node card | S1 |
| K1 | kithmoot | Guests redeem a foreign standard `spry:` offer (card profile, URL rule, vectors, e2e); Hide my IP rule | S2, K0 |
| A1 | kithmoot-android | Same as K1 | S2, A0 |
| S3 | spry-turn | Aggregate bytes-per-second cap and a counts-only status line | S2 |
| S4 | spry-turn | `spry-portmap` crate with fake-gateway tests and a `spry-node portmap check` diagnostic (no relay started) | none |
| K2 | kithmoot | Outside test mode and encrypted result to host | K1 |
| A2 | kithmoot-android | Outside test mode (the phone as tester) | A1 |
| S5 | spry-turn | Port mapping wired into supervised mode: acquire, start, renew, restart on change, delete owned on stop, nonce persistence | S2, S4 |
| S6 | spry-turn | Release artefacts: macOS arm64, Windows x64, Linux x64 and arm64 executables; Android arm64-v8a and x86_64 library with C ABI; hashes in the release | S5 |
| K3 | kithmoot | Desktop packaging: bundle, sign, hash manifest, deb placement; still hidden | S6 |
| K4 | kithmoot | Desktop supervisor moves from the preview to supervised `spry-node`: state, keychain secrets, own pairing, lifecycle (sleep, wake, network change), Start-on-open | K3, S3 |
| K5 | kithmoot | Desktop UI and release, off by default; privacy page and legal refresh | K4, K2, owner UI review |
| A3 | kithmoot-android | Prepared, verified relay bundle and JNI loader; no UI | S6 |
| A4 | kithmoot-android | `:relay` foreground service, gates, notification with Stop | A3 |
| A5 | kithmoot-android | UI and release, off by default | A4, A2, owner UI review, GrapheneOS acceptance |

## Owner decisions needed

1. Approve option A (`spry:` control extended to admitted guests on standard
   nodes) as the v1 route, with the DNS route deferred.
2. Hide my IP: may a guest with it on use a member-hosted relay (automatic,
   one-time choice per host, or never), and may a host with it on turn the
   relay on.
3. Confirm the built-in relay is share-with-my-rooms only, with no Open to
   anyone, advert or anonymous issuer on desktop or Android.
4. `SPRY_ROOM_SEAL=required` for the built-in relay, or `auto`.
5. Built-in caps and data limits (tables in 1.6 and 4.3), and whether the
   person may raise them.
6. Autostart scope: only "Start it when KithMoot opens" in v1, or also launch
   at login and a tray-resident mode.
7. Automatic restart after a helper crash: none or one.
8. UPnP IGDv1 routers that grant only permanent leases: use with cleanup, or
   treat as unable to host.
9. Reachability test by members: automatic on first redemption, or only when
   the host asks.
10. Whether to compare the router's external address with a STUN answer from
    the person's existing STUN server, or rely on the remote test alone.
11. Windows: keep the helper unsigned like the app, or buy Authenticode
    signing (a cost; nothing is planned).
12. macOS Intel builds, which desktop does not ship today.
13. Android bindings: UniFFI as a new spry-turn dependency, or a hand-written
    JNI shim.
14. Android charging gate: required, or on by default and changeable.
15. miniupnpd as third-party software in CI test infrastructure only, or
    in-house fake gateways only.
