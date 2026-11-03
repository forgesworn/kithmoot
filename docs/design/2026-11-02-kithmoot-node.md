# KithMoot node: calls and chat for invited guests, on a server the keeper runs

Design baseline, 2 November 2026. Implementation status is recorded below.
Covers KithMoot web and desktop
(`forgesworn/kithmoot`), KithMoot Android (`forgesworn/kithmoot-android`), Spry
(`forgesworn/spry-turn`), Shelter (the event shelter in `forgesworn/bothy-node`,
a private repository), the group grant contract (`forgesworn/wildbloom-node`)
and the optional Archipelago package (`forgesworn/archipelago-apps`).

Owner decisions, 2 November 2026:

- Calls must work out of the box for the people the owner invites. Without a
  relay about one call in five fails (`deploy/README.md`, "Why TURN matters").
- KithMoot stays a client. The servers ship as a separate **KithMoot node**
  package, installed with one command on an Archipelago (Archy) node or a
  small rented server, never at home, so no home IP address or personal
  network is exposed by the node.
- Spry provides STUN and TURN, not coturn. Shelter is the room's only Nostr
  relay.
- Only people the keeper admits get relay or TURN access. A join link lets
  someone ask; the keeper admits. A bearer link alone grants nothing.
- Removing someone revokes their devices' grants and TURN access and asks
  those devices to delete their copy. The remaining members keep the room.
  Ending a chat revokes every grant and purges the room from Shelter, with
  NIP-40 expiration on every event as a backstop. No access or payload logs.
  Copies on other devices and ISP or VPN records cannot be wiped, and the
  app says so.
- Rooms on a node contact no Google or Cloudflare STUN and no public Nostr
  relay.
- The desktop and Android built-in call relay
  (`docs/design/2026-10-28-built-in-relay.md`) stays, off by default, as an
  advanced option that warns it shows the person's home IP to guests.
- ForgeSworn writes the software. It runs no node, relay, credential broker,
  directory or default for this.
- A hosted server is not anonymous: the provider knows who pays. That is
  accepted. No hosting provider or purchase is recommended here.

Tags: **[unverified]** marks a claim not checked against source, documentation
or a running system for this design. **[decision]** marks an owner decision,
listed at the end.

Implementation update, 2 November 2026: Spry's standard node profile (PR 33),
Shelter's private room relay (private PR 134), Fold's node wire format
(0.16.1), the node supervisor (KithMoot PR 671) and client SDK (PRs 673 and
674) are merged. The web and desktop UI candidate has a real-browser,
three-process admission, encrypted chat, removal and closure test. Its UI
remains unapproved. Android, the installer, Archy integration and external
media qualification still require work. This is not a public node release.
See [operations](../kithmoot-node-operations.md),
[client integration](../kithmoot-node-clients.md) and the
[UI review pack](../kithmoot-node-ui-review.md).

The source comparisons in section 0 record the original design audit.
PRs 669, 670 and 672 subsequently corrected automatic STUN to Cloudflare
only, refreshed publisher/operator facts and fixed stale browser assertions.
Ordinary rooms retain the existing default TURN service; no shutdown or new
live node deployment has been authorised. Shelter publication and maintainer
UI acceptance remain separate owner and maintainer decisions.

## Summary

- A KithMoot node is three processes behind one TLS front: **Spry**
  (`spry-node`, standard profile, public mode off, every room grant sealed) for
  STUN and TURN on UDP, TCP and TLS including port 443; **Shelter** (`bothyd`
  event store in a new room-relay profile) as the room's only relay, with
  NIP-42 on every connection; and a small **node supervisor and grant desk**
  (`kithmoot-node`, new, in this repository) that holds the one admitted-device
  list and drives both.
- The admitted-device list is written in one contract that already exists:
  kind 27541 group grants (wildbloom-node `docs/GROUP-GRANTS.md`, profile
  `group-grants/1`), signed by the room's authority key, with the scopes
  `turn`, `relay-read` and `relay-write` that the contract reserved for S8 and
  S9. The desk turns each grant into a sealed Spry registration and a Shelter
  allowlist entry, so one revocation ends both.
- The node holds no room key. The keeper's own app signs grants when the
  keeper admits someone. Node rooms are therefore ask-first: the link reaches a
  narrow **ask door** on Shelter that takes only requests addressed to the
  room's inviter, and nothing else.
- A guest types nothing. The link names the node's relay and STUN; once
  admitted, the guest's app receives its grants inside the room, signs in to
  Shelter with its room device key and fetches five-minute TURN credentials.
- Ending a chat publishes the closing rekey, resets the room's grants, removes
  its Spry grant and allocations, purges its Shelter partition and asks every
  device to run the existing self-destruct tidy-up.
- Rooms without a node keep today's defaults, with a clear message when a
  call cannot connect. What happens to ForgeSworn's public `/turn` stays the
  owner's decision.

## Verified starting point

Read on 2 November 2026 from kithmoot `origin/main` c3ee51d9, kithmoot-android
`origin/main` 7a7aa07a, spry-turn `origin/main` 8db0f6e (release 0.4.1),
bothy-node `origin/main` b099459, wildbloom-node `origin/main` f5d071a,
archipelago-apps `origin/main` 9172080 and jurisdiction-kit `origin/main`
d6c101a.

