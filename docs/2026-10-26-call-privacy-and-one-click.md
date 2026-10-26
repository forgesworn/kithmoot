# Call privacy and the one-click hosting goal

Owner clarification, 26 October 2026: **no audio/video through Nostr relays**.
The priority is preventing call-content disclosure and minimising metadata
harvesting, while preserving performance and independent operation.

## The three different services

| Service | Role | What its operator can observe |
|---|---|---|
| Nostr relay | Room messages, operator announcements and encrypted setup/access messages. No call media. | Connection addresses, visible event fields/tags, timing, sizes and subscriptions. Encryption does not hide all relationships. |
| STUN server | Helps a caller discover network addresses. It does not forward audio/video. | Source address, request timing and protocol metadata. |
| TURN media relay | Forwards encrypted call packets when needed or chosen for IP privacy. This can be the caller's Spry server or an approved independent Spry operator, including an Archipelago deployment. | Source, allocation and peer addresses/ports, opaque temporary login, traffic timing, sizes, volume and duration. |

Joining a room through a Nostr relay does not establish a direct audio/video
route between participants. Direct WebRTC media needs no TURN media relay when
it works and the person permits it. The existing Hide my IP setting requires
credentialled TURN and must never silently become a direct connection.

## Call content is different from metadata

For the ordinary KithMoot WebRTC path, including Spry TURN forwarding, browsers
establish DTLS-SRTP with each other. A TURN media operator receives encrypted
packets, not media decryption keys. It cannot ordinarily listen to or watch the
call merely by operating Spry; it can still record ciphertext, analyse traffic,
delay packets or refuse service. This follows the
[WebRTC security architecture](https://www.rfc-editor.org/rfc/rfc8827.html#section-6.5)
and the inspected packet-forwarding path. It is not a claim that all servers or
compromised participant devices are harmless.

KithMoot signs the complete call signal, including SDP and DTLS fingerprints,
with the sending device key, then encrypts it under a fresh outer signing key
in `src/signal.ts`. Room admission verifies the device/credential binding in
`src/roster.ts` and `src/mesh.ts`. The browser checks the remote certificate
against that authenticated SDP. A Nostr relay or TURN media operator does not
gain permission to substitute an admitted media endpoint by modifying packets.

A participant receives playable audio/video and can record it independently of
cooperative recording notices. Room admission and endpoint security therefore
remain part of preventing an unwanted viewer.

The separate server forwarder is not a TURN media relay: it terminates WebRTC
transport encryption. The current browser integration additionally protects
encoded frames with room/sender-derived ChaCha20-Poly1305, and refuses forwarding
when the required protection cannot be installed. Relevant sources are
`app/src/forwarder-media.ts`, `src/media-crypto.ts` and `src/mesh.ts`. This turn
inspected that path; it did not execute a fresh hostile-forwarder media test.
Do not generalise the normal TURN property to an arbitrary media server.

## Metadata that remains visible today

Public Nostr signalling kind 21059 hides the sending device signature inside
NIP-44 encryption and uses a fresh outer key. The outer recipient `p` tag, kind,
timestamp, expiry and ciphertext size remain visible. The Nostr relay can also
correlate its connections. Current roster kind 20461 exposes the signing device
key and a room/epoch `d` tag, so observers can group device pseudonyms by that
identifier. Names, account credentials and track lists are encrypted, but a
claim of no observable room/activity graph would be inaccurate.

Existing Spry encrypted access kinds 24181/24182 expose transport keys,
recipient tags and request/reply correlation tags. Encryption protects their
bodies, not these outer fields. Ephemeral events and expiration do not guarantee
that Nostr operators or observers erase their copies.

Public TURN discovery is off until enabled. The existing query uses the person's
read Nostr relays through an unauthenticated discovery scope. The selected
operator's HTTPS credential request sends only `{"v":1}`, omits cookies and
referrer, refuses redirects and carries no room/account identifier. Network,
TLS, browser and typically Origin metadata remain. TURN logins stay in memory;
renewal contacts the same operator and the call does not search for unknown
operators mid-call. A signed advert identifies a key, not a trustworthy logging
policy. Existing source: `app/src/public-call-relays.ts` and
`src/public-call-relays.ts`.

The default public STUN service is currently Cloudflare when the room has no
own ICE service; see `src/ice-defaults.ts`. Own Spry configuration and relay-only
privacy have separate precedence/rules. Using a VPN changes the address another
operator may observe only if that actual route is correctly confined. Current
Proton kill-switch, home-address exposure and physical sleep/wake are unqualified.
No operator is proved log-free by an app setting or a Nostr announcement.

## Implemented privacy and admission increment

The web candidate now requires an explicitly saved opt-in before public profile
lookups and external profile pictures. Missing, malformed or unreadable storage
leaves the feature off; saved choices remain effective. The existing startup
uses that preference before requesting profiles and follows. This removes a
default path that otherwise sends room participants' account keys to profile
Nostr relays. Turning it on still has that disclosure cost. Older installed
clients may retain the earlier default. The local public privacy-page source
now names this behaviour and the room/recipient metadata above; it is unpublished.

The new [roster envelope 2 reader](protocol/roster-envelope-2.md) accepts a fresh
outer author with a device signature inside the encryption. It verifies the
exact body, room, epoch, outer key and timestamp, independently of the credential
and admission policy. The existing session writer remains legacy. Independent
synthetic conformance vectors are in `vectors/roster-envelope-2.json`; real
RoomSession/fake-media integration checks exercise admission and impersonation.
This is a reader-first compatibility stage, not a deployed metadata reduction
or an activation of the new writer. The shared room selector remains visible.

Two admission regressions were reproduced before fixing: an already-connected
peer could outlive an expiring kindred proof, and a queued early call signal
could live beyond its signed 20-second freshness window. Expiry is now checked
on sweeps and roster reads, with media reconciliation also notified when a read
discovers expiry first. A local expired admission reuses ordinary session
teardown and stops further presence publication. Held signals retain and check
their authenticated inner timestamp. Removing a caller is also tested against
fresh signalling and replayed roster entries. These local tests use generated
identities and fake media endpoints, not a physical or independent-network call.

Final related verification passed 701 tests across 25 files, with one existing
annotation stress test excluded after it exceeded its 20-second deadline in
both the changed source and a clean archive of the base revision. Its deadline
was not relaxed. The separate signal-flood check passed in isolation and the
final related run. The canonical library/app typecheck, including context-package
builds, passed. This is qualified local evidence, not an unqualified whole-suite
or installed-release pass. Exact source hashes, regression stages and remaining
gates are recorded in the
[privacy/admission receipt](evidence/kithmoot-privacy-admission-20261026.json).

## Product requirements

1. Keep direct WebRTC calling as the normal path when the person's IP privacy
   choice permits it. A TURN media relay is not a prerequisite for every call.
   Never encode audio/video as Nostr events. Use Nostr relays for bounded
   announcements and encrypted control.
2. Joining/calling must not enable STUN/TURN hosting. Hosting begins Off and has
   its own explicit action; public access and public announcements are further
   choices. The owner-configured JSON preview is engineering scaffolding.
3. After enable, handle route checks, limits, credentials, renewal and cleanup
   automatically. Explain a blocked hosting route in plain language rather than
   asking the person to diagnose addresses or construct port mappings.
4. When a TURN media relay is needed or explicitly chosen, prefer the person's
   own paired Spry and explicitly approved independent TURN media operators.
   Show/pin the operator transport key and hostname. Never treat speed, a signed
   advert or successful forwarding as proof of trustworthiness.
5. Preserve the chosen IP privacy mode. Failure may stop the call; it must not
   broaden the approved operator set or reveal a direct address silently.
6. Explain separately that media is encrypted and that connection metadata is
   visible to the chosen infrastructure. An own TURN media relay reduces a
   third-party operator's role but does not remove the VPN/ISP/peer/Nostr views.
7. Review reducing Nostr room/activity correlation as separate protocol work,
   with compatibility, admission, replay and performance tests. Do not rewrite
   roster envelopes or remove signature checks casually.

### Next bounded desktop experiment: direct calls through Proton

Electron 44.4.1 supports
[`webContents.setWebRTCUDPPortRange({ min, max })`](https://github.com/electron/electron/blob/v44.4.1/docs/api/web-contents.md),
including a single local UDP port. After this release, evaluate whether that
lets a desktop call use Proton's existing forwarded port directly. This does
not start a STUN server or TURN media relay. Ordinary direct calls must keep
working without this experiment or port forwarding.

The API limits local socket binding; it does not establish the public candidate
address, NAT translation or reachability. Proton's
[assigned port can change on reconnect](https://protonvpn.com/support/port-forwarding).
Prove matching local, forwarded and ICE candidate endpoints, a selected direct
pair and two-way audio/video from another network. Repeat with several peer
connections and rooms, port rotation and VPN loss; audio/video sharing a BUNDLE
transport does not prove separate peer connections can share one port. Retain
the chosen IP privacy policy and optional TURN media fallback. Do not enable a
fixed-port policy globally or claim this route is qualified from the API alone.

No UI redesign, Nostr media transport, new default operator, deployment or owner
Archipelago node change is implemented by this note. The
[desktop preview](2026-10-26-desktop-spry-hosting.md) and
[mapping diagnostic](2026-10-26-proton-mapping-diagnostic.md) retain their stated
local acceptance limits. Public desktop access over Nostr needs a compatible
ordinary-TURN adapter; today's private ULA profile and public HTTPS advert
contract cannot be silently reinterpreted.
