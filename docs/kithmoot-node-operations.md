# KithMoot node: private implementation candidate

The design is [the node specification](design/2026-11-02-kithmoot-node.md).
This implementation is being delivered in stages. The current backend can
pair an owner, enrol rooms, project signed grants, remove devices and recover
interrupted room closure. The private Linux installer and client implementations are available for
review. This is not a public node release: signed dependencies, external
network qualification and applicable UI acceptance remain required. See the
[installer guide](kithmoot-node-install.md) and the web and Android UI review packs.

## Local operator commands

Build with `npm run build:lib`. `bin/kithmoot-node.mjs --help` lists the
commands. `init --state DIRECTORY --configuration FILE` validates an explicit
configuration and creates private service identity, TURN secret and state salt.
It refuses an existing configuration. An interrupted first initialisation
retains its marker and files for explicit recovery. Never copy these secrets
into a room descriptor, invitation, support log or release evidence.

The configuration has version `v:1`, a DNS `host`, `hosting` (`rented` or
`archy`), explicit IPv4 `relayIp` and optional public `publicIp`, explicit
`aggregateBytesPerSecond`, `maxBytes`, `minFreeBytes`, `maxRooms`, browser
`origins`, absolute installed `spryBinary` and `shelterBinary` paths,
`certificate` and `certificateKey` paths, and distinct `deskPort`, `spryPort`
and `shelterPort` values. The internal ports are unprivileged and must not
overlap the public TURN listeners or allocation range. The host and
`turn.<host>` both need trusted certificates and DNS. The configuration is
private and must be owned by the service user. Hosting selection is an
operator assertion; it does not discover an ISP or prove a machine is rented.

Run `run --state DIRECTORY` as an unprivileged service user. It holds one
durable writer lock, starts the two backends with explicit environments and
disconnected output, and restarts a failed child with bounded backoff. Every
two seconds it reconciles the children. Both require a 15-second monotonic
lease. A stopped or crashed supervisor therefore fails closed. Each child
has its own private state and loopback listener. The supervisor's local
control socket has mode 0600; its parent has mode 0700.

The [systemd unit](../deploy/node/kithmoot-node.service) keeps the children
in the service's control group, so a killed supervisor cannot leave orphan
children holding its ports and state locks through a restart. Use that
lifecycle on Linux. A manually launched foreground process has graceful
SIGTERM/SIGINT cleanup; killing it without its process group is not a
substitute for the systemd crash/restart boundary. The unit has been exercised on a disposable Debian systemd installation.
That local proof does not establish outside reachability or a production deployment.

Run `pair --state DIRECTORY` in a local terminal to print a single-use,
six-minute owner link. Its code is in the fragment and is not logged by the
service. The node stores only the code's digest. A new local pairing command
invalidates the previous code. The client pairing handlers are in the UI
review candidates. `status` returns counts; `doctor` checks local service
identity, DNS, certificate trust, storage, the four STUN transports and the
relay authentication challenge. It explicitly leaves outside reachability,
authenticated relay media and mobile-network acceptance to external checks.

## Public API behind the TLS front

Expose only the required routes. `/events` goes to Shelter, `/v1/credentials`
to Spry, `/node/v1/*` and `/groups/v1/events` to the supervisor. Other Spry
registrar paths stay local. Disable access and request-body logs. The proxy
must append the actual source address as the last X-Forwarded-For entry.
It must never expose either Unix socket or the internal HTTP ports.

All POST requests use JSON and NIP-98 proofs with kind 27235, empty content
and exactly `u`, `method`, `payload` and 32-byte base64url `nonce` tags.
`u` names the public HTTPS origin and exact path, even when the proxy forwards
locally. `payload` hashes the exact body bytes. The node verifies the
signature, timestamp, method, URL and body, and stores a bounded one-use
nonce window durably. Cookies are not authority. Browser origins are an
explicit allowlist; native clients still need signatures. Errors are fixed
codes. Unknown request fields and routes fail closed.

* `GET /node/v1/info` returns the node service key and fixed node profile,
  sole relay, files-off and relay-only policy. The keeper's signed descriptor
  must pin these before a client trusts them.
* `GET /node/v1/status` returns readiness and counts only. Its NIP-98
  authenticated POST form returns the paired owner's detailed node status.
* `POST /node/v1/claim` takes the local code, and pairs the signing public key
  as owner. It cannot replace an existing owner.
* `POST /node/v1/enrol` takes `room`, `authority`, `inviter` and optional
  `ends`. Only the owner can enrol. In node v1 the inviter is the authority.
  Existing enrolment is immutable. Room keys are never accepted.
* `POST /groups/v1/events` takes a keeper-signed kind 27541 event. Its
  NIP-98 signer must also be that keeper. The node verifies the enrolled
  authority, server, expiry, reset floor, grant identity and protected keys.
  Only `turn`, `relay-read` and `relay-write` scopes are supported. A 200
  acknowledges both child projections; a 503 leaves the committed grant
  pending and the identical signed event is safe to retry.
* `POST /node/v1/access` takes `room` and `grant`. A device can retrieve only
  its own current grant and Spry offer, signed revocation, or room reset.
  For an existing-room partition, `grant` may be omitted: the NIP-98
  signing device can retrieve only its own already-authorised active grant.
  Strict partitions, unknown devices, expired/revoked access and another
  room are refused. This does not admit a device or release room keys.
  A closed room returns its compact signed closure proof. A refused connection alone
  is never evidence authorising deletion on a device.