| Fact | Where |
|---|---|
| Commit 4aa6be8f (1 November) made `/turn` the default credential endpoint again (`TURN_CREDENTIAL_ENDPOINT ... ?? '/turn'`), set default STUN to Google then Cloudflare, put relay.trotters.cc first in the web relay list and sent host candidates again | `app/src/main.ts`, `src/ice-defaults.ts` `DEFAULT_STUN_URLS`, `src/local-address-filter.ts` `HIDE_HOST_CANDIDATES = false` |
| Commit c3ee51d9 (2 November) reverted the web relay list to three third-party defaults; Android keeps relay.trotters.cc first under decision (a). The `/turn`, STUN and host-candidate changes of 4aa6be8f stand | `src/public-relays.ts`, `docs/decisions.md` "Default relay divergence across clients" |
| Commit a8db879d qualified TURN over TLS on port 443 for ForgeSworn's own deployment through Caddy SNI routing to coturn; Android 0.6.132 pins the existing hostname and ports and rejects a credential with an unfamiliar address | `deploy/turn-443.md` |
| A room link carries `r` (relays) and `i` (ICE hints) in its fragment; `decodeExtras` falls back to `DEFAULT_ICE_URLS` when `i` is empty | `app/src/main.ts` `encodePayload`, `encodeRoomUrl`, `decodeExtras` |
| A room's relays are fixed at creation in its signed invitation and used by every member ahead of their own | `docs/protocol.md` "Room relays" |
| A Spry offer travels only inside the encrypted descriptor (kind 20465), so only admitted members see it | `src/spry.ts` `SpryOffer`; `docs/protocol.md` |
| Spry `https:` offers need a dotted DNS name; their TURN URLs must be exactly `turn:<host>:3478` (UDP, TCP) or `turns:<host>:5349`. `spry:` standard offers allow only `turn:` on one public IPv4 literal, no `turns:` | `src/spry.ts` `spryEndpoint`, `spryCredentials`, `isSpryStandardTurnUrls` |
| Spry room grants: a paired app creates one grant per room scope, registers device keys (`/v1/grants/devices`, sealed), members may vouch for up to four keys for 24 hours, credentials last at most 5 minutes | spry-turn `docs/api.md` "Room-grant paths"; `app/src/spry-room.ts`; Android `SpryRoomRegistrar.kt` |
| `trust_pairing` (a pre-trusted pairing key) and the aggregate bandwidth cap exist only in supervised mode, which has no HTTP listener | spry-turn `docs/api.md`, `docs/supervised-mode.md`, `crates/spry-service/src/supervised.rs` |
| The standard profile reads `SPRY_TURN_PORT` (3478), `SPRY_TLS_PORT` (5349), `SPRY_RELAY_PORTS` (49160:49191), caps of 32 allocations, 8 per user, 32 TCP connections; `SPRY_TLS_GATE=true` advertises TLS terminated by the host; `SPRY_ROOM_SEAL=required` enforces sealing | spry-turn `docs/public-mode.md`, `docs/standalone.md` |
| Spry has no access log; changing the TURN secret invalidates every credential and a restart drops every allocation; there is no rolling dual secret | spry-turn `README.md`, `docs/operations.md` "Credentials" |
| Spry's public deployment and replacement of coturn are unqualified | spry-turn `docs/operations.md`, first paragraph |
| Shelter's sheltered partition is reachable only over Link; its public `wss://` front allows anonymous reads of the public partition and writes only from keeper keys, kinds 0, 1, 3, 5, 6, 7, 10002, 10050, 10063 | bothy-node `docs/2026-09-10-durable-event-shelter.md` "Authority and privacy" |
| Shelter guests hold a kind 24242 `t=event-grant` naming a persona `p`, a device and an exact `d` room; guest writes must be signed by that device | same |
| Shelter deletion is author-bound (NIP-09); NIP-40 expired events vanish from queries at once and are swept each minute; SQLite secure deletion is on, "not a claim of secure erasure from WAL, backups or the storage device" | same, "Durability and limits" |
| Shelter limits: 32 connection slots shared by both doors, 120 inbound frames per minute per connection, 16 subscriptions, 128 events per history request | same |
| Kind 27541 group grants: authority-signed, one node per grant (`server`), scopes include `turn`, `relay-read`, `relay-write`, revocation and per-room `reset`, at most 90 days, delivered in the room's control channel and by `POST /groups/v1/events` | wildbloom-node `docs/GROUP-GRANTS.md` sections 4 to 7 |
| GROUP-GRANTS section 6.9 says a group relay must gate the connection, not each event's author, because bells (1464), signal wraps (21059), quiet drops (1059) and member epoch grants (20472) are signed by throwaway or one-time keys | same |
| The keeper (`kithmoot-agent create`) already mints, renews and revokes kind 27541 storage grants (`--group-node`, `--group-withdraw`, `--group-reset`); the web app receives grants (`GrantReceiver`) but does not mint them; Android has `GroupGrants.kt` with vectors | `src/node/cli.ts`, `src/group-grants-keeper.ts`, `app/src/group-room-grants.ts`; Android `protocol/.../GroupGrants.kt`, `GroupGrantVectorsTest.kt` |
| A v3 group link lets the bearer read kind 1463 and take the epoch-0 secret with nobody online; a temporary meeting (v2) uses a live handshake and a 12-hour delegation | `docs/persistent-groups.md` "Wire format"; `docs/protocol.md` "Room links and admission" |
| Conference rooms carry `ends` (up to 30 days) and tag every member event with a NIP-40 `expiration`; self-destructing rooms make each device NIP-09 delete what it signed, delete its files and wipe the room locally | `docs/persistent-groups.md` "Conference rooms", "Self-destructing rooms"; `src/self-destruct.ts` |
| KithMoot signs NIP-42 only with a signed-in account, per relay, after explicit consent; an invitation must never grant that permission | `docs/relay-authentication.md` |
| Hide my IP address on calls makes this device relay-only | `app/index.html` (Privacy), `app/src/relay-only.ts` |
| The Archy Spry package runs the private-mesh profile (`fips0`), binds TURN 3478 on the host and TLS 5349 on loopback behind Archy's app gate | archipelago-apps `apps/spry/manifest.yml` |
| S9 is "Group TURN: node TURN issuer accepts group grants; rooms carry the issuer; web and Android stop using ForgeSworn ICE servers", acceptance "relay-only call between two devices through a local coturn with a granted credential; ungranted device refused; no request to a ForgeSworn host" | the group-hosted design's phase table (owner accepted 20 October 2026; a local handover, not in this repository); wildbloom-node `docs/GROUP-GRANTS.md` table of phases |

### Drift between code and documents

Found while reading. None is fixed by this design; stage N0 corrects them.

1. `src/ice-defaults.ts`: the module comment says the stand-in is Cloudflare's
   STUN server and "Google stays out under the 2026-10-19 rule". The constant
   below it is `['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']`.
   The comment on `DEFAULT_STUN_URLS` still says "Cloudflare's".
2. `deploy/README.md`, "The TURN server is a default, not a dependency": "That
   STUN is Cloudflare's public server ... because the publisher runs no default
  servers." Since 4aa6be8f the web app asks `/turn` by default. When minting
   fails, the STUN fallback includes Google and Cloudflare; when it succeeds,
   STUN is derived from the minted TURN URL (`app/src/ice-resolve.ts`). The
   list order is not a guarantee that the browser contacts servers in order.
3. `docs/decisions.md` keeps "Nothing goes to Google, 19 October 2026" and
   "Calls use somebody else's STUN server by default (23 October 2026)" with no
   later entry recording the 1 November reversal of either. The 2 November
   entry covers relays only. The legal pages were updated on 1 November
   (039c149e, b30d61eb); the decision record was not.
4. wildbloom-node `docs/GROUP-GRANTS.md` section 6.9 and the S9 row name the
   `wildbloomd` NIP-98 TURN issuer and coturn. The owner now wants Spry.
   Spry's `Authority::handle` has no kind 27541 or NIP-98 path.
5. `docs/private-call-relay.md` and archipelago-apps `apps/spry/README.md` send
   people to **Settings → Connections → Call relay (TURN)** and **Settings →
   Connections → Spry**. The web settings pages are titled **Calls**, **Relay
   server**, **Your Spry node**, **Public call relays** and **Call relay on
   this computer**; no settings page is titled Connections (`app/index.html`).

## 1. The node package

### 1.1 What it is and where it runs

One release artefact, `kithmoot-node`, that a keeper installs on a machine
that is not in their home: a rented Linux server, or an Archy node that is
itself hosted (Archy is optional; Spry is already independent of Archipelago,
spry-turn `docs/standalone.md`). The keeper is the person who starts rooms on
it and admits people. The node serves only rooms whose authority the keeper's
account has enrolled on it.

