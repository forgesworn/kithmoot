# KithMoot through Spry, and an operator-owned Archy package

23 October 2026. Local implementation and evidence, not a public rollout.

The owner chose Archy as an installation route for independently operated
call services. ForgeSworn supplies software/protocols; operators control
their installations, service keys, exposure and publication. Clients must
be able to discover and replace services without a mandatory publisher
directory, root account or call entitlement. Participant room admission and
media keys must remain separate from transport resource authentication.

## Implemented and tested

`test/automatic-call-fixture.py` now accepts `E2E_TURN_BACKEND=coturn|spry`.
Spry requires an explicitly selected absolute executable path. Failure to
start that backend refuses the fixture; it does not silently use coturn.
The existing real Node credential issuer, request boundary and browser
media checks are retained. The fixture returns a backend identifier and
Spry executable SHA-256 with aggregate assertions, never credentials.

Both implementations passed the final ordinary-build gate independently:

| Case | Spry | coturn |
| --- | --- | --- |
| Fresh guest logins; issuer receives no cookies, authorisation, referrer, room query or body; idle TLS does not block requests | Pass | Pass |
| Rejoining camera's delayed first frame keeps the playback sink attached | Pass | Pass |
| Initial two-person call, three-person group, three successive rejoins; fresh decoded video/audio and visible playback in every direction | Pass | Pass |
| Protected synthetic window/tab sharing; receiver decodes visible pixels and the hidden region stays hidden | Pass | Pass |
| Issuer refusal leaves chat available and refuses a relay-only call without creating a peer | Pass | Pass |

Media cases check nominated relay/relay candidates with TLS and actual media,
not connection state alone. Protected sharing uses generated source pixels,
the actual app redaction flow and receiver-side pixel sampling. It does not
exercise the operating system's real capture picker or any private screen.
External HTTP/WebSocket traffic is denied in the group/share boundary tests.
TypeScript root type checking passed. No Android code was changed.

The [bounded browser evidence](../evidence/archy-spry-20261023.json) retains
all ten final case outcomes and numeric assertions. Earlier four-case
passes are not added to that count. Two earlier attempts failed before
browser cases: the old fixture certificate was v1 and rustls rejected it;
a later attempt lost the reused sibling executable to concurrent cleanup.
The fixture now generates a SAN-bearing v3 test certificate. The final
Spry gate used a rebuilt, task-owned executable, whose hash is retained.
The runtime source is identical between Spry implementation commit
`48d75adf51c73b1ef2a51a3cb663e424f2b4ea35` and its documentation-only head
`bb1129ad008da7331372aee9d28902b5f5d61322` used for that rebuild.

This comparison establishes compatibility for these local cases. Elapsed
test durations under shared host load are not latency or performance
measurements. The separate M4 UDP benchmark remains bounded by its own
method; no new quality/speed claim is made here.

## Archy package experiment

In `archipelago-apps`, `scripts/prepare-spry-turn.py` prepares a private
local context from the immutable implementation commit. It verifies source
hashes, copies only committed allowlisted source/licence files, refuses
existing output paths and symlinks, disables lazy fetching/replacement Git
objects, and leaves public exposure/discovery off. Preparation does not build
or deploy anything. The generated manifest requests an independent node
secret through Archy's existing secret mechanisms; actual runtime secret
isolation is still unverified.

Packaging source and evidence are committed locally there as `b8a2370` on
`feat/operator-call-transport`; nothing was pushed or published by this work.

Ten package tests passed. The generated `spry-turn-lab` manifest passed
18 shell-validator checks and Archy's actual Rust parser at upstream
`7abd04a7f680e72105ae783cecbe2268e3c8e71b`.

The separate local Docker build succeeded for Linux ARM64. Its process
started with a read-only root, dropped capabilities, no external network
and Docker logging disabled; its credential command produced a verified
HMAC. This was not an Archy installation or a network media test inside
that image. Image/source hashes and limits are retained in
`archipelago-apps/docs/evidence/archy-spry-package-20261023.json`.

The package binds loopback only, stays outside the installable catalogue
and uses a local image tag with no pulling. It cannot be advertised as a
ready Internet relay. The operator/service discovery and rollout boundary
is in `archipelago-apps/docs/archy-call-services.md`. No live node, registry
publication, public service, central issuer or directory was added.

## Legal-cover and outstanding work

The intended publisher role and independent operator roles remain separate.
Legal-cover's notes are verified overall 28 September 2026, due 28 March
2027, with section 2.11 updated on 23 October 2026. The statutory
access-facility distinction is `[P]`; applying it to the actual combined
offering remains `[U]`. The AI legal review found the documented boundaries
appropriately qualified; it is not a solicitor opinion or an OSA exemption
finding. See the [combined assessment](combined-call-transport-20261023.md)
and jurisdiction-kit's law note linked there.

The next implementation needs Spry's bounded relay-port/firewall plan and a
shared signed transport-discovery contract with independent implementations,
expiry/withdrawal/replay handling and direct operator credential supply.
Discovery itself must not become publisher-operated calling authority.
Archy's actual node lifecycle, public certificate trust/renewal, host logging,
cross-network operation and physical no-Play GrapheneOS acceptance remain open.

The [intermittent native media stall](call-rejoin-20261023.md) has not been
fixed by a green rerun or a different relay. It still needs a deterministic
reproduction and cause-specific repair before broader call qualification.
RelaySwarm/Sapflow real-time forwarding is still a separate unimplemented
adapter; no performance or legal conclusion about that full stack follows
from these Spry/WebRTC tests.

Test servers, browsers and TURN processes/containers stopped. The local
package image, private source context, executable copy, raw scratch reports,
task web outputs and dependency symlink were removed after evidence capture.
Both task Rust builds were cleaned. The pinned upstream Archy source cache
and shared Docker build cache remain available; they run no services.
Unrelated sources, private Spry evidence and existing services were preserved.
