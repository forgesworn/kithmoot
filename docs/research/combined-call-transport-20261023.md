# Combining Spry, RelaySwarm and Sapflow for calls

23 October 2026. Design assessment and legal-cover findings, not a shipped
integration, deployment qualification or legal advice.

The proposal is a combined stack: participant-controlled KithMoot rooms,
WebRTC for initial browser conversational media, independently operated
Spry transport, and selected RelaySwarm/Sapflow primitives. Evaluate a new
encrypted real-time distribution adapter for larger calls separately from
the existing HLS distribution path. Owning all these components makes this
practical to investigate; their individual tests do not prove the combination.

## Component boundaries

| Component | Supported by inspected code | Role in the combined design |
| --- | --- | --- |
| KithMoot | Per-endpoint peers and track senders (`src/mesh.ts:1957`, `src/peer.ts:648`); device-selected relay takes priority (`app/src/ice-resolve.ts:102`) | Participant-controlled rooms, admission, media capture, protected screen/window/area sharing and local redaction |
| Spry | UDP relay allocations with UDP/TCP/optional TLS client connections (`../spry-turn/src/turn.rs:29`, `:199`; `src/main.rs:121`); locally minted REST credentials (`src/main.rs:100`) | Reachability and bounded packet forwarding on independently selected operators' servers; retain coturn compatibility |
| RelaySwarm | Browser WebRTC with supplied ICE policy (`../relayswarm/src/browser/hls-swarm.mjs:2200`), ordered data channels (`:2308`), verified HLS segment distribution (`src/browser/peer-link.mjs:3`) | Evaluate reuse of rendezvous, peer selection, bounded transfer and integrity mechanisms; interactive media distribution needs a new adapter and deadline policy |
| Sapflow libraries | Runtime-free compressed-media modules (`../sapflow/crates/sapflow-client/src/lib.rs:1`), typed native SRT publisher boundary (`crates/sapflow-ffi/src/srt.rs:1`) | Evaluate bounded queues, shared compressed samples and native platform adapters where they measurably help; these do not establish a browser call SDK |
| Sapflow origin | SRT/RTMP ingest, HLS output, scoped publishing authority, callbacks and optional recording (`../sapflow/crates/sapflow-server/src/main.rs:109`, `:115`, `:154`, `:188`) | Separate broadcast use case. This origin is not an opaque private-call forwarder |

Paths in companion rows are relative to their named repository unless a
`../` prefix is shown. These are source findings, not live-service readback.
Reviewed heads: KithMoot `bb20e0dd`, RelaySwarm
`20693eae4ad99475caadc84f1315ea3a426544d0`, Sapflow
`2d20835ef246740ab42ca810df7c51fd43bf9ff6`. Spry was initially an uncommitted
tree; its ten source-manifest hashes matched inspected files. A separate
work session subsequently committed it as
`48d75adf51c73b1ef2a51a3cb663e424f2b4ea35`. The Archy experiment uses that
immutable source pin and its updated committed manifest. Spry work was preserved.

## What could improve

Spry's retained M4 benchmark contains 36 native ARM64 loopback runs. Recomputing
medians from `../spry-turn/docs/evidence/m4-native-final.json` gives
16.6–22.3% higher delivered-packet throughput, 18.9–22.8% less process CPU
time and 78.3–82.2% less process RSS than the tested coturn configuration.
The runs record 14.4 million forwarded packets and zero observed loss or
corruption. This review checked the recorded data; it did not rerun the load.
Those results exclude kernel socket memory, use up to two UDP sockets per
optimised allocation, and establish neither WAN nor Linux nor TLS performance.
They do not measure glass-to-glass delay, intelligibility or phone battery.

A full mesh of N people sends each published track to N-1 peers. Four
participants can mean three outgoing copies per sender; eight can mean
seven. TURN forwards these packets and does not remove that multiplication.
The application's selected topology and tracks determine actual traffic.

A useful combined experiment would send one encrypted media publication
to an independently chosen forwarding node, which distributes permitted
streams to the other participants. Whether that means an SFU, a participant
forwarder or a bounded multi-hop design is still to be measured. A simple
tree reduces some sender upload but can add hops, delay, churn and forwarding
load. Room members must authorise recipients; transport operators must not
gain application media keys. Browser encryption API support and refusal
behaviour must be qualified before claiming this boundary works.

This would be new real-time forwarding functionality. Existing RelaySwarm
HLS segmentation and its ordered reliable data channel are not already a
drop-in conversation engine. Reusing discovery or scheduling does not require
routing interactive media through the HLS origin. SRT transport encryption
likewise does not establish participant-to-participant confidentiality through
an origin which terminates it and handles media.

## Legal-cover findings

The intended role remains software publication with independent, replaceable
transport. Code supports Spry's narrower transport boundary: loopback
defaults (`src/turn.rs:112`), operator secret (`src/main.rs:53`), HMAC/expiry
authentication (`src/turn.rs:843`), transient allocation metadata
(`src/turn.rs:199`) and restricted relay targets (`src/turn.rs:1156`). No room
directory or application membership authority was found in that source.
Current private deployments and the combined future offering need separate
classification; this review did not inspect live servers.

