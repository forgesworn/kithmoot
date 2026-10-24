# Realtime call adapter

This experimental adapter combines KithMoot endpoint media, RelaySwarm
encrypted rendezvous/datagrams, Sapflow's bounded ciphertext queue and
operator-selected TURN such as Spry. It is a separate SDK path. Preparing it
does not switch the existing KithMoot website or Android application to it.

| Component | Role in this adapter |
| --- | --- |
| KithMoot | Participant admission, protected capture, VP8/Opus encoding, frame encryption/decryption and endpoint playback |
| RelaySwarm | Signed NIP-44 rendezvous, selected-operator discovery hints and bounded WebRTC datagrams; its native Node backend supplies the operator's ICE/DTLS/SCTP implementation |
| Sapflow | The actual Rust/WASM queue for complete ciphertext frames, with byte/frame/residence bounds and video dependency recovery |
| Spry | Optional operator-selected TURN reachability for paths requiring a network relay |

The native library runs inside the RelaySwarm operator backend. It is not
another hosted call service and supplies no room authority, camera or codec
implementation to this path. Sapflow's HLS origin is not used for these calls.

The packet and control contract is in [realtime wire v1](realtime-wire.md).

## Boundaries

Participants capture and protect their sources, encode VP8/Opus with
WebCodecs, seal compressed frames with ChaCha20-Poly1305, and put the complete
encrypted frame through Sapflow's actual Rust/WASM queue. RelaySwarm carries
bounded unordered datagrams with an exact 250 ms packet lifetime, negotiated
with its signed pairwise NIP-44
signalling. A selected independent Node operator fans out ciphertext using
RelaySwarm's native initiator backend, backed by node-datachannel/libdatachannel.
Each publisher has one outgoing publication path rather than a separate upload
for every receiver. Spry supplies NAT traversal when the endpoints select it;
there is no built-in relay account, root secret, credential endpoint or
ForgeSworn service default.

The operator receives opaque publication/subscription IDs and transport
identities. It has no room-key, media-decryption, capture or recording API.
It can refuse transport, suppress packets and observe connection/traffic
metadata. A subscription requests bandwidth; it does not admit someone to a
room. Membership and publication bindings come from the application's
authenticated room control path. Signed discovery is an expiring hint from
locally pinned operators, not a global directory or membership authority.

The room key derives publication keys using a distinct protocol domain,
sender and fresh random publication ID. Authenticated headers bind kind,
keyframe flag, timestamp, sequence and fragment geometry. Nonces use a random
session salt plus a non-wrapping counter. Replacing a transport preserves the
counter; a new publication needs a fresh ID. Receivers bound incomplete
assemblies and maintain a replay window. A forwarder without the key cannot
decrypt or create an accepted replacement frame. Every room-key holder can
derive other publication keys: this is not publisher-exclusive authentication
against a malicious room member. It is not an MLS sender ratchet.

Queue deadlines and reassembly limits use local monotonic clocks. They bound
local retention, not arbitrary network delay before first arrival or an
unsynchronised end-to-end age. The codec bridge bounds queued work, requires
fresh video keys after dependency loss, and limits audio scheduling. Keyframe
feedback is bounded before it reaches a Nostr relay. Unsupported codecs fail
closed; no HLS or raw-media fallback is selected.

Complete authenticated video frames also pass through a bounded reorder
stage: at most four frames/512 KiB and a 40 ms wait for a missing predecessor.
A late keyframe can unlock following deltas. Receiving an unusable future
delta never advances the delivered cursor past that keyframe. Lost chains
are fenced and request recovery rather than feeding incomplete dependencies
to a decoder.

The adapter and operator wrapper have no persistent call logger. Operator
startup/refusal messages are generic. Dependency debugging is refused before
connections because it can contain ICE credentials. Operating-system,
container, crash-dump, relay and hosting-provider logging require separate
configuration and assessment. Absence of an application logger is not an
assertion of zero transient state or infrastructure metadata.

## Build

Use Node 24 and the repository's locked npm dependencies. Relevant companion
source/build files must match `realtime-sources.json`; these are source revisions,
not published package/release claims.

```sh
npm ci
# Explicit native source preparation; see RelaySwarm's native build notes.
(cd ../relayswarm && node scripts/build-native-realtime.mjs)
npm run build:realtime
npm run build:lib
```

`build:realtime` builds Sapflow's pinned WASM with the installed matching
wasm-bindgen CLI and bundles the selected RelaySwarm source. It writes the
operator under `dist/`, browser assets under `app/public/realtime/`, and a
manifest of source revisions/file hashes and generated asset hashes. It
includes Sapflow, RelaySwarm and WASM dependency licence notices. The wrapper
build requires the explicitly prepared native artifact; it does not fetch
or silently substitute sources or binaries. Relevant dirty
companion files differing from the reviewed revision are refused by default.
Unrelated companion commits may advance HEAD; both that HEAD and the exact
reviewed dependency closure are recorded. Explicit
`--allow-working-tree` is for local qualification and records that state.

The Node build uses RelaySwarm's initiator-only native facade and an explicitly
prepared source build of the **node-datachannel 0.33.4** binding with patched
libdatachannel/libjuice. Its required native identifier is
**0.24.5-forgesworn-turn-close.1**. The patch sends authenticated TURN release
requests before destroying the native socket. The operator checks the prepared
sidecar's hash, platform and actual library identifier before creating peers.
It does not load an npm platform prebuild or select an alternate backend.
Native binaries, backend code and operator receipts are excluded from the
browser assets and PWA precache.

