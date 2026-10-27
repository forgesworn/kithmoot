# Proton mapping diagnostic: operator-run experiment

This is the next local development tool after the
[desktop hosting preview](2026-10-26-desktop-spry-hosting.md). It is separate
from the desktop menu. Nothing runs automatically, starts Spry, publishes an
endpoint, changes VPN/firewall settings or sends credentials. ForgeSworn
provides no probe server. The owner's Archipelago node is unchanged.

## What is established

Proton's [app guide](https://protonvpn.com/support/port-forwarding) and
[manual guide](https://protonvpn.com/support/port-forwarding-manual-setup),
checked 26 October 2026, document an assigned UDP/TCP port and short renewable
leases. They do not establish the supported number of distinct simultaneous
ports or a contiguous allocation range. A single forwarded port does not cover
Spry's separate listener and UDP allocation sockets.

[NAT-PMP, RFC 6886 section 3.3](https://www.rfc-editor.org/rfc/rfc6886.html#section-3.3)
allows explicit nonzero internal ports and suggested external port zero for a
gateway-assigned port. Each protocol needs its own request. A response can
return a translated port and a different lifetime. Repeating an internal tuple
can return or renew a pre-existing mapping: a positive reply does not establish
that this process created or owns it.

Proton's Linux example uses private/internal port zero. This tool deliberately
does not use that provider-specific allocation flow. A failure of this explicit
nonzero-port experiment does not prove every Proton forwarding design fails.
There is no assumed provider quota. PCP and its optional port-set extension
remain separate protocols, without established Proton support here.

## Use and effects

Create an owner-controlled configuration outside the repository. Replace the
example source and gateway with the specifically reviewed VPN addresses;
private addresses alone do not identify a VPN. Choose spare non-privileged
ports, without another forwarding manager using those tuples. Do not copy
WireGuard/OpenVPN credentials into the file.

```json
{
  "sourceIp": "10.2.0.2",
  "gatewayIp": "10.2.0.1",
  "listenPort": 45001,
  "relayPorts": [45002, 45003]
}
```

These addresses are illustrative, not a discovered route. The exact four keys
are required. The listener must differ from the two to four distinct allocation
ports. The JSON must be a regular file at an absolute path, at most 8 KiB.
Validation refuses FIFOs without waiting for a writer.

First validate, with no network activity:

```sh
node desktop/spry-mapping-check.mjs --config /absolute/owner.json
```

For a live experiment, review applicable laws and VPN/ISP terms, and the effect
on other applications' forwarding. The explicit `--run` flag requests inbound
mappings. The optional report contains identifying network tuples; use a new
absolute path outside the checkout:

```sh
node desktop/spry-mapping-check.mjs --config /absolute/owner.json --run \
  --private-report /absolute/new-private-report.json
```

The report is exclusively created before requests, with mode 0600; an existing
file or symlink is refused. Console output omits source, gateway, public IP and
port tuples. No report is uploaded. Do not commit real endpoint evidence.

The diagnostic binds each UDP control socket to the exact supplied source IPv4
and connects only to the supplied private/CGNAT gateway on UDP 5351. There is no
DNS, default gateway discovery, multicast listener, route fallback or shell.
The source bind is not proof of interface confinement or an OS kill switch.
Connection refusal, an unavailable source address and an unavailable route now
have separate bounded diagnostic errors; raw OS errors still remain private.
Each request has an isolated socket, one datagram and a two-second timeout;
timeouts are incomplete observations rather than evidence of no support.
Replies from another address/port are discarded. Construction performs no I/O.

It asks for a UDP/TCP listener pair and two to four UDP allocation mappings,
using nonzero internal ports and suggested external zero. It records requested
and returned tuples separately, then waits until 45 seconds after the first
mapping request and renews each tuple once, suggesting its actually assigned
external port. The experiment ends after that one cycle; it is not a background
lease manager. The request count and timeouts are bounded, with no retries;
normal completion is near 45 seconds. SIGINT/SIGTERM cancel pending work.

It stops on refusal, malformed/mismatched reply, UDP port collision, different
UDP/TCP listener ports, changed address/port, implausible gateway epoch, or
expired/short/long lease. Grants of 50–60 seconds are accepted for this timing;
other grants are recorded and make the experiment incomplete. Conservative
expiry starts before request transmission, and delayed wake or renewal completion
does not establish continuity. A timeout or cancellation after transmission can
still leave a mapping at the gateway. This is a diagnostic clock check, not
portable physical sleep/wake acceptance.

There are no deletion requests, including on cancellation or partial failure.
The tool cannot safely establish ownership of a pre-existing mapping. It stops
renewal and relies on the gateway's granted expiry. It requests 60 seconds but
cannot guarantee a gateway honours that bound, nor shorten a returned older
lease safely. The private report retains attempts, bounded numeric refusal codes,
successes and granted lifetimes; expiry is never marked confirmed. No application
listener is opened on the tested internal ports by this diagnostic.

## Reading the result

`observed` means distinct replies and a stable per-tuple renewal cycle were
observed. It never means Internet hosting is ready. All results explicitly keep
route qualification, ownership, external reachability, independent lease
semantics and VPN confinement unproven. A translated external port sets
`portTranslationRequired`; it is not fed directly to today's native allocator.
`incomplete` or `cancelled` retains the bounded reason and partial observations.

The current supervisor supplies local URLs, binds a contiguous allocation range
and does not set an advertised public IP. Native `--public-ip` alone changes only
the advertised allocation IP. The native development source now accepts explicit
local/public UDP pairs with separate bound/advertised endpoint bookkeeping; the
desktop supervisor still needs the mapping/lease adapter and listener URLs.
This diagnostic does not configure either. Do not expand a range over
unmapped ports or substitute a public IP as a port-translation shortcut.

## Local acceptance and remaining evidence

Run the offline checks without Proton, credentials or an external server:

```sh
node --test desktop/test/spry-natpmp.test.mjs \
  desktop/test/spry-mapping-diagnostic.test.mjs desktop/test/spry-mapping-wire.test.mjs
```

Tests include actual loopback UDP request/response sockets and adversarial
datagrams, timeout, wrong source/port, cancellation/socket release, partial
refusal, per-tuple renewal, translation, collisions, epoch/address/port changes,
lease/wake expiry, redaction, config/FIFO refusal and the no-network default.
The 45-second cycle is simulated with a monotonic fixture clock. This is no
claim of a 45-second real Proton run. See the
[mapping receipt](evidence/spry-mapping-diagnostic-20261026.json) for final counts
and exact source hashes. Earlier native/Electron evidence remains the earlier
revision's record and was not rerun for these standalone additions.

Next obtain owner-operated Proton observations without competing forwarding
managers, establish its supported contract, and qualify several renewal periods.
Then integrate only the required native port-set/translation adapter and prove
bidirectional TURN traffic on every advertised endpoint from an independent
network. Test allocation expiry, reconnect, VPN loss/home-route exposure,
physical sleep/wake and sustained media performance separately. Native hosting
must stop when a qualified route is lost; this diagnostic is not that guard.
Encrypted Nostr access and separate opt-in announcements follow route acceptance.
The legal provider classification remains unresolved; mapping results cannot
settle it.

A later live address-only preflight on the inspected Proton VPN route returned
OS connection refusal before any mappings were requested. No VPN setting was
changed. This does not establish whether the app's forwarding setting is on or
that Proton cannot support the required mapping layout. The owner has asked for
automatic setup and does not need to diagnose network addresses manually;
engineering commands above are diagnostic tooling, not the intended product UI.
The [privacy and one-click requirements](2026-10-26-call-privacy-and-one-click.md)
keep Nostr relays, STUN servers and TURN media relays distinct.

After port forwarding was enabled, a fresh address-only preflight received a
valid NAT-PMP reply on the inspected VPN route. No mapping requests were sent,
and no application listener or public announcement was started. This supersedes
the earlier connection-refused observation, but does not qualify the required
listener and allocation ports. The Proton app is already managing its forwarded
port; coexistence with another mapping manager must be established before
requesting additional mappings. Direct WebRTC calls remain the normal path when
the person's privacy settings allow them. TURN media relay hosting is an
optional route for networks that need it, separate from Nostr room setup.