The law remains in jurisdiction-kit's
[GB online-services note](https://github.com/forgesworn/jurisdiction-kit/blob/main/law/gb/online-services.md):
verified 28 September 2026, review due 28 March 2027; section 2.11 includes
primary sources read on 23 October 2026. `[P]` records a primary source;
`[U]` records unresolved application or interpretation.

- OSA section 226(12)'s access-facility distinction is `[P]`. Applying it to
  TURN, a distributed forwarding network and this combined offering remains
  `[U]` (2.2, 2.11). A relay's ability to impede access by withdrawing
  transport does not by itself establish underlying room admission control.
- Spry makes independent operation easier and supports the intended boundary.
  Its name, licence, efficiency, encryption and absence of access logs do not
  establish an exemption. Assess who actually provides the combined service.
- Preserve operator-owned secrets, device-selected substitution and
  participant-held admission. No ForgeSworn room directory, shared root
  credential, call entitlement, mandatory gateway or revocation authority.
  Public client/WASM code must never hold a relay operator's root secret;
  Spry's `src/wasm.rs:82` credential helper does not change this requirement.
- Reviewed Spry Rust source has no per-client access or payload log writer.
  It still holds addresses/usernames/permissions in memory and prints startup
  errors or requested credentials (`src/main.rs:35`, `:112`, `:145`). Host,
  wrapper, crash-dump and provider logging remain unverified. Define the
  requirement as no persistent call logs, not no transient connection state.
- Do not inherit a whole-suite no-logging claim. Sapflow has refusal/event
  logs, optional recording and publishing authority (`main.rs:31`, `:109`,
  `:188`). RelaySwarm's demo can issue viewer cookies and broker credentials
  (`demo/turn-credential-service.mjs:58`, `:93`); its deployment config has
  persistent state and container logs (`deploy/compose.yml:19`, `:39`, `:57`).
  Reuse selected primitives rather than silently importing these services.
- Independently operated infrastructure still needs its own role assessment.
  Data protection, PECR, investigatory powers and communications questions
  remain separate (3, 4.1, 5, 7). Do not shift an unqualified exemption claim
  from ForgeSworn onto every self-hoster or volunteer forwarding peer.

A bounded watch search found Ofcom's existing
[decentralised-service explanation](https://www.ofcom.org.uk/siteassets/resources/documents/online-safety/information-for-industry/other/online-safety-act-explained-qa-web.pdf?v=409647),
which applies the provider test to decentralised services. It did not locate
a TURN-specific determination; that is a search limit, not proof none exists.
Existing KithMoot and Spry legal drafts already retain the material
qualifications. No public notice or deployment change was made by this review.
No new statutory deadline or cost was determined by this source-only check.

## Concrete qualification sequence

1. Keep the unresolved native sender/receiver stall in
   [the rejoin report](call-rejoin-20261023.md) open. Reproduce it and identify
   its cause; changing relays does not prove it repaired.
2. Add Spry as an alternative disposable backend for the existing real
   KithMoot group/rejoin/protected-sharing gate. Use opaque temporary
   operator-issued credentials, with publisher endpoints blocked and no root
   secret in browsers. Require actual decoded/visible video and audio energy
   in every direction, not ICE connectivity alone.
3. Compare coturn/Spry with identical clients, topology, media, geography and
   transport policy. Exercise UDP, blocked-UDP TCP/TLS, loss/jitter, refresh,
   churn and overload. Measure first audio/video time, freezes, jitter-buffer
   delay, packet loss, frame cadence, CPU, total memory, upload and battery.
   Keep controlled synthetic timing evidence separate from human call quality.
4. Prototype a separate encrypted real-time forwarding adapter, reusing
   measured RelaySwarm/Sapflow primitives. Compare it to mesh at 2, 4 and 8
   participants; count additional hops, forwarding bandwidth and failures.
   Test loss of the chosen forwarder and replacement without publisher help.
5. Qualify public certificates/firewall port bounds, independently operated
   servers, separate networks and physical no-Play GrapheneOS. Spry's
   `GOALS.md:18` explicitly leaves these deployment gates open. Reassess the
   actual discovery/credential/forwarding roles before any public rollout.

The follow-up [Archy/Spry integration report](archy-spry-integration-20261023.md)
records four local KithMoot cases against each transport backend and the
private Archy package preparation. That increment tests the Spry/WebRTC
combination only; RelaySwarm/Sapflow real-time forwarding is still unimplemented.

The [24 October public and physical qualification](public-call-qualification-20261024.md)
adds passing browser UDP/TCP/TLS calls, protected sharing and group rejoins,
plus owner-confirmed picture and sound on physical no-Play GrapheneOS using
native TCP and browser TLS. Native TLS remains unresolved. These results do
not change the scope of the combined stack: RelaySwarm and Sapflow are still
planned contributors to a new real-time forwarding adapter, not components
of that tested call path.

The later [combined realtime adapter qualification](realtime-adapter-qualification-20261024.md)
records a separate experimental SDK that now uses RelaySwarm datagrams and
Sapflow's actual Rust/WASM queue with operator-selected Spry TURN. Direct,
same-codec mesh and public UDP 2/4/8 media gates pass; repeated public
eight-person calls use the same credentials and release their allocations
after the native teardown fix. The eight-person picture-age tail reached
1.431 seconds in the short repeat run, so production quality remains open. This SDK
has not replaced the standard website or Android call engine and does not
resolve the legal classification above.