`dist/realtime-runtime/operator-backend.json` records the native package
versions, source revisions, patch hashes, platform and built facade/operator
hashes. `native/native-addon.json` records the prepared binary and source
inputs; `native/SOURCE_NOTICE.txt`, `native/LICENSES/` and `native/patches/`
accompany the separate native dependency and its modifications. Binary
distribution must preserve licence/notices and provide the covered source,
including the changes, as the applicable licences require. RelaySwarm/KithMoot's
MIT source does not make the combined native distribution MIT-only. Building
on macOS does not establish Linux runtime qualification.

The selected libjuice backend supports TURN over UDP. The native facade
refuses TURN/TCP and TURN/TLS configuration instead of ignoring unsupported
servers. This restriction is specific to this experimental operator backend;
the existing website/Android call engine has separate transport evidence.

`kithmoot/realtime` exports the SDK. Load prepared browser assets from the
application origin with `loadRealtimeRuntime(new URL(...))`; media operators
are not trusted suppliers of executable application code. WASM responses
have a size bound and a fetch timeout.

## Application integration

Before calling the adapter, the room's authenticated control path must
exchange `SourceBinding` values. A binding names its sender, camera/screen
role and separate fresh audio/video publications. It must be authenticated
with the room's existing admission rules, not copied from an operator's
advertisement. Codec configuration must likewise be participant-authorised.

1. Use existing camera/privacy controls and protected screen/window/area
   sharing to produce local `MediaStream`s. The adapter accepts their
   processed output and never chooses a raw capture source on their behalf.
2. Create `RealtimeCallAdapter` with the room key, actual Sapflow
   `queueFactory`, local sources and validated remote bindings.
3. Start an explicit `RelaySwarmSession` with user-selected Nostr relays and
   transport identity. Discover only locally pinned operators, or select a
   known operator directly. Give `connectRealtimeService` the source IDs,
   subscription IDs and that device's independently issued ICE credentials.
   It binds the transport routes, verifies the operator-offerer/250 ms policy,
   installs the browser answerer and sends `live-ready` before the operator
   creates its SDP offer. All messages retain the same binding request ID.
4. Deliver received datagrams to `adapter.receive`, pass its keyframe
   requests through the connection, and call `adapter.replaceForwarder`.
5. Render remote video and use `createRealtimeAudioMixer` to mix remote audio
   into one playback sink per listener. Per-source gains and RMS meters remain
   independent, while codec/mixer processing uses null output sinks where
   available. This avoids allocating a hardware playback device for every
   processing/measurement graph.
   Close the adapter and owned playback resources when leaving. Caller-owned
   camera/share tracks are preserved for their existing owner to stop.

To replace an unavailable operator, connect to another explicitly selected
operator and call `replaceForwarder`. Neither operator receives the room
key, and the replacement does not require a software publisher lookup or
room re-admission. Callers remain responsible for distributing updated
bindings on join/leave/rekey; close and recreate the adapter with the updated
sources/key and fresh publication IDs. This SDK does not invent a second membership
protocol or change the existing KithMoot room wire format.

## Independent operator

Create a private mode `0600` JSON configuration. Use your own transport key
and namespace and the intended clients' transport public keys. Neither the
namespace nor this transport key is a room/media key.

```json
{
  "relays": ["wss://relay.example.invalid/"],
  "namespace": "operator-chosen-random-rendezvous-namespace",
  "secretKey": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
  "allowedClients": ["REPLACE_WITH_CLIENT_TRANSPORT_PUBLIC_KEY"],
  "iceServers": [],
  "iceTransportPolicy": "all",
  "maxPeers": 16,
  "advertise": false
}
```

```sh
node dist/realtime-forwarder.mjs /private/path/operator.json
```

For TURN, supply operator-issued `iceServers` and select `relay`; an empty
relay-only configuration cannot connect. Each browser receives its own
short-lived profile independently. No TURN credential is put into the room
link. The Node operator initiates SDP and creates its own unordered/250 ms
channel; the browser answers and validates the actual remote DCEP reliability.
The native facade exposes the configuration of its own locally created
channel and refuses remote offers or unknown incoming channels. It does not
fabricate negotiated attributes for a native answerer. The wrapper refuses
unknown configuration fields, including room keys, rather than acquiring a
room admission role. Configuration and source preparation do not start a
public credential issuer, directory, or managed service.

## Qualification

```sh
npm run test:realtime:unit
npm run typecheck
npm run test:realtime
REALTIME_TOPOLOGY=mesh npm run test:realtime
```

The finite integration gate uses actual compiled Sapflow WASM, actual
RelaySwarm/NIP-44/WebRTC, a separate Node operator and generated VP8/Opus
media. It checks continuing decoded audio/video and playback for every
source, protected sharing, induced loss and operator replacement. The mesh
comparison keeps codecs, encryption and datagrams constant. Reported upload
counts application datagram bytes, excluding IP/DTLS/TURN overhead; frame-age
measurements use checksummed synthetic pixel timestamps and same-host clocks.
Invalid markers are missing observations, not latency values.

The [combined qualification report](research/realtime-adapter-qualification-20261024.md)
records the exact backend receipts, group results and remaining gates. Older
Werift or unpatched-native results do not establish the prepared replacement
binary's teardown or media performance. A generated-binary transport check
alone does not establish multi-participant media or WAN performance.

An explicit private `REALTIME_PROFILES_DIR` supplies a separate profile per
browser and per operator for the Spry run. Without it, the finite test uses
explicit loopback direct ICE and makes no TURN claim. Traces, screenshots,
camera/screen recordings and credential exports are not part of this gate.

Browser software support, native Android integration, physical no-Play
GrapheneOS acceptance, independent client networks, real OS capture pickers,
WAN loss/jitter, long-duration reliability and battery use need their own
evidence. Nothing here establishes an Online Safety Act exemption; the
combined offering's legal classification remains unresolved in
[the existing assessment](research/combined-call-transport-20261023.md).