The installer cannot tell a home line from a data centre without asking an
outside service, which this design does not use. It asks the operator to
confirm, says why ("Anyone who uses this node sees its internet address. Don't
install it at home."), and refuses addresses that are plainly not a server's:
a default route through a private or carrier-grade NAT address with no public
address on any interface. [decision on whether a refusal or a warning]

### 1.2 Components

| Component | Software | Role | New work |
|---|---|---|---|
| Supervisor and grant desk | `kithmoot-node`, new, TypeScript, in this repository beside the keeper (`src/node/`), reusing `src/group-grants.ts` | Install, configuration, start and stop of the children, the admitted-device ledger, `POST /groups/v1/events`, owner pairing, close and purge, `doctor` checks | All of it (N4) |
| Call relay | Spry `spry-node`, standard profile, `SPRY_PUBLIC` off, `SPRY_ROOM_SEAL=required` | STUN, TURN over UDP, TCP and TLS, credentials of at most 5 minutes | Pre-trusted pairing in the standard profile, vouching off, ending a removed key's allocations, aggregate cap in the standard profile (N1) |
| Room relay | Shelter: bothy-node `bothyd` with `[events]` enabled, in a new room-relay profile | The room's only Nostr relay | Room door, ask door, local allowlist feed, per-room partitions, purge (N2) |
| TLS front | [decision]: the deploy kit's Caddy with `caddy-l4` SNI routing (as `deploy/turn-443.md`), or a small in-house SNI router in `kithmoot-node` | Certificates, HTTPS and WSS for Shelter, Spry's API and the desk, SNI routing of TURN over TLS on 443, access logs discarded | Configuration only with Caddy; new code otherwise |

Not in the node by default: a KithMoot keeper process (section 2.8), group file
storage (`wildbloomd` group mode, [decision], section 5.1) and a forwarder.

### 1.3 One admitted-device list

The desk keeps the list. Spry and Shelter never parse kind 27541 themselves:
the desk verifies each grant and pushes the result over node-local interfaces,
so neither service needs a public kind-27541 endpoint. Their local interfaces
and enforcement do change in N1 and N2.

```
keeper's app ──27541 grant/revocation/reset──▶ desk (POST /groups/v1/events)
                                                 │ verify (GROUP-GRANTS 4.4)
                                                 ├─▶ Spry: /v1/grants/devices add/remove, sealed
                                                 │        (loopback, as the node's own pairing)
                                                 └─▶ Shelter: allow/revoke key for room R, purge R
                                                          (Unix socket, node-local)
```

- **Grant contents.** One grant per admitted device per node: `d` room id,
  `device` the room device key, `server` the node's host name, scopes `turn`,
  `relay-read`, `relay-write`, `status`, `expiration` (default 30 days,
  renewed with 10 left, GROUP-GRANTS O3). No `bytes`, since no `upload` scope.
- **Enrolment.** GROUP-GRANTS 3.2 makes enrolment a local act on the node. A
  rented node is reached only by SSH, so for this profile enrolment is an
  owner-signed event over the desk: the installer prints a one-time pairing
  link, the keeper opens it in KithMoot, and the node records that account key
  as its owner. The owner's app then enrols each room's authority key, with an
  optional end date. This answers GROUP-GRANTS open question O9 for the node
  profile only. [decision]
- **Spry.** The desk is the node's only Spry pairing (`trust_pairing`, today
  supervised-only; N1 exposes it in the standard profile as
  `SPRY_PAIRING_KEY`). `trust_pairing` removes every other pairing, so the
  keeper cannot also pair **Your Spry node** to a KithMoot node's Spry. It
  creates one Spry grant per room, registers each
  granted `device` key, seals the grant, and removes keys on revocation.
  Devices sign Spry requests with their **room device key**, not the derived
  `spryKey`: the desk only knows the device key, and the node already sees it
  at NIP-42 sign-in, so nothing new is linked. [decision]
- **Shelter.** The desk tells Shelter which keys may read and write room R.
  Shelter checks the key at NIP-42 sign-in and on every operation, and closes
  a socket whose key is revoked, as its event grants already do.

The ledger is durable and records grant expiry, revocations, reset floors and
pending changes to both children. Duplicate events are idempotent. A grant is
acknowledged only once both children enforce it. Revocation takes precedence
over admission; a partial failure stays pending and never reports completion.
The desk reconciles its ledger with both children after a restart before
accepting new room access. Children refuse access if the desk's synchronised
state is unavailable. Expiry removes access without waiting for the keeper's
app, including a grant that expires while the node is stopped. N4 tests each
interrupted write and child failure, expiry and restart, and replay of an old
grant after revocation or reset.

The alternative already built in both clients is Spry's own sealed room
grants, with the keeper's app as the paired app registering roster `spryKey`s
(`app/src/spry-room.ts`, Android `SpryRoomRegistrar.kt`). It needs almost no
Spry work, but it is a second list beside Shelter's, kept in step by the
keeper's app, and members can vouch extra keys in for 24 hours. Recommendation:
the desk and kind 27541 for node rooms; the existing path stays for a person's
own paired Spry node. [decision]

### 1.4 Ports and transports

Plain Linux server with a DNS name (the recommended layout; an IP-only layout
follows):

| Port | Protocol | Service | Notes |
|---|---|---|---|
| 443 | TCP | TLS front | SNI `<node>`: `/events` to Shelter, `/v1/*` to Spry's API, `/groups/v1/*` to the desk. SNI `turn.<node>`: TURN over TLS to Spry's TCP listener |
| 80 | TCP | TLS front | ACME HTTP-01 only, everything else 404 |
| 3478 | UDP and TCP | Spry | STUN and TURN |
| 5349 | TCP | Spry | TURN over TLS, direct (`SPRY_TLS_PORT`, certificate under `/data/tls`) |
| 49160 to 49191 | UDP | Spry | Relay allocations (`SPRY_RELAY_PORTS`, 32 ports for 32 allocations) |

Loopback only: Spry HTTP 3744, Shelter's public listener, the desk.

TURN URLs handed to admitted devices: `turn:<node>:3478?transport=udp`,
`turn:<node>:3478?transport=tcp`, `turns:<node>:5349?transport=tcp`,
`turns:turn.<node>:443?transport=tcp`. The last needs the client rule change
in section 5 on both platforms, and four URLs exceed the three
`spryCredentials` accepts today (`value.urls.length > 3`). STUN in the link: `stun:<node>:3478` only.

Without a DNS name, an IP certificate is possible (Let's Encrypt's
`shortlived` profile, as `deploy/turn-443.md` records), but a TLS connection
to an IP address usually carries no SNI, so only one service can own 443:
Shelter's WSS. TURN over TLS then stays on 5349. Spry's `https:` offer refuses
IP addresses (`spryEndpoint`), so an IP-only node uses `spry:` control through
Shelter as its control relay, whose TURN URLs are `turn:` only. Whether
KithMoot accepts `wss://<IPv4>` as a room relay is [unverified]. The DNS
layout is recommended; the hostname appears permanently in certificate
transparency logs, which publishes that a node exists at that name but not
whose it is.