* `POST /node/v1/close` takes `operation` (random 16-byte hex), `room`, an
  absolute `deadline` up to 120 seconds ahead, keeper-signed `reset`, explicit
  kind 27543 `closure` statement and the
  signed 1461/1462 `events`. Only that room's authority can start it. The
  request is durably bound to its operation ID before any network effect.
  Its response contains a phase, not a premature success claim.
* `POST /node/v1/operation` lets the owner read one operation's counts and
  phase. It returns no room ID or ciphertext.

## Recovery and deletion

The durable close phases are publishing, draining, teardown, erasing and
done. Publishing is retried until the drain deadline. A missed closing
announcement does not prevent teardown. Both Spry revocation and Shelter
purge are attempted independently and their acknowledgements are saved.
Failed call removal stops lease renewal, so a reachable old relay cannot
retain authorisation indefinitely. Neither child failure prevents attempts
to remove access in the other. Restart resumes the recorded operation.

Only after both acknowledgements does the supervisor delete room, grant,
floor and child records and the stored closing ciphertext. It checkpoints
the WAL before reporting done. The completion receipt has the operation ID,
flags, acknowledged deletion count and time. Repeating a lost-acknowledgement
purge may report zero, so that count is not a forensic total. The operation
retains an irreversible request digest for 30 days to prevent rebinding after erasure.
The node retains a salted closed-room marker for the longest possible grant
lifetime plus clock skew. Its compact closure signature proof is erased after
30 days. Expired grants and reset floors are collected. It holds no room
traffic keys or keeper signing keys, and cannot forge a keeper closure.
The closure proof reconstructs a canonical kind 27543 statement using the
device's pinned room authority, room ID and node host; it also binds the
operation ID. A signed grant reset by itself is not permission to wipe a
device. The statement expires after 30 days. The ledger pins its host, service
key and salt identity and refuses a backwards clock jump, including restart.

This erases application records on the running node. Provider snapshots,
copies made by other devices and underlying storage-media recovery remain
outside that promise. A node operator deleting server files cannot instruct
devices to self-destruct without the keeper's signed proof.

## Reproducing the current backend test

Build the matching Spry `spry-node` executable and private Shelter `bothyd`
executable, then run `npm run build:lib` and:

```
E2E_NODE_SPRY_BINARY=<local-spry-node> \
E2E_NODE_SHELTER_BINARY=<local-bothyd> \
node test/kithmoot-node-backends.mjs
```

The script generates private certificates, keys and loopback fixtures. It
checks actual HTTP, Unix and WebSocket behaviour across the three processes
and removes its files and processes in `finally`. It emits only hashes,
check names and qualification limits. It does not test an internet node,
public TLS 443 routing, browser calls or a physical GrapheneOS phone.
The [delivery receipt](evidence/kithmoot-node-20261102.json) records that limit.

The public installer must refuse release packaging until approved, signed
Shelter and Spry releases, corresponding source, licences and the other node
release gates exist. This implementation does not publish private Shelter
source or binaries and does not deploy a new public service.


## Host-managed TLS and separate listener profiles

The default standalone profile still uses TURN UDP/TCP 3478, TLS 5349 and the
bounded relay range 49160:49191. An optional `turnPorts:{udpTcp,tls}` selects
two distinct unprivileged ports on the same node hostname;
`relayPortFirst` selects the first allocation port. Optional `relayPortCount`
selects 1–512 ports, defaulting to 32. A larger group needs an explicitly
configured budget and a compatible Spry build: seven devices require at least
42 allocations before renewal overlap. A 512-port profile allows 64 allocations
per credential and 512 TCP connections; the legacy profile retains its limits
of 32 total, eight per credential and 64 TCP connections. The aggregate
bandwidth limit remains independent. Firewall plans open exactly the configured
UDP range. All internal
and public ports must remain disjoint. HTTPS and the dedicated TURN hostname
remain on 443. Doctor, the TLS front, firewall plans and the public info
response use the configured profile. The paired client keeps that profile;
room enrolment refuses a descriptor signed for different ports.

Fold 0.17 records these optional ports in the keeper-signed descriptor. Earlier
strict readers reject such records. Existing default descriptors retain their
bytes. Do not change ports behind an active room's signed record: close its
rooms first, or retain their old listeners.

A declarative hosted Archy package may set `hosting:archy` and `tlsGate:true`.
That mode refuses certificate and certificate-key fields. Spry advertises the
hosted TLS ports and binds no TLS listener of its own; the host must supply
both TLS listeners and the public HTTPS/room-WebSocket routes. Standalone
system installation refuses this mode. Local supervisor readiness alone does
not prove that the host gate works; doctor and the external checks still apply.

The host profile requires three independent manifest-declared secrets, imported
at setup and checked against existing private state at every start. The CLI
reads only `KITHMOOT_NODE_SERVICE_KEY`, `KITHMOOT_NODE_TURN_SECRET` and
`KITHMOOT_NODE_STATE_SALT` for this profile. Those values are never command-line
arguments or log fields. Changed secrets stop recovery/start rather than
silently replacing an existing identity. Direct Linux setup continues to
generate its own private secrets. The supervisor and its children still run
as an unprivileged service user; an Archy image can declare its data UID through
the orchestrator instead of running the service as root.

`test/kithmoot-node-host-profile.mjs` is an opt-in disposable Linux fixture.
It runs the production supervisor and both backends as UID 1000, keeps the host
certificate key unreadable to that application, and supplies generated host
TLS gates. A separate Spry occupies 3478/5349 while the node uses 34790/53499
and 49192:49223. This qualifies the runtime profile and listener coexistence;
it does not establish Archy's actual app gate, FIPS, UI, public-network or
physical-phone acceptance.
