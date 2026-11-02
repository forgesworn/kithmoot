# What KithMoot can learn from Anagram's Iroh calls

26 October 2026. Source assessment with a deferred comparison design. No
transport was integrated, benchmarked or deployed by this review. The accompanying
[product gap review](../anagram-gap-review-2026-10-26.md) records the messaging
work separately.

Selected transport-independent lessons are now accepted in
[product call-quality goals](../product-goals.md#call-quality-and-continuity--added-26-october-2026)
and [execution packages P1.5/P1.6](../pwa-execution-plan.md#p15-audio-continuity-queues-and-resource-ownership).
They cover audio continuity, bounded work, media recovery, native cleanup and
group efficiency on our existing stack. Their acceptance remains open; the
Iroh comparison below remains deferred reference material.

## Finding

The owner's working direction after this comparison is to improve the existing
KithMoot/Sapflow/RelaySwarm/Spry stack without adopting Iroh. No Iroh integration
or comparison experiment is planned. There is no demonstrated benefit that
justifies the dependency, adapter and client-qualification work at present.
This is a prioritisation decision, not evidence that our stack is already
faster or more reliable. Revisit only if a concrete missing capability or
measured limitation makes Iroh relevant.

Anagram remains useful reference material. It demonstrates one small
application-specific Rust wrapper shared by browser WASM and native
clients, encrypted endpoint identities authenticated through Nostr, and calls
that require no ICE/STUN/TURN configuration in the guest's UI. The underlying
Iroh dependency supplies substantially more implementation than that wrapper.

WebRTC can also give guests automatic connectivity when the deployment supplies
working routes and TURN credentials. Compare the complete setup and operating
arrangement; absence of a guest configuration screen is not unique to Iroh.

It does not remove relay infrastructure, implement KithMoot membership, or
supply a complete conversational media engine. Anagram implements its own
codecs, jitter buffer, queueing, playback and native IPC handling. Several of
those responsibilities already exist in our experimental realtime SDK.

Apply useful media, queue, diagnostic and lifecycle lessons to our current
stack independently. Prioritise audio continuity, network-transition recovery,
bounded group-call upload and physical client acceptance. A full stack
replacement is not justified by this source comparison.

## Evidence and attribution

- KithMoot source: `28786a0c42568b46f842e1dee249e57132ec2f86`.
  Companion source pins: RelaySwarm `de2cbd6f32dc6b890c814324282dd0bcd5574e8f`
  and Sapflow `27cea3d2fa629ee23724f40a9e6ae75f2a8ac5df`, from
  [`realtime-sources.json`](../../realtime-sources.json).
- Anagram source: `a4db9c697d77e3f8e15ca985af5e68677bc61a7d`.
  Its wrapper pins Iroh and iroh-relay **1.3.0**, disables default features and
  uses `tls-ring`. Browser bindings use wasm-bindgen 0.2.122.
- The owner relayed the Anagram developer's assessment that calls work well and
  that an audio packet-dropping bug is being fixed. This is developer self-report,
  not an independent test, an identified root cause or a verified fix. The
  supplied conversation did not identify the affected build/platform.
- Official Iroh documentation was read on 26 October 2026. General documentation
  describes default deployments; the pinned application's source determines
  which features Anagram actually enables. Some documentation describes
  relay-only mode as upcoming while other current guidance and this source
  expose `clear_ip_transports`; that wording is not evidence the app uses direct
  peer IP paths.

## Responsibility map

| Responsibility | Anagram/Iroh | Current KithMoot | Reuse decision |
| --- | --- | --- | --- |
| Room membership and people/devices | Application Nostr signalling and host-controlled call roster | KithMoot/fold-kit admission, participant credentials, grouped devices and agent ownership | Retain our application model. An Iroh endpoint key is a transport identity, not room authority. |
| Finding/authenticating a transport peer | Encrypted Nostr signal supplies ephemeral endpoint ID, relay and call ID; Rust checks peer ID, ALPN and call confirmation | Existing encrypted signalling; separate RelaySwarm rendezvous in the SDK | Reuse Nostr as the authenticated address handoff. Bind any new endpoint to room, device, call generation and expiry. |
| Establishing the network connection | Iroh QUIC through its relay protocol; browser and native share the wrapper | Ordinary WebRTC ICE/DTLS/media; SDK WebRTC data channels and native Node backend | Iroh is an alternative client transport plus a different relay protocol. It is not a Spry TURN server drop-in. |
| NAT/restricted-network reachability | Current Anagram disables native IP transports; browser Iroh is relay-only | ICE selects direct or explicitly configured TURN; Spry is an optional TURN operator implementation | Compare real connection setup, relay-only behaviour and blocked-UDP networks. Direct native Iroh is a separate configuration to qualify. |
| Media capture and protection | Application-owned capture and codec path | Existing voice/camera effects, selective media grants, screen crop/redaction and recording policy | Reuse our processed streams and consent model. Transport cannot select raw capture on failure. |
| Encoding, jitter and rendering | Application packet Opus/VP8 and legacy WebM paths | Browser/native WebRTC media today; WebCodecs, bounded queues and playback in the SDK | Compare media policies separately from connection transport. Iroh does not supply echo cancellation or codec policy on our behalf. |
| Group distribution | Full mesh, up to six participants in link-call rooms | Ordinary mesh/forwarding; SDK supports one encrypted publication upload to a selected forwarding operator | Preserve and compare topology explicitly. Sharing an encoder does not eliminate one network copy per mesh recipient. |
| Forwarding privacy | Iroh relay forwards endpoint-encrypted traffic | Our SDK forwarding node receives already encrypted media publications | Keep the SDK's media encryption if an Iroh connection terminates at a forwarding operator. TLS to that operator alone would expose plaintext there. |
| Native/browser lifecycle | Shared Rust core; native main-window bridge and session-bound handles | Browser WebRTC; native Android engine; separately packaged SDK backend | Investigate a shared core, without assuming Tauri IPC directly fits Electron or Kotlin. |
| Service operation | Configurable Anagram/default/public Iroh relays | Independently selected operators; private owner deployment remains separate | Preserve the agreed operating arrangement. Changing transport does not require selecting a ForgeSworn-operated public service. |

## The important browser constraint

General native Iroh can establish direct UDP paths and fall back to relays.
Browser Iroh cannot use the same raw UDP paths and currently requires relays.
Anagram also explicitly calls `clear_ip_transports()` on native builds, so this
version chooses relay-only connectivity for both environments. Its minimal
preset takes addresses from Nostr rather than enabling the standard public
address-lookup preset.

The relay connection is HTTPS upgraded to WebSocket over TCP 443. This can be
useful on networks where UDP fails, provided WebSocket upgrades are allowed.
It also means QUIC datagrams can still be delayed by packet loss in the outer
TCP connection. Datagram semantics do not remove head-of-line blocking in that
carrier. Measure actual delayed speech and freeze recovery, not merely whether
QUIC is present.

The shipped pool contains `iroh.nostr.com` plus four n0 public relays. Official
n0 guidance describes its free public relays as development/hobby infrastructure,
with rate limits, no SLA and support concentrated on current versions. Their
presence in another app is not a capacity or availability guarantee for us.
An independent operator can run an Iroh relay; it is a separate protocol from
TURN and cannot be substituted by changing a TURN URL.

Sources: [Iroh browser support](https://docs.iroh.computer/languages/wasm-browser),
[network/carrier behaviour](https://docs.iroh.computer/configuring-networks),
[public relay policy](https://docs.iroh.computer/iroh-services/relays/public),
[Anagram Rust endpoint](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/iroh-calls/src/lib.rs#L63),
[relay pool](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/utils/irohRelays.ts#L27).

## Concrete lessons

| Lesson | Observed implementation | Application here |
| --- | --- | --- |
| Keep control, audio, camera and screen independent | Four ordered bidirectional streams with descending priorities; a separate audio datagram path. Receivers keep one pending read per stream and complete ready before media. | Protect mute/hangup and audio from camera/share work. Independent streams still share congestion and may share the outer TCP carrier. Do not claim total isolation. |
| Spend latency on current speech | 20 ms mono 48 kHz Opus frames at 32 kbit/s, FEC enabled, a 40–160 ms adaptive jitter target, concealment, generation/sequence checks and bounded catch-up. | Compare this with our SDK decoder/playout, which is not the ordinary browser WebRTC jitter engine. Audio continuity merits a separate diagnostic gate. Values are experiment candidates, not proven tuning for our devices. |
| Bound every queue, including IPC | Audio datagrams are at most 1,100 bytes; transport buffers are 2,200 bytes sending and 8,800 receiving. Native reads return at most four recent packets, with bounded draining. Per-peer native sends permit two in flight and one latest pending. | Instrument capture, worker, native bridge, transport, decoder and playback separately. Count intentional deadline drops apart from missing network packets. A browser-to-native round trip must not serialise every 20 ms frame. |
| Encode once for equivalent recipients | Shared microphone encoder; video encoders keyed by original track and quality profile; per-peer send state. A slow peer does not immediately lower quality for all. | Retain our SDK's once-per-source encoder model and compare the ordinary call path separately. Encoder savings are not mesh bandwidth savings. |
| Recover the affected media only | Packet-video dependency fences and keyframe requests; legacy camera/screen restart controls; audio continues during video failure. Native Linux deliberately negotiates legacy audio because of a WebKitGTK realtime-worklet failure. | Test camera/share failure while speech continues, and negotiate real capabilities before selection. Do not copy the Linux fallback into unrelated engines or treat fallback as platform parity. |
| Give native handles a clear owner | Main-window access checks, fresh WebView session IDs, stale-result rejection, bounded handle maps and cleanup after reload. Binary IPC avoids JSON media copies. | Useful for any future Electron/Rust or Android adapter. Keep source ownership and asynchronous cleanup explicit; the application should not retain microphone/camera resources after transport shutdown. |
| Assert what users actually receive | Native probe uses the production transport, local TLS relay and synthetic media; checks changing decoded pictures, audio playback, mute, reconnection and hangup. | Extend our existing media qualification rather than substituting connection-state assertions. Attribute source tests, executed results and developer reports separately. |

Source anchors: [transport/lanes](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/iroh-calls/src/lib.rs#L164),
[audio send/receive bounds](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/services/callPacketAudio.ts#L155),
[jitter buffer](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/services/callAudioPackets.ts#L72),
[Opus worker](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/services/callAudio.worker.ts#L39),
[shared video encoder](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src/services/callPacketVideo.ts#L245),
[native bridge](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/src-tauri/src/iroh_calls.rs),
[probe](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/scripts/native-calls/run.mjs).

Anagram currently uses long-lived reliable camera/screen lanes. Iroh's own
[real-time protocol guidance](https://docs.iroh.computer/protocols/using-quic)
suggests also evaluating short-lived, prioritised streams that can be reset
when a media object becomes stale. Its recommendation is not a benchmark.
If prototyping, compare audio datagrams, existing ordered lanes and cancellable
video-object streams; do not assume every media type benefits from the same
reliability policy. Stopping retransmission inside QUIC cannot retrieve bytes
already queued in an outer TCP connection.

## What we already have, and the adapter mismatch

The [published realtime SDK preview](realtime-release-20261024.md) already combines
KithMoot protected media and frame encryption, Sapflow bounded queues, RelaySwarm
datagrams and optional Spry TURN. It has generated-media 2/4/8-person evidence,
but normal website/Android calls do not use it. Independent client networks,
blocked-UDP fallback, long calls, physical GrapheneOS and battery acceptance
remain open. A retained eight-person picture-age p95 of 1.431 seconds is a
quality concern, not evidence that Iroh is faster.

Our [`DatagramSender`](../../src/realtime/forwarder.ts) and
[`RealtimeCallAdapter`](../../src/realtime/adapter.ts) are useful seams for a
comparison, but a naive transport substitution is incorrect:

- [`wire.ts`](../../src/realtime/wire.ts) permits **12 KiB application datagrams**.
  Anagram's audio path only accepts its versioned, at-most-1,100-byte packets.
  Those are different wire formats. Native QUIC path limits must be queried
  and tested; do not assume a WebRTC message-sized datagram fits.
- Existing fragment geometry is authenticated and validated. Lowering the
  global datagram constant would change fragmentation assumptions. Use a
  bounded transport envelope/reassembly below the existing wire, or design and
  qualify an explicitly versioned transport framing. Preserve encryption,
  replay checks, nonce continuity and authorised source bindings.
- Our send facade returns an immediate admission result with a local deadline.
  Iroh stream writes are asynchronous and reliable lanes have no equivalent
  blanket 250 ms packet-lifetime contract. Define bounded admission, expiry,
  cancellation and close behaviour instead of claiming that contract unchanged.
- Keep our media seal when using an Iroh connection to a fan-out operator.
  If that operator is a QUIC endpoint, it has that connection's TLS plaintext;
  only the additional participant media encryption keeps the forwarded frames
  opaque. Pairwise endpoint encryption and group forwarding are different roles.

## Deferred comparison design: reference only

This preserves how a fair comparison could be made if a concrete need emerges.
It is not the current delivery plan or a prerequisite for improving our stack.

1. **Transport-only seam.** Build an isolated Iroh adapter beneath the existing
   room/media boundary. Use ephemeral endpoint identities bound by authenticated
   room signalling. Keep processed capture, codecs, source bindings and media
   encryption fixed. Specify the framing/MTU/deadline contract above first.
   Use explicit test relay selection; no product default or public deployment
   is implied. No new room or group protocol is required.
2. **Matched network paths.** First compare two participants using the same
   codecs and relay-only topology over WebRTC/TURN and Iroh. Separately compare
   a permitted native-direct Iroh path; do not mix its result with relay-only
   privacy. For groups use matched mesh or matched fan-out, then evaluate
   topology independently. Include Chromium, Firefox and WebKit before choosing
   a browser-wide result; add native GrapheneOS as a distinct client gate.
3. **Audio first.** Feed timestamped synthetic speech-like audio; measure playout
   delay, longest gaps, total concealed/dropped audio, reconnect time, duplicate
   playback and queue residence. Report counts at every boundary, distinguishing
   deliberate stale drops, datagram gaps, FEC/concealment and sink underruns.
   The relayed developer report gives no basis to blame Iroh itself, TCP, IPC
   or the jitter buffer for the reported bug.
4. **Impairments and lifecycle.** Exercise random and burst loss, reordering,
   constrained upload, stalls, UDP blocking, failed WebSocket upgrades, one slow
   receiver, late join, repeated mute/camera/share changes, relay failure,
   sleep/wake and Wi-Fi/mobile/VPN transitions. Verify the existing privacy
   refusal behaviour, key/source binding and cleanup. A failed path must not
   expose raw media or silently enable direct peer-IP disclosure.
5. **Readiness evidence.** Predeclare comparison budgets before the run. Record
   exact sources/assets, runtime/platforms, selected paths, encoded/decoded media,
   audio gaps, latency distributions, CPU/RSS, radio/relay bytes and resource
   teardown. Run repeated short diagnostics before a 45-minute physical call.
   Keep synthetic, independent-network, physical-device and owner acceptance
   results separate. Check dependency licences and shipped binary provenance
   before distributing any adapter; a matching WASM hash alone is not a
   reproducible-build or licence-acceptance result.

Any future adoption case would need to demonstrate a worthwhile improvement
without losing supported clients, privacy, group distribution or maintenance
clarity. Current work should adopt useful media/IPC ideas without adding Iroh.

## Forward secrecy and the supplied discussion

Encrypted one-to-one and group calls are implemented in Anagram. The developer's
reported satisfaction with them is not an independent quality measurement.
In the supplied discussion, the remark about forward secrecy and restoration
appears to concern stored message history; it is not evidence that live Iroh
calls are unencrypted.

The [Anagram group specification](https://github.com/lnbits/anagram/blob/a4db9c697d77e3f8e15ca985af5e68677bc61a7d/nips/nip171.md#security-and-limitations)
states that recovery-master compromise exposes all recorded past epochs and
future epochs under that master. Ordinary KithMoot likewise makes no stored-room
forward-secrecy claim, and its MLS preview is not production. Distinguish live
transport encryption, message key evolution, device key erasure, retained local
history and exported recordings/backups. Iroh selection does not settle those
storage and recovery policies.