Spry serves one address family per instance (spry-turn `docs/operations.md`),
so v1 relays IPv4 only.

On Archy, the app gate owns 443 and certificates; the Spry package already
binds TLS 5349 on loopback behind it. Whether the gate can route TURN over TLS
on 443 by SNI is [unverified], as is the reported collision on host port 3478
between Spry and Archy's own networking service.

### 1.5 Logs off

- Spry writes no access or payload log. The node runs it with readiness and
  error lines only.
- Shelter: event content, keys and addresses are not logged by the room-relay
  profile; N2 confirms what `bothyd` writes at each level [unverified].
- The TLS front discards access logs (`log { output discard }` in the Caddy
  layout).
- The desk logs start, stop, counts and errors, never keys, room ids,
  addresses or grant bodies.
- systemd units use their own journal namespace with volatile storage and a
  short retention, on the pattern of `deploy/journald-kithmoot.conf` but scoped
  to the node's units. Core dumps off for the node's users.
- No metrics, telemetry or update ping to anybody. Updates are fetched only
  when the operator runs `kithmoot-node update`.
- Outside the software's reach, and said so in the installer: the provider's
  network logs, hypervisor snapshots and backups. The installer asks the
  operator to switch provider backups and snapshots off for the node.

### 1.6 Resource limits

| Setting | Node default | Source |
|---|---|---|
| Spry allocations | 32 | standard profile maximum |
| Allocations per credential | 8 | standard profile maximum; a five-person mesh holds four peer connections per device, and if libwebrtc allocates once per TURN URL per connection, four URLs could need 16 [unverified; measured in N7] |
| TCP and TLS connections | 32 | standard profile maximum |
| Bytes per second per allocation | 1000000 | standard profile default |
| Aggregate bytes per second | Operator's choice, asked at install, no assumed figure | new in the standard profile (N1) |
| Shelter store | `max_bytes` and `min_free_bytes` asked at install, no assumed figure | Shelter `[events]` |
| Shelter connections | 32 shared, at most 24 for the ask door | Shelter's existing split, reused |
| Rooms per node | Operator's choice | desk |
| Devices per participant | 5 | GROUP-GRANTS O5 |

Shelter's 32 connection slots are its current bound. A room of 15 people on two
devices each needs 30 [unverified whether the bound can rise without the
store work in the performance plan].

### 1.7 Install

**Plain Linux** (Debian or Ubuntu with systemd first; others later):

