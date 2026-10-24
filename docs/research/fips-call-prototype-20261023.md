# FIPS call prototype: 23 October 2026

**Decision: retain FIPS as a transport candidate; do not integrate or ship
this pin as the calling solution yet.** A local media path works, while
several product requirements remain open and two concrete blockers were
reproduced.

The owner has now required [no publisher call-service authority and no call
logging](call-independence-requirements.md). Those are acceptance criteria;
this synthetic fixture does not establish either property for the product.

The [reproducible fixture](../../test/fips-call/README.md) is isolated from
production. KithMoot base is `bd322c6de13c389f67713171487e54fdba763e6b`;
FIPS is `4cab546c6117ce5dfd28b86a4ddcd4cd943978f5`. No released client,
private relay, public discovery, camera work or server configuration changed.

| Check | Observed result | Limit |
| --- | --- | --- |
| Two-source browser WebRTC through FIPS | Two-way decoded video and received audio energy | One host and one Chromium page; native helper required |
| Four-source full mesh | All twelve receiving connections passed continued-media checks | Synthetic sources, not four independent apps or a KithMoot room |
| Transit cut | All native-flow delivery counters stopped | Local designated-transit dependency, not real-world failover |
| Connected-flow identity isolation | Expected peer probe arrived; different node's probe did not | Two-second negative observation; not room admission or network abuse assessment |
| MTU 1472 | Media passed; native payload ceiling 1362 bytes | Explicit local configuration, no path-MTU guarantee |
| Default MTU 1280 | ICE round trips observed; no decoded media; six handshake-side datagrams exceeded 1170-byte ceiling | Failed DTLS/media path; no fragmentation adapter implemented |
| `leaf_only: true` on a transit | Synthetic traffic still crossed it | Flag cannot support an enforced no-transit assurance at this pin |

The four-second media windows are short smoke checks. Reported RTT is ICE
candidate-pair RTT on this host, not mouth-to-ear latency. They establish no
internet latency, long-call reliability, battery or thermal acceptance.

Evidence:

- [Successful media and identity/cut checks](../evidence/fips-call-20261023/media-1472.json)
- [Default-MTU failure](../evidence/fips-call-20261023/media-1280.json)
- [Leaf-only transit counterexample](../evidence/fips-call-20261023/leaf-transit.json)
- [Build and source provenance](../evidence/fips-call-20261023/provenance.json)
- [Dependency licence inventory](../evidence/fips-call-20261023/licence-inventory.json)
- [Independent AI legal review](../evidence/fips-call-20261023/legal-review.json)

## No-transit boundary

The separate probe creates `left -- middle -- right`, with all three nodes
configured `leaf_only: true`, no outer-to-outer peer, and discovery disabled.
A native datagram reaches right through middle. This is a behavioural
counterexample, not an inference from a configuration label.

At this pin, `core/src/proto/bloom/state.rs` stores the leaf-only boolean,
while `compute_outgoing_filter` still merges other peers' filters. Inspection
did not find a data-forwarding enforcement check for it. The observation is
sufficient to reject reliance on the flag, without claiming a complete audit
of every transport or routing path.

Before distribution, caller devices need an enforced, tested rule against
forwarding unrelated payloads. Explicit transit operators need separate
bounded forwarding controls. A single-neighbour test topology does not prove
that a deployed endpoint cannot acquire or use additional neighbours.

## Browser and Android gates

This helper copies packets beside the browser; it is not a browser-native
FIPS implementation. An arbitrary guest clicking an HTTPS link has not gained
mesh connectivity from this work. A remote gateway or compatibility transport
needs its own prototype and endpoint-key trace. A gateway must not silently
turn into a media endpoint or room-admission authority.

The pinned upstream native API is built for Linux, FreeBSD and macOS. Android
has an embedded crate/TUN surface and compile evidence, but no qualified
native API, host-app guide or physical-device acceptance. Choose between an
in-process datagram adapter and `VpnService` deliberately. The latter has a
[one-active-VPN constraint per user/profile](https://developer.android.com/develop/connectivity/vpn)
to resolve for people already using a VPN.

No GrapheneOS integration, Google runtime dependency, APK build or release
was introduced. Physical GrapheneOS without Play remains an acceptance gate.

## Licence and legal boundary

FIPS's root licence is MIT. The locked metadata also contains the Linux
runtime dependency `rustables 0.8.8` and its macro crate under
`GPL-3.0-or-later`. Those packages are absent from the inspected macOS
normal/build dependency closure. `option-ext 0.2.0` declares MPL-2.0, and
other dependency notices need review. This inventory is not licence approval
for bundling a Linux daemon or an Android library. No binary is distributed
by this experiment.

The legal-cover review applies shared jurisdiction-kit notes at local
revision `9243203`: overall verification 28 September 2026, relevant updates
23 October 2026. It does not establish an OSA exemption. The fixture keeps
media encryption in the browser and uses an opaque local forwarding helper,
but contains no KithMoot invitations, membership, revocation or public
service path. It cannot establish the production provider role.

The leaf-only counterexample withdraws any inference that this configuration
enforces opt-in transit. Actual unrelated-traffic forwarding, independent
transport operation, discovery, room authority and any future remote gateway
need assessment against what is implemented. Changing transport or moving
hosting country alone does not settle the role. The previous project
[call-transport legal position](../legal/call-transport-position.md) remains
separate from this unshipped experiment.

## Next implementation work

1. Enforce no-transit behaviour for caller devices and verify it with both
   refusal and legitimate endpoint-delivery cases. Define bounded opt-in
   transit separately.
2. Resolve the 1170-byte default payload mismatch without assuming every
   mobile route can use a larger MTU. Test loss, reordering and rekeying.
3. Prove two independent devices across separate NATs, including a network
   that blocks UDP. Measure sustained audio/video latency and failure modes.
4. Prove ordinary browser guest access early and trace encryption/admission
   through any compatibility gateway.
5. Qualify the Android adapter, existing VPN coexistence, licence obligations
   and physical no-Play GrapheneOS behaviour; then test real four-person rooms
   and battery use.

Sapflow and RelaySwarm were not added. The existing WebRTC engine already
provides conversational media and endpoint encryption for this spike;
changing codecs, broadcast distribution or room protocol would obscure the
transport question it tests.
