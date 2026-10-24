# Experimental realtime wire v1

This is the adapter wire format, not a change to the KithMoot room protocol
or RelaySwarm HLS wire. Current qualification covers the accompanying browser
endpoint and native Node operator; it does not establish Android/Swift call
endpoint interoperability or a stable published protocol. Room admission and
source/codec bindings must be exchanged through the application's authenticated
control path.

## Compressed media

Each publication carries one VP8 video or Opus audio source. Separate fresh
128-bit random IDs identify camera video/audio and protected screen video/audio.
The source binding authenticates the sender's 32-byte device public key,
publication ID, camera/screen role and fixed codec configuration. Operator
presence does not supply that binding. A receiver must bind the packet kind
to the expected publication before delivering decoded media.

The current codec profile uses VP8 and mono Opus at 48 kHz, with bounded
video dimensions, frame rate and bitrates. These parameters are explicit SDK
configuration, not values selected by the forwarder. The encoder's chunk
timestamp and duration are integer microseconds. Unsupported codec APIs fail
closed.

## Encrypted frame and datagrams

All multibyte integers and the timestamp use network byte order. The fixed
header is 54 bytes.

| Offset | Size | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `KRF1` |
| 4 | 16 | Random publication ID |
| 20 | 8 | Random per-sealer nonce salt |
| 28 | 4 | Non-wrapping unsigned sequence counter |
| 32 | 1 | Kind: 1 video, 2 audio |
| 33 | 1 | Key chunk: 0 or 1 |
| 34 | 2 | Zero-based fragment index |
| 36 | 2 | Fragment count |
| 38 | 8 | IEEE-754 binary64 integer timestamp, microseconds |
| 46 | 4 | Unsigned chunk duration, microseconds |
| 50 | 4 | Complete ciphertext length including authentication tag |

The timestamp must be a non-negative JavaScript safe integer. Compressed
payloads must contain 1 through 524,288 bytes. ChaCha20-Poly1305 adds a
16-byte tag. The publication key is HKDF-SHA256 with the room key as input,
no supplied salt and the UTF-8 info string
`kithmoot/realtime/v1/<lowercase sender hex>/<lowercase publication hex>`.

The nonce is the eight salt bytes followed by the four counter bytes.
Authenticate the complete header with its fragment index set to zero, then
encrypt the compressed payload. The ciphertext is split into chunks of at
most 12,234 bytes. Each datagram repeats the header with its own index and
contains one ciphertext chunk, for a maximum datagram length of 12,288 bytes.
Count and final-fragment size must exactly match the complete ciphertext
length. Never encrypt fragments independently under the same nonce.

The sender counter refuses to wrap. A new call/publication uses a fresh
random ID and salt. Transport replacement preserves the sealer and its
counter. Receiver key bindings never come from packet labels alone. The
header is authenticated but remains visible, including kind/timing and
fragment geometry; this is payload confidentiality, not traffic anonymity.

Receivers bound each publication to eight incomplete assemblies and a total
reservation of 1 MiB. Local assembly expiry is 120 ms for audio and 500 ms
for video. Complete authenticated frames enter a 64-sequence replay window;
the application reorders complete video frames for at most 40 ms in a four
frame/512 KiB buffer, delivers increasing decoded sequences and fences video
dependencies after an unresolved gap. Rejected future deltas do not advance
the decode cursor past a late keyframe. Unknown publications, malformed fragments, inconsistent headers,
failed tags and replays are dropped. Assembly expiry is local residence, not
a synchronised capture-to-playback deadline.

The key is shared-room-derived. It excludes an operator without the room
key, but another room member can derive the same publication key. Do not
describe this scheme as per-sender signatures or an MLS sender ratchet.

## Rendezvous and forwarding control

Use RelaySwarm session wire v3, `webrtc-live` transport and the selected
operator's pinned transport public key. Signals are signed and pairwise
NIP-44 encrypted. The separate random operator namespace is not a room key.
The independent Node operator initiates SDP and creates the data channel;
the browser endpoint answers. The operator uses RelaySwarm's native backend,
which loads node-datachannel/libdatachannel internally. This changes the
transport implementation and offerer role, not the participant media format.

1. `live-bind` carries bounded `publications` and `subscriptions` arrays of
   opaque IDs, under a fresh 32-hex-character request ID.
2. The operator applies its own transport client/capacity policy, constructs
   an initiator peer without starting negotiation and replies `live-bound`
   under that ID. Its payload must contain `offerer:"operator"` and
   `maxPacketLifeTimeMs:250`; the endpoint rejects an unsupported policy.
3. The endpoint installs and starts its answering peer, then sends
   `live-ready` with the same request ID and an empty payload. The operator
   starts the matching initiator exactly once after that signal. A binding
   without readiness expires and releases its transport slot after 15 seconds.
4. RelaySwarm offer/answer/trickle ICE retains the binding's request ID.
   The operator creates an unordered channel whose `maxRetransmits` is null
   and `maxPacketLifeTime` is exactly 250 ms. The browser checks those actual
   remote DCEP values. The native facade reports its own local creation
   request and refuses unknown incoming channels or remote offers; its
   attributes are not an assertion about an uninspected remote DCEP mode.
   There is no reliable or alternate-backend fallback.
5. `live-keyframe` names one publication. Forwarding requires a matching
   subscription, owner and connection generation. Requests and received
   callbacks are limited before invoking encoders/signalling.

An attachment permits at most four publications and 64 subscriptions;
operator capacity is separately bounded. Retired bind IDs are remembered in
a bounded, expiring map to reject replay during the signalling replay window.
Subscribing does not confer decryption or room membership. Clients reject
unbound publications irrespective of what the operator forwards.

Signed `call-forwarder` presence is advisory and limited to explicitly pinned
operators, capability keys matching the event author, a short age window and
expiring hints. Older announcements cannot overwrite newer open/closed state.
No presence event grants room admission, media keys or a mandatory service.

Spry, when explicitly selected through ICE configuration, carries network
traffic requiring TURN. Sapflow's bounded ciphertext queue operates before
RelaySwarm sends these datagrams; its HLS/broadcast framing is not this wire
format. Native backend licence/source notices and build/runtime boundaries
are described in [the adapter integration guide](realtime-call-adapter.md).