1. Download the release tarball and its signature; verify both (the same
   provenance pattern as spry-turn's Linux artefact, `docs/standalone.md`).
2. `sudo ./kithmoot-node install --name relay.example.net` (one command). It
   creates a system user, writes `/etc/kithmoot-node`, generates the TURN
   secret and the desk key, installs units, configures the firewall rules in
   1.4 after showing them, obtains certificates, runs `doctor`, and prints a
   one-time owner pairing link and QR code that expires in six minutes.
3. The keeper opens the link in KithMoot and approves. The node now hosts
   rooms that account starts on it.

`kithmoot-node doctor` checks from the machine itself and says plainly which
checks need a second network (TURN reachability from outside uses the
existing `checkCallRelay` from the keeper's app, `app/src/call-relay-check.ts`).
`kithmoot-node uninstall --delete-everything` requires every hosted room to
have completed its keeper-signed close first. The server has no keeper keys
and cannot authorise device self-destruct by itself. It then removes its
units, data, managed firewall rules and certificate copies. An ACME install
also removes its own certificate lineage and renewal hook. Existing operator
certificates and unrelated firewall rules are preserved.

**Archy**: an app package in archipelago-apps beside Spry, "KithMoot node",
bundling the same three processes. Archy supplies installation, the app gate's
HTTPS and certificates, and its firewall plan. The package uses Spry's
standard profile, not the private-mesh profile the existing Spry package uses.
Installing it next to the Spry package needs separate ports and state, as
spry-turn `docs/public-mode.md` "Separate standard profiles on one host"
describes. Archy UI is covered in section 8.

**What the installer refuses**: Spry public mode, Shelter's anonymous public
partition, any listener on a non-loopback address other than those in 1.4,
running as root after setup, and a second enrolment of a room authority that
another owner already holds on this node.

## 2. S9: group TURN and relay grants

### 2.1 What changes from S9 as planned

S9 planned the `wildbloomd` NIP-98 TURN issuer and coturn. Here the issuer is
the desk feeding Spry, and S8's group relay is Shelter. The grant contract,
the keeper's ledger and the delivery in the room are unchanged; only the
services behind the scopes move. wildbloom-node `docs/GROUP-GRANTS.md` section
6.9 is updated in N3 to say so.

### 2.2 How a room names its node

| Carrier | What it says | Who reads it |
|---|---|---|
| Link fragment | Version 6: `{v:6,node:event}`. The signed record derives the sole relay, own STUN and four TURN URLs; no room key or access token | Anyone holding the link |
| Signed node record (27542) | Room, authority, HTTPS origin, service key, node profile, relay-only calls, files off and optional room end, as specified by Fold 0.16.1 | Members and link holders |
| Control-channel op `node` | `{op:"node",event}` repeats that signed record inside the encrypted channel. Receivers verify room and authority. This first profile pins one record; an announcement does not authorise automatic migration | Members |
| Descriptor (20465) | No alternate Spry offers or peer relays in node rooms. Each admitted device obtains its own node offer through authenticated access and mints short-lived credentials there | Members |
| Grants (27541) | The device's own access, one per device | That device and the node |

A link holder learns the node's address, which they need to ask. They learn no
credential: Spry offers ride only in the encrypted descriptor, the grant is
sealed, and Shelter serves nothing to an unadmitted key except answers
addressed to it.

### 2.3 What the guest types

Nothing. They open the link, give a name if they want one, and press **Ask to
join**. Their app does the rest.

### 2.4 Asking to join: the ask door

If Shelter is the only relay and admits only granted keys, a link holder
cannot deliver their request. The room-relay profile therefore has a second
door on the same `wss://` URL, modelled on the posture of the project's own
relay since 2 November (only sealed messages addressed to listed keys from
strangers; `docs/legal/README.md`):

- Writes: only the admission request kinds of the node-room link version,
  addressed (`p`) to an inviter key the desk has registered for a hosted room.
  The exact kinds are fixed in N2 from fold-kit [unverified which existing
  kinds fit; the v2 request and grant pair 20466 and 20467 is the candidate].
- Reads: only events addressed to the key the connection signed in with by
  NIP-42, so an asker can read the answer and nothing else.
- Storage: the ask partition of room R, each event with an `expiration` of at
  most ten minutes, purged with the room.
- Never served on this door: kind 1463, chat, rosters, rekeys, descriptors.
- Limits: the ask door's share of connection slots (1.6) and a per-address
  rate limit held in memory only.

Node rooms therefore need **a new link version** in which the bearer can ask
and nothing more: no bearer-readable 1463 on the node, the answer carries the
room key sealed to the asking device, and once admitted the member keeps the
room as a group member does. A new version follows the 24 October precedent
(`docs/decisions.md`): an app that does not know it says it needs a newer
version instead of joining and getting stuck. [decision]

The alternative, one public relay kept for asks alone, breaks "Shelter is the
only relay" and puts the asks' metadata with a third party. Not recommended.
[decision]

### 2.5 Admission to access

1. The asker's app signs in to the ask door with its fresh room device key and
   sends the request to the inviter.
2. The keeper's app shows the existing admission card. The keeper chooses
   **Let them in**.
3. The keeper's app signs one kind 27541 grant for the device at this node and
   posts it to the desk. The desk verifies it, registers the key with both
   Spry and Shelter, and answers `200` only after both acknowledge it.
4. The keeper's app sends the room key and grant together in the sealed
   admission answer, readable on the ask door by the asking device. This
   extends the answer format in N3 and K6/A6. It also sends the grant in the
   room's control channel for later recovery. A retry uses the same grant id;
   an interrupted answer can be delivered again without a second admission.
5. The asker's app verifies the answer and grant against the authority in its
   link, then signs in to Shelter's room door with the same device key. It
   needs no room-channel read to obtain its first grant. When a call needs a
   relay, it fetches credentials from Spry with the same key.

Only the room's authority signs grants (GROUP-GRANTS 3.4). In node rooms only
the authority's devices answer asks, so "the keeper admits" holds literally.
Delegated members answering asks would leave a newcomer holding the key with
no grant until the authority's app is next open. [decision]

### 2.6 Renewal and offline keepers

Grants last 30 days and are renewed with 10 left by the keeper's app when it
is open (the keeper process does this today for storage grants). A member
whose grant lapses because the keeper's app was not open during its last ten
days loses access until it is renewed; the app says "Your access to this group's
node has run out. It comes back when <keeper> next opens KithMoot." A lapse is
the safe failure.

### 2.7 Removal

1. The keeper removes the person (existing flow: rekey without them).
2. The keeper's app signs a revocation for each of their devices' grants and
   posts it to the desk and in the room.
3. The desk removes the keys from Spry and Shelter. Shelter closes their
   sockets at once.
4. Spry refuses new credentials, ends existing allocations, and rejects the
   reuse of every still-valid credential issued for the removed key in this
   room. N1 must bind issued usernames to the room grant and device and check
   revocation on Allocate and Refresh, including over UDP, TCP and TLS. It
   must not revoke the same device's grants in other rooms. Ending existing
   allocations alone cannot provide immediate removal: an unexpired login
   could create another one. N1's acceptance bound is one second after Spry
   acknowledges revocation. The desk reports completion only after both
   children acknowledge; failures remain visible and retryable. Five-minute
   expiry is a backstop, not the removal mechanism. Current allocation expiry
   for room-grant credentials in the standard profile remains [unverified].
5. The removal notice asks the removed device to run the self-destruct
   tidy-up for that room (3.6). [decision on whether this is the default]

What a removed device keeps: everything it already read or downloaded. A
removed person can ask again with the link; only the keeper can let them back.

### 2.8 Who holds the authority

The node holds no room key and no authority key. The keeper's own devices
hold the authority, as for any browser or Android room. Reasons: a rented
server's provider can read its disk; a node that held room keys would be a
complete copy of every hosted room. Cost: nobody can be admitted while the
keeper's devices are all off, and grants are renewed only when the keeper's
app runs. A keeper process on the node (`kithmoot-agent create`) remains
possible for a keeper who accepts that trade, as an advanced option.
[decision]

## 3. Ending a chat

### 3.1 Room shape

A node room is a group in which every admission is asked for (2.4). It may
have an end date (`ends`, at most 30 days, as conference rooms) or none, and
it self-destructs by default (`destruct`). **End chat now** is in Room details
for the authority. [decision on the defaults]

### 3.2 Close flow

In this order, with a durable operation on the desk:

1. **End chat?** dialog with the promise (3.7). Cancel is the default.
2. The app signs the closing rekey (1462, `closed: true`, `destruct`),
   retirement (1461, `ended: true`) and kind 27541 reset. It sends these with
   an explicit authority-signed kind 27543 closure statement and unique
   operation id to the desk. The canonical statement binds the room, node
   host and operation, and expires after 30 days. A grant reset alone is not
   permission to delete a device's room data.
   The desk verifies them and durably records the operation and deadline
   before acknowledging acceptance. N3 defines the close envelope and vectors.
   No room key or signing key is sent to the node.
3. The desk blocks new admissions, publishes the already-signed closing
   events on Shelter, and records both `OK` replies. The short delivery window
   is at most two minutes [decision]. The node completes the operation even
   if the keeper's app closes. The deadline limits the delivery wait; it does
   not permit a false success receipt when a child is unavailable.
4. At the deadline the desk applies the signed reset, removes the room's Spry
   grant, rejects all of its cached credentials and ends its allocations
   (N1), then closes and purges Shelter's room partition. It removes the room's
   enrolment only after both children confirm completion.
5. The desk returns a signed completion receipt: operation id, counts deleted,
   time and result for each child. Duplicate close requests return the same
   operation. Pending operations resume after restart; each step is idempotent.
   An unavailable child leaves a visible pending result, never "Ended". N4
   tests a crash before and after every step and retry after a lost receipt.
6. The app shows "Ended. Your node deleted everything from this chat and ended
   2 calls." Shelter counts events, not messages, so the receipt's count is
   shown only in details, as events.
7. Each device runs the self-destruct tidy-up (3.6).

A device offline at the close learns it when it next connects: Shelter refuses
its sign-in with a distinct reason, "room closed", for the tombstone period
below. The app retrieves and verifies the keeper's signed closure statement
before running the tidy-up. A server refusal alone is not authority to wipe.
A refusal for a revoked grant says "access removed" instead; the existing
keeper-signed removal/rekey flow supplies the device deletion authority.

### 3.3 Purge semantics on Shelter

Room events are not enumerable by room id: their `d` tags are derived from
streams, bells, rosters and epochs, and several are signed by throwaway keys.
The room-relay profile therefore records, at intake, which room partition an
event arrived under (the room of the granted connection that wrote it). Purge
of room R:

- deletes every event, replacement head, deletion barrier and ask in R's
  partition, and R's allowlist;
- runs with SQLite secure deletion on, then checkpoints and truncates the WAL;
- leaves other rooms untouched (tested);
- keeps one tombstone row: a salted hash of the room id and the close time,
  for 30 days [decision], so late devices are told the room closed. No
  content, keys or addresses.

The desk retains an opaque anti-replay marker for the longest possible grant
lifetime plus clock skew. For 30 days it also retains the closure statement's
signature, event hash, creation/expiry times and random operation id. A device
reconstructs the statement using its pinned room authority, room id and node
host. No raw room id, member key or closing ciphertext remains in that proof.
The completion receipt is signed by the node service key as kind 27544 and
contains the operation id, child results and counts, without room identifiers.

Deletion of the database rows and overwriting of freed pages is what the
software does. It does not reach SSD wear levelling, filesystem snapshots,
hypervisor snapshots or provider backups, which is why the installer asks for
provider backups and snapshots to be off (1.5).

### 3.4 Credential rotation

Spry has one TURN secret and no rolling dual secret; changing it invalidates
every credential and a restart drops every allocation (spry-turn
`docs/operations.md`). So:

- Closing one room removes its Spry grant and ends its allocations; the
  secret stays, because other rooms' calls use it.
- Closing the last open room and **Close every room** rotate the secret and
  restart Spry. Uninstall stops Spry and deletes its secret with the state.
- The desk key is rotated only at uninstall.

### 3.5 NIP-40 backstop

Every event a member device signs for a node room carries `expiration`: the
room's `ends`, or for a room with no end a rolling horizon of 30 days from
`created_at` [decision]. Shelter's room door refuses room events without an
`expiration` or with one beyond the room's end or horizon, so a client that
forgets cannot leave unbounded rows. Expired events vanish from queries at
once and are swept each minute (Shelter's existing sweep). This is the
backstop if a purge fails or never runs, for instance after the keeper loses
every device.

### 3.6 Device-side deletion

The existing tidy-up (`docs/persistent-groups.md`, "Self-destructing rooms"):
NIP-09 deletes of the device's own events (they fail harmlessly once Shelter
has purged), files deleted from wherever they went, bookmark tombstoned, every
local key and archive stream naming the room wiped, a tombstone row naming no
room. Removal (2.7) and close (3.2) both trigger it in node rooms. Only an
unmodified current KithMoot does this; the app does not claim otherwise.

### 3.7 The promise

Proposed wording, for owner review. "Our servers" in app copy would suggest
ForgeSworn runs them; the node is the keeper's, so the copy says "this
group's node" or "your node". [decision]

> **End this chat?**
>
> Calls and messages stop for everyone. Your node deletes everything from
> this chat, and the KithMoot app on each device deletes its copy.
>
> We can't take back what people already saved: screenshots, copies, or an
> app that has been changed. Internet providers and VPNs keep their own
> records of connections, and so may your hosting provider.
>
> **End chat** · Cancel

One-line form for room info and the website: "When a chat ends, nothing is
left on the group's node, and the app deletes its copy."

## 4. Metadata map

"Before" is a room on today's defaults (2 November: web and desktop ask `/turn`,
derive STUN from its TURN URL on success and fall back to Google and Cloudflare
when it fails; web uses three third-party relays; Android
leads with relay.trotters.cc; host candidates are sent). "After" is a node
room.

| Party | Before | After |
|---|---|---|
| Node operator (the keeper's machine) | No node | Every member device's IP address when it connects to Shelter, and to Spry when relayed; room device keys and their grants; the room id (on grants and rekeys); event kinds, sizes and timing; call timing and volume. Not content, names or participant keys |
| Hosting provider | No node | Who pays; the node's address; traffic volume and timing per remote address; disk images (ciphertext events, grants, the TURN secret) if it takes snapshots |
| ForgeSworn | `/turn` sees each caller's IP and origin when it mints; its coturn carries relayed calls; its web host sees app loads; relay.trotters.cc refuses strangers' room traffic | Nothing from the room's chat or calls. Its web host still sees loads of the web app from `kithmoot.forgesworn.dev`, and its update feed sees desktop update checks |
| Google and Cloudflare STUN | IP address and timing when the client uses the public STUN fallback, not every successful `/turn` resolution | Nothing for node rooms |
| Public Nostr relays | Room traffic metadata: device keys, kinds, sizes, timing, IP addresses | Nothing for room traffic. Account-level traffic (profile lookups, NIP-46 signer relays, account sync) is unchanged |
| Other participants, direct path | Each other's public address and, with host candidates on, LAN addresses | The same, unless relay-only |
| Other participants, relay-only | The relay's address | The node's address only |
| ISP or VPN | Connections to Google, Cloudflare, ForgeSworn and public relay hosts, and to peers on direct paths; timing and volume | Connections to the node (its name in DNS and TLS SNI) and to peers on direct paths; timing and volume. Cannot be wiped |
| Certificate transparency logs | ForgeSworn's names | The node's names, permanently |

Direct paths still show participants' addresses to each other. Options:

1. **Per device**: Hide my IP address on calls, as today (relay-only for that
   device).
2. **Per room**: a node-room setting **Calls go through the node**, set by the
   keeper, that makes every member relay-only through the node and hides host
   candidates. Members then see only the node's address. Cost: every call's
   media crosses the node, a five-person mesh multiplies it, and the node's
   aggregate cap becomes the call quality limit.
3. **Host candidates only**: hide LAN addresses in node rooms
   (`HIDE_HOST_CANDIDATES` behaviour per room), keep direct public paths.

Recommendation: option 2 on by default for node rooms, since keeping home
addresses out is the point of the node, with option 3 when the keeper turns it
off. [decision]

Quiet rooms lose their cover crowd on a node: their kind 1059 drops would sit
among the group's own traffic, not a large public stream. The node sees no
more than it would of an ordinary node room, but the app should not claim the
quiet room's cover there.

## 5. Client changes

### 5.1 Web and desktop (kithmoot)

| # | Change |
|---|---|
| K1 | Node rooms: read and verify the invitation's `node` key and the `node` op; the new link version (2.4); creation form choice **Host on my node** when the account has a paired node |
| K2 | Room-door sign-in: automatic NIP-42 with the room device key, only to the relay the room's signed `node` record names. Recorded as a decision beside `docs/relay-authentication.md`, which today allows only an account identity with explicit consent; the device key names nobody outside the room and the node already sees it on every event |
| K3 | Authority-side grants in the browser: sign kind 27541 with `turn`, `relay-read`, `relay-write` on admit, renew, revoke on removal, `reset` on close; post to the desk and in the control channel. The keeper's TypeScript code is the base |
| K4 | ICE in node rooms: only the node's STUN and the Spry offer's TURN; never `/turn`, never `DEFAULT_STUN_URLS`; `spryCredentials` accepts `turns:turn.<host>:443?transport=tcp` and `turns:<host>:443?transport=tcp` for an offer from the room's own node, alongside 3478 and 5349, and accepts up to four URLs instead of three; Spry requests signed with the room device key in node rooms |
| K5 | Relay-only per room (section 4, option 2) and host-candidate hiding per room |
| K6 | Ask door client: the waiting screen "Waiting for <name> to let you in", timeouts, and a refusal that says nothing (a declined request is never answered, `docs/protocol.md`) |
| K7 | Close and removal: End chat dialog, receipt line, "room closed" and "access removed" refusals mapped to the tidy-up |
| K8 | Your KithMoot node settings page: pair with the installer's link, status (reachable, version, rooms hosted, store use), unpair |
| K9 | No silent fallback: a node room never uses public relays, public STUN or a public file server, and says so when the node is unreachable |

**Files [decision].** Recommendation for the first node release: file sending
is unavailable in node rooms, with an explanation in the composer. Do not
silently use a public file host. Group storage adds `wildbloomd` and its grant,
quota and deletion checks as a separate stage. Direct sending is also a
separate option: its transport and candidates must preserve the room's IP
privacy setting. No file transport is accepted merely because calls are
relay-only. Existing rooms without a node retain their file behaviour.

### 5.2 Android (kithmoot-android)

The same changes, A1 to A9, against `GroupGrants.kt`, `SpryRoomAccess.kt`,
`CallIceSelector.kt` (node relay ranked first in node rooms, `DefaultTurn`
never used there), `LocalAddressPrivacy`, `CallsPage.kt` and the room screens.
Parity is held by shared vectors, merged by hand into Android's vendored copy
as today:

- node record and `node` op (signature, version, canonical form);
- kind 27541 with `turn` and `relay-*` scopes, revocation, reset (extend
  `vectors/group-grants-v1.json`);
- TURN URL rule including port 443 for node offers;
- the new link version and the ask door's kinds;
- close receipt and refusal reasons.

### 5.3 Rooms without a node

Unchanged defaults, whatever the owner decides for them (5.5). When a call's
route ladder runs out, the call screen says why instead of sitting silent:

> This call couldn't connect. Some networks need a call relay, and this room
> doesn't have one. Whoever started the room can host it on a KithMoot node.

In a node room whose node is unreachable:

> Can't reach this group's node (relay.example.net). Messages and calls wait
> until it's back.

### 5.4 The built-in call relay

Stays as designed, off by default, under **Call relay on this computer** (and
**Call relay on this phone**). Its Turn on text gains the warning in plain
words: "People who use it see your home internet address." The settings page
points keepers who want relays for guests to a KithMoot node instead.

### 5.5 ForgeSworn's public `/turn`

Since 1 November the apps ask ForgeSworn's `/turn` by default and its coturn
relays their calls (`docs/legal/README.md`). The owner's goal of 22 October is
that ForgeSworn is a publisher only and runs nothing strangers can reach. Node
rooms never call `/turn`, whatever its state. Switching `/turn` off for rooms
without a node is the owner's decision and is not taken here. If taken, the
prerequisites are: client releases that no longer default to it, Android
releases that no longer pin its host (0.6.132 does), and the rollback order in
`deploy/turn-443.md`. [decision]

## 6. Legal position notes

Readings from jurisdiction-kit `law/gb/online-services.md` (verified 28
September 2026, sections as numbered there). Not legal advice; no lawyer has
read this.

- **ForgeSworn publishes software.** It runs no node, issues no credentials,
  keeps no directory and ships no default node (2.2 middle reading `[U]`,
  2.13 on discovery, 6.1). Never: run a node for others, curate or rank nodes,
  hold operator secrets, collect telemetry, manage installs remotely, or take
  payment for transport.
- **The keeper runs a closed service.** Whoever controls who can use a service
  is its provider (s.226 `[P]`, 2.2). Family and friends by invitation is
  unsettled `[U]`; a closed group working on a project can be an internal
  business service (Schedule 1 paragraph 7) `[P]`; anybody who finds it is a
  public service `[P]` (2.10). That is why a bearer link grants nothing and the
  node serves only admitted devices.
- **The ask door** takes strangers' messages addressed only to the keeper, the
  narrow inbox case of 2.12, and serves nothing else.
- **TURN** as transport infrastructure is unsettled `[U]` (2.11).
- **Data protection**: a keeper running it purely for household and friends
  may be outside UK GDPR (3.9) `[U]`; otherwise a controller for addresses and
  keys (3.1) with the fee question (3.4).
- **Investigatory powers**: a relay operator is very probably a
  telecommunications operator `[U]` (5.1); capability notices cannot be
  imposed below 10,000 people served `[P]` (5.3).
- The installer and the node's status page carry the deploy kit's "Whoever
  deploys it runs it" text (`deploy/README.md`) pointing to the law note.
- Before release, refresh `docs/legal/call-transport-position.md`,
  `docs/legal/README.md` and `docs/legal/closure-record.md`, and run the
  legal-cover gate on the change.

## 7. Stages, risks and decisions

### 7.1 Stages

Stages can merge independently once their checks pass and prerequisite owner
decisions are recorded, while incomplete node features stay unavailable. A
public node release requires N0 to N7 and N9, published signed dependencies,
and the applicable UI approvals. The Archy package also requires N8. Existing
client release gates continue to apply.

| # | Repository | What | Acceptance |
|---|---|---|---|
| N0 | kithmoot | Record this design's decisions; correct the drift list (ice-defaults comment, deploy README STUN paragraph, decision record for 1 November, settings paths) | Each corrected statement matches the code it describes |
| N1 | spry-turn | Standard profile: `SPRY_PAIRING_KEY` (pre-trusted pairing), vouching off switch, ending a removed key's or grant's allocations and refusing its cached credentials, aggregate cap, counts-only status | Rust integration tests across UDP, TCP and TLS: unregistered key refused; vouch refused when off; removed key's allocations end and cached login cannot Allocate or Refresh within one second of revocation acknowledgement; other rooms remain usable; expiry and restart cannot restore access; aggregate cap enforced; status has no addresses |
| N2 | bothy-node | Shelter room-relay profile: public `wss://` room door with NIP-42 on every connection, connection-gated room partitions, local allowlist socket, ask door, `expiration` enforcement, purge of one room, tombstone, no anonymous reads | Tests with KithMoot kinds signed by device, throwaway and one-time keys; ungranted key refused; revoked key's socket closed; ask door accepts only addressed asks and serves only answers to the asker; purge leaves no rows for room R and every row of room S; bearer-only holder reads nothing |
| N3 | wildbloom-node and fold-kit | GROUP-GRANTS: section 6.9 moved to the desk, Spry and Shelter; O9 answered for the node profile; vectors for `turn`, `relay-*`, admission answer and signed close envelope; shared circle wire changes land in fold-kit before client pins move | Vectors pass on web and Android; tampered, replayed and cross-room envelopes refused |
| N4 | kithmoot | `kithmoot-node`: supervisor, durable desk ledger, installer, `doctor`, uninstall, owner pairing, enrolment, recoverable close operations | A cold reader installs on a fresh Debian or Ubuntu server from one page; `doctor` passes; another network reaches 3478 UDP and TCP, 5349 and 443; grant expiry and replay, child outages, interrupted writes, close crash/restart at each step and lost-receipt retries pass; no partial operation reports completion |
| N5 | kithmoot | K1 to K9 | Playwright e2e against a local node (Spry and Shelter on loopback): ask, admit, chat, relay-only call over UDP and TLS, removal, close |
| N6 | kithmoot-android | A1 to A9 | JVM vector tests; instrumented join and call against the local node; physical phone on mobile data against a real node |
| N7 | kithmoot | Cross-client and network proof | Web and Android in one node room, relay-only call five minutes both ways over TLS 443; room-transport capture shows no ForgeSworn, Google, Cloudflare or public relay traffic, with app loads, updates and account traffic separately attributed as in section 4; removed device's existing allocations and reuse of cached credentials fail within the N1 bound and Shelter access ends; allocations per peer connection measured with four TURN URLs and cap set from the result; close leaves zero room-event rows, with only the documented tombstone retained |
| N8 | archipelago-apps | KithMoot node package for Archy | Install, pair, call and close on a hosted Archy node; ZAT review pack (section 8) |
| N9 | kithmoot | Legal and site pages refreshed from the shipped behaviour | Legal-cover gate run; pages name what the node and its provider see |

Order: N0 and N3 any time; N1 and N2 in parallel; N4 after both; N5 and N6
after N4; N7 after N5 and N6; N8 after N4 and N7; N9 last, before any release.

### 7.2 Risks

- **Spry is unqualified for public deployment** and as a coturn replacement
  (spry-turn `docs/operations.md`). N7's network proof is the first real
  qualification; the owner's own rooms should run on a node before anyone
  else's.
- **Shelter is new as a room relay.** Its room door, ask door and purge are new
  code in a store tuned for a household, with 32 connection slots and an open
  performance plan.
- **bothy-node is private.** A public one-command install needs a published,
  signed Shelter artefact and a licence statement. bothy-node is MIT; whether
  to publish its binaries or source for the node, and whether any change needs
  the Bothy design repository's co-maintainers, is open. [decision]
- **The node is a single point.** No public fallback by design: a node down is
  the room down.
- **Old clients cannot join node rooms.** The new link version makes them say
  so, rather than fail silently.
- **Bandwidth is the keeper's.** Relay-only by default multiplies traffic.
- **Hosting is not anonymous**, and the node's name is published in
  certificate transparency logs.
- **Archy port and gate integration** (443 SNI, host port 3478) is
  [unverified].
- **IPv4 only** in v1.

### 7.3 Owner decisions needed

1. **[decision]** Installer: refuse or only warn when the machine looks like a
   home line (1.1).
2. **[decision]** TLS front: the deploy kit's Caddy with `caddy-l4`, or an
   in-house SNI router (1.2).
3. **[decision]** One list: the desk with kind 27541 for node rooms
   (recommended), or Spry's existing sealed room grants beside separate
   Shelter grants (1.3).
4. **[decision]** Owner-signed remote enrolment of room authorities for the
   node profile (GROUP-GRANTS O9) (1.3).
5. **[decision]** Devices sign Spry requests with the room device key in node
   rooms, or the grant profile gains a Spry key tag (1.3).
6. **[decision]** A new link version for node rooms in which the bearer can
   only ask (2.4).
7. **[decision]** Ask door on Shelter (recommended), or one public relay kept
   for asks (2.4).
8. **[decision]** Only the authority's devices answer asks in node rooms, or
   delegated members too with grants following later (2.5).
9. **[decision]** Whether removal asks the removed device to delete its copy
   by default (2.7).
10. **[decision]** No keeper process on the node by default; keeper on the node
    as an advanced option (2.8).
11. **[decision]** Node room defaults: self-destruct on, end date optional
    (3.1).
12. **[decision]** The close window before purge (3.2) and the tombstone
    retention (3.3).
13. **[decision]** The NIP-40 horizon for node rooms with no end (3.5).
14. **[decision]** The promise wording, and "your node" or "this group's node"
    in place of "our servers" (3.7).
15. **[decision]** Calls go through the node by default in node rooms (4).
16. **[decision]** Files in node rooms: add `wildbloomd` group mode to the
    node, send files directly only, or turn files off in node rooms (5.1).
17. **[decision]** Whether ForgeSworn's public `/turn` is switched off for rooms
    without a node, and when (5.5).
18. **[decision]** Publication of the Shelter artefact and source (7.2).
19. **Standing gate, not an optional exemption.** ZAT covers the Archy screens
    in 8.1 and the KithMoot integration surfaces named in 8.2. Other standalone
    KithMoot screens receive owner review. Any proposed wider scope remains an
    owner decision; the older built-in-relay exemption does not waive the
    standing rule for Archy integrations.

## 8. UI and review

No screen is designed here; the copy above is draft. The build stages that
touch these screens use the owner's UI review, and the Archy screens use the
Archipelago maintainer's acceptance gate, following the Archy design baseline
(dark glass, existing components such as `BaseModal.vue`, `ToggleSwitch.vue`,
`EmptyState.vue` and `CopyButton.vue`, 44 px targets, every loading, offline,
denied, retry and completion state in words as well as colour). Spry's own
product UI is unchanged; only its Archy entry and integration surfaces follow
the Archy contract.

### 8.1 Archy screens

1. App catalogue entry and install sheet for **KithMoot node**.
2. KithMoot node launch page: running, reachable from outside, rooms hosted,
   store used, the "Whoever deploys it runs it" notice, Stop.
3. **Pair with KithMoot** hand-off for the node (pairing link and QR code), and
   how it sits beside the Spry package's own Pair with KithMoot screen when
   both are installed.
4. **Delete everything on this node** confirmation and its completion state.
5. Any Archy notification or status tile the package adds.

### 8.2 KithMoot screens

Web and desktop: Settings → Calls → **Your KithMoot node** (new); Settings →
Calls → **Relay server**, **Your Spry node**, **Public call relays**, **Call
relay on this computer** (warning text); Settings → **Relays** (the node's
relay shown as the room's own); Settings → **Privacy** (Hide my IP beside the
room setting); the Start a room form (**Host on my node**); Room details
(**Hosted on**, **Calls go through the node**, **End chat now**); the join
door (**Waiting for <name> to let you in**); the keeper's admission card; the
Remove dialog; the End chat dialog and receipt; the call failure notices
(5.3); the self-destruct tombstone row.

Android: Settings → **Calls** (`CallsPage.kt`) node section; Start room; Room
details; the join door; the admission card; Remove and End chat dialogs; call
failure notices.

The KithMoot screens that pair with or show an Archy-hosted node (**Your
KithMoot node**, **Hosted on**) are integration surfaces and go in the review
pack with the Archy screens. The rest go to the owner's review in any case.

### 8.3 Review pack

For each named screen: the exact revision and build or URL, the setup (a
hosted Archy node or a plain server with the node installed, a paired
account, a second device), the steps (install, pair, start a node room, ask,
admit, call, remove, end), the expected result at each step, and captures at
320, 390, 768 and 1440 px, phone landscape and enlarged text, with the closest
existing reference screen (the Spry package's Archy page) beside each Archy
capture. The pack is prepared for the owner to pass on; nobody messages the
maintainer without the owner's go.

Maintainer must review and approve UI work on the KithMoot node catalogue
entry and install sheet, the KithMoot node launch page, its Pair with KithMoot
hand-off, the Delete everything on this node confirmation, any KithMoot node
notification or status tile, and the KithMoot screens Settings → Calls → Your
KithMoot node and Room details → Hosted on, before merging or approval. ZAT
pending.
