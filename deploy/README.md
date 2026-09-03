# Deploying KithMoot

This directory is a deploy *kit*, not a deploy. Nothing in it runs on its
own - you run `deploy/deploy.sh` yourself, by hand, when you mean to.

Six independent things live here:

1. **The static PWA** (`Caddyfile.kithmoot`, `deploy.sh`) - serving the app
   from a real domain so people other than you can open it.
2. **A default TURN server** (`coturn/`) - so calls survive the ~20% of
   real-world networks where STUN alone can't connect two peers directly.
3. **A TURN credential service** (`turn-credentials.service`, in the repo
   root's `server/`) - the only thing that lets a browser actually use #2;
   see "Minting TURN credentials for the browser" below.
4. **A forwarder** (`forwarder@.service`, `forwarder-deploy.sh`,
   `forwarder-install.sh`, `server/forwarder.mjs`) - so a room can grow past
   the ~8-person ceiling a mesh imposes. See "Running a forwarder" below.
   It is not a TURN server and not an SFU in the usual sense: it is given
   the room *id* and never the room *key*, so it relays ciphertext it
   cannot read. One instance per room.
5. **A keeper** (`keeper@.service`, `keeper-deploy.sh`, `keeper-install.sh`)
   - one process per standing room, holding it open for as long as it runs;
   a box keeps as many rooms as it has instances. See "Running a keeper"
   below. Unlike the forwarder it *does* hold the room key, because it made
   the room: it is the room's availability and its admission desk, and the
   box is trusted with that room exactly as a browser that created one
   would be.

6. **A Blossom server** (`blossom.service`, `blossom.yml`,
   `blossom-deploy.sh`, `blossom-install.sh`) - where a file dropped into a
   room's chat goes, sealed in the browser first. See "Running a Blossom
   server" below. The box learns an encrypted blob and the device key that
   signed the upload, and nothing else; uploads are open to any key, with a
   cap, a quota and an expiry standing in for the allowlist there is nobody
   to put on.

Read the design principle below before touching the TURN half. It's the
part that's easy to get backwards.

## The TURN server is a default, not a dependency

KithMoot's whole point is that no operator is protocol-mandated - a room is
a secret, and anyone holding the link can join, with no server in the
picture except whichever relays the room happens to name. That has to stay
true of ICE servers too. A room's join URL already carries its own STUN/TURN
list (field `i` in `app/src/main.ts`), editable in the room-creation UI
before the "Start a room" button is ever clicked.

Standing up the coturn config in this directory gives KithMoot rooms a
*sensible default* when nobody's bothered to pick their own - nothing more.
Anyone can self-host coturn from this same config, point their own room at
it, or point at somebody else's public TURN server entirely. If you fork
this project and don't want to run TURN at all, set
`TURN_CREDENTIAL_ENDPOINT` back to `undefined` in `app/src/main.ts` and
rooms fall back to STUN only. There is no TURN URL to remove alongside it:
the URLs arrive from the credential endpoint, already carrying the
credential they need, precisely because a `turn:` entry without one makes
the `RTCPeerConnection` constructor throw.

## Why TURN matters at all

STUN gets two peers talking directly when at least one side's NAT is
"friendly" - it just tells each side its own public address and port, and
the peers try to reach each other directly. That fails for:

- **Symmetric NAT** - common on mobile carrier networks and some home
  routers - where the NAT allocates a different external port for every
  destination, so the address STUN discovered for one peer doesn't work
  for reaching another.
- **CGNAT** - most mobile data connections and some ISPs put many
  customers behind one public IP with no port forwarding possible at all.
- **Corporate/school firewalls** that block inbound UDP outright.
- **Two devices on the same Wi-Fi**, when the router doesn't support NAT
  hairpinning (reflecting a request for your own public IP back inside the
  LAN) - surprisingly common on consumer routers.

Roughly one connection in five needs a relay for this reason. A live
stream has a fallback - the origin server. **A peer-to-peer call has none.
It just fails**, silently, for exactly the users a public conference tool
most needs to work for. TURN is that relay: both peers connect out to a
TURN server (nearly always possible - it looks like an ordinary outbound
connection) and it forwards their media between them.

## What TURN costs

Unlike STUN (a handful of UDP packets to discover an address), a TURN
relay carries **every byte of every media stream it's used for**, in both
directions, for the whole duration of a call. A single 1080p video track
is roughly 2-4 Mbps; two people relayed through TURN for camera + mic for
an hour is on the order of 2-4 GB of relayed traffic. This is why
`turnserver.conf` sets `user-quota`, `total-quota` and `max-bps` - see the
comments there, which also explain at length why it deliberately does NOT
set `bps-capacity` - and why the coturn container's actual data-plane cost
is bandwidth, not disk or CPU. coturn itself is a small binary and the
box's disk headroom is not the constraint.

Concretely, for the deployment this repo runs: one relayed two-person call
with camera and microphone is on the order of 1 to 2 GB of traffic per
hour, counted once inbound and once outbound, because a relay sends every
byte it receives. Only calls that actually need a relay cost anything;
roughly 80% of connections still complete peer to peer and never touch
this server. The host's monthly traffic allowance is the real ceiling, and
it is measured in tens of terabytes, so this is a "watch the graph" cost
rather than a "budget for it" cost until the app has real users. Watch
the bandwidth graph after this goes live, not just the disk.

## Prerequisites

- **A hostname that resolves to the box.** This deployment reuses
  `kithmoot.forgesworn.dev`, the same name the PWA is served on, rather
  than a dedicated `turn.` subdomain. That is a deliberate simplification:
  the record already exists, and Caddy already holds a Let's Encrypt
  certificate for it because it serves the site on 443, so TURN over TLS
  needs no new DNS record and no second certificate to renew. A separate
  subdomain would be tidier and buys nothing. TURN and HTTPS do not
  collide: they are different ports on the same address.
- **Docker and Docker Compose on the box.** coturn runs as a container;
  the PWA itself is static files under Caddy and needs none.
- **Node on the box**, for the credential service. No compiler is needed:
  `deploy/turn-deploy.sh` builds `dist/src/turn.js` on your machine and
  ships it.
- **`sudo` for the deploy user.** `install.sh` writes `/etc/kithmoot`,
  manages systemd units and edits firewall rules. Confirm this before
  relying on it rather than discovering it half way through.

No certbot. Caddy is the only ACME client on the box, and
`deploy/coturn/sync-certs.sh` copies the certificate it already holds into
a directory coturn can read, on a daily timer, restarting coturn only when
the bytes change. Running certbot alongside would mean two clients
competing for one name and two chances to let it lapse.

## Firewall ports

| Port(s)         | Protocol | Purpose                                    |
|-----------------|----------|---------------------------------------------|
| 3478            | TCP+UDP  | STUN/TURN, plaintext                        |
| 5349            | TCP      | TURN over TLS                               |
| 49152-49452     | UDP      | Relay range (`min-port`/`max-port` in `turnserver.conf`) |

`deploy/coturn/install.sh` opens all four in `ufw`, reading the relay
range out of the rendered config rather than repeating the numbers, so the
firewall cannot drift from what coturn is actually using.

**The relay range is not optional to open.** It is where the media flows
once an allocation is made. A closed relay range means the TURN handshake
on 3478 succeeds and every call using it still fails, which is far more
confusing than TURN not running at all.

### Check for a second firewall in front of the box

`ufw` is often not the only thing filtering. This deployment sits on a
Hetzner Cloud instance, and Hetzner Cloud Firewalls are enforced upstream
of the host: rules added in `ufw` were correct, `ufw status` showed them,
and packets to 3478 never arrived on `eth0` at all, while 443 arrived
normally in the same capture. Nothing on the box can see or change that
firewall; it is edited in the provider's console or with `hcloud`.

The check that settles it in one step, run on the box while probing from
elsewhere:

```bash
sudo tcpdump -n -i eth0 'port 3478 or port 5349'
```

Packets arriving and being dropped is a host firewall problem. **No
packets arriving at all is an upstream firewall**, and no amount of `ufw`
will fix it. Do this before debugging coturn: the symptom of a blocked
port is identical to the symptom of a broken TURN server, and one of them
is not your fault.

## Deploying the PWA

```bash
# from a checkout of this repo, on your own machine - never on the box
DEPLOY_HOST=deploy@YOUR_BOX \
DEPLOY_KEY=~/.ssh/id_ed25519 \
  deploy/deploy.sh --reload-caddy
```

This builds `app/dist` locally, rsyncs it to a new timestamped release
directory under `/var/www/kithmoot/releases/` on the box, and atomically flips
`/var/www/kithmoot/current` to point at it. See the comments at the top of
`deploy.sh` for the full sequence, the `--prune` flag, and why it's safe
to re-run.

Before the first deploy, install the vhost (see the comment block at the
top of `Caddyfile.kithmoot` for the exact steps - it needs a real hostname
substituted in, and to be wired into whatever this box's Caddy already
uses to include per-site config files) and make sure `/var/www/kithmoot/`
exists and is writable by the `deploy` user:

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 \
  deploy@YOUR_BOX 'sudo mkdir -p /var/www/kithmoot/releases && sudo chown -R deploy:deploy /var/www/kithmoot'
```

## Deploying coturn and the credential service

One command, from a checkout on your own machine, never on the box:

```bash
DEPLOY_HOST=deploy@YOUR_BOX deploy/turn-deploy.sh
```

It builds `dist/src/turn.js`, ships the credential service's tree to
`/opt/kithmoot-turn` and the coturn files to `/opt/kithmoot-coturn`, then
runs `deploy/coturn/install.sh` on the box, which does the rest:

1. Creates the unprivileged `kithmoot-turn` user.
2. Detects the box's public IPv4 from its default route and **refuses to
   continue if the TURN hostname does not resolve to it**. A client that
   connects to one address and is handed relay candidates on another
   simply never connects, and the error points nowhere near the cause.
3. Generates `/etc/kithmoot/turn-secret` on first run only, mode 0600.
4. Renders `/etc/kithmoot/coturn/turnserver.conf` from the template in
   this repo, substituting the address and splicing in the secret. The
   secret is written with a shell builtin, never passed as an argument to
   `sed` or anything else, because arguments are visible in `ps` to every
   user on the box.
5. Writes `/etc/kithmoot/turn-credentials.env` with the same secret.
6. Copies the TLS certificate out of Caddy's store.
7. Opens the firewall ports.
8. Starts coturn and enables `turn-credentials` and the certificate timer.

Idempotent. Re-running it re-renders the config, re-applies the firewall
rules and restarts the services. It never regenerates the secret once one
exists, because that would invalidate every credential already minted and
break every call in progress.

The container runs as the `kithmoot-turn` uid rather than the image's
default `nobody`, which is what lets the config holding the shared secret
be mode 0600 owned by one dedicated user instead of group-readable by
`nogroup`, which on a shared box is every stray unprivileged process.

### Rotating the secret

Deliberate, and it will drop calls in progress:

```bash
sudo rm /etc/kithmoot/turn-secret
DEPLOY_HOST=deploy@YOUR_BOX deploy/turn-deploy.sh
```

### After changing src/turn.ts or the credential service

Nothing on the box rebuilds itself. Re-run `deploy/turn-deploy.sh`.

## Verifying TURN actually works

Getting this wrong is easy and silent. A browser can establish a call
using only STUN-discovered `srflx` candidates on your own network and look
completely healthy, while still failing for the next real user on a
stricter network, because your test never needed the relay candidate at
all. Two same-machine browsers are worse still: they connect on `host`
candidates whether or not any TURN server exists anywhere. That is exactly
how a deployment with no TURN server at all passed every test it had.

### Server side

Confirm coturn is listening on the box's public address, not `0.0.0.0`:

```bash
sudo ss -lntup | grep -E ':3478|:5349'
```

Then confirm a credential from the endpoint actually authenticates. This
relays real packets through the running server:

```bash
cred=$(curl -s http://127.0.0.1:8089/turn -H 'Origin: https://YOUR_HOST')
U=$(printf '%s' "$cred" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])')
W=$(printf '%s' "$cred" | python3 -c 'import sys,json;print(json.load(sys.stdin)["credential"])')
sudo docker run --rm --network host --entrypoint turnutils_uclient \
  coturn/coturn:4.17.2-r0 -y -c -n 4 -u "$U" -w "$W" -p 3478 YOUR_PUBLIC_IP
```

A healthy run reports `tot_send_msgs` and `tot_recv_msgs` matching with no
lost packets. Repeat it with a deliberately wrong credential and confirm
it reports `Cannot complete Allocation` - a test that passes with a bad
credential is testing nothing.

### End to end, the one that matters

```bash
npm run test:turn
```

`test/turn-relay.spec.ts` drives two real browser contexts against the
live site with `iceTransportPolicy: 'relay'` forced, which makes the
browser discard host and server-reflexive candidates and gather only relay
ones. The only route to a connection is then an allocation on the real
TURN server with a real credential: the same code path a phone behind
CGNAT takes, minus the CGNAT. It asserts the credential endpoint answered,
that the selected candidate pair is of type `relay` at **both** ends, and
that RTP bytes actually arrived, because ICE reaching `connected` while
carrying no media is precisely the original bug.

It runs against the live deployment by default and starts no local server,
since `vite preview` does not serve `/turn`. See
`playwright.turn.config.ts`; override with `TURN_E2E_BASE_URL`.

If it fails, the failure message distinguishes the cases: no credential,
no `turn:` server in the app's ICE list, a non-`relay` candidate type, or
a connection carrying no bytes.

A browser trickle-ICE page such as the WebRTC project's
[trickle-ice sample](https://webrtc.github.io/samples/src/content/peerconnections/trickle-ice/)
is a reasonable manual spot check, fed a `urls`/`username`/`credential`
triple from `/turn`. **A healthy result shows at least one candidate of
type `relay`**; `host` and `srflx` candidates prove your network path
works, not that TURN does.

## Minting TURN credentials for the browser

coturn only checks credentials. Something has to hand a browser a fresh
`{username, credential}` pair first, and that is
`server/turn-credentials.mjs`: a small Node HTTP service using
`mintTurnCredential` (`src/turn.ts`) against the same secret as
`turnserver.conf`, which `app/src/main.ts` fetches at join time (see
`TURN_CREDENTIAL_ENDPOINT` there) whenever a room is using this default
TURN server rather than one of its own.

It binds `127.0.0.1:8089` and is never exposed directly.
`deploy/Caddyfile.kithmoot` reverse-proxies `/turn` to it on the app's own
domain. `/healthz` is deliberately not proxied: it exists for a `curl` on
the box, and publishing it would only advertise the service to anyone
scanning.

Every mint gets its own random label (`km-<random>`), so one credential
username means one browser session. That is what makes coturn's
`user-quota` a per-session control rather than a global one that a busy
room trips on everybody's behalf.

**A failed or unreachable fetch never blocks joining.** The room falls
back to STUN only, exactly as before this endpoint existed. A call that
refuses to start because an optional convenience server had a bad day is a
strictly worse outcome than one that degrades.

The secret exists in exactly two places on the box, and must match:
`static-auth-secret` in coturn's rendered config, and `TURN_SECRET` in the
credential service's `EnvironmentFile`. `install.sh` writes both from one
generated value. It never appears in anything shipped to a browser - see
`deploy/turn-credentials.md` for why a static credential in the client
bundle is the thing this whole scheme exists to avoid.

### The honest cost of an unauthenticated endpoint

As shipped, `GET /turn` mints a credential for anyone who asks - there is
no login, no per-room token, nothing that ties a request to a real
participant in a real room. That means **anyone who finds this URL can
relay their own traffic through this coturn server, at this operator's
bandwidth cost**, for as long as they keep asking (each credential just
expires and they ask again). CORS on the service restricts which *browser
pages* can read the response, and a per-IP rate limiter slows down
casual, single-source abuse - neither stops a determined caller, who can
simply script requests with no `Origin` header and rotate source IPs.
There is no free fix here; pick honestly among:

- **Accept the cost.** For a small deployment this may simply be cheap
  enough to not matter - watch the bandwidth graph (see "What TURN
  costs" above) and revisit if it stops being true.
- **Gate on the room's own kindred policy.** Have the credential endpoint
  require proof of whatever access tier the room already checks (see
  `evaluateAccess` / `KindredProof` in `src/access.ts`) before minting -
  real work, but it means the credential is scoped to people who could
  already get into the room, not the general internet.
- **Put a shared token in front of it.** Require a header or query
  parameter the operator controls (and rotates) before `/turn` will mint
  anything. Cheaper to build than kindred-gating, but the token itself
  becomes one more secret to distribute and leak, and doesn't scope
  access per-room the way kindred does.
- **Charge for it.** Put L402 in front of the endpoint, so a credential
  costs a satoshi or two. A rate limiter is a speed bump because requests
  are free; a price turns bandwidth theft into a purchase, and the
  attacker's arithmetic is the control. `deploy/l402/` is that kit - it
  proxies this same service without modifying it, and it stands up a
  *separate* host rather than putting a paywall on the app's own `/turn`.

The first three do not ship in this kit - `server/turn-credentials.mjs`
mints on request to anyone who can reach it, by design, so the choice above
is made deliberately rather than defaulted into. The fourth ships as
`deploy/l402/`, and is off unless you deploy it: the free endpoint this
page describes is unchanged by its existence.

## Running a forwarder

A mesh call costs every participant `(N-1) x bitrate` of *upload*, and upload
is the scarce half of a domestic connection:

| Each person sends | Per copy | x 20 peers |
|---|---|---|
| Opus voice | ~32 kbps | 0.64 Mbps |
| Video 180p | ~150 kbps | 3 Mbps |
| Video 360p | ~600 kbps | 12 Mbps |
| Screen share, legible 1080p | ~1.5-2.5 Mbps | **30-50 Mbps** |

Against a typical UK domestic uplink of 10-20 Mbps, a mesh runs out somewhere
around eight people on video - sooner if anybody shares a screen. Past that,
somebody has to forward: each device sends **one** copy to the forwarder, and
the forwarder sends everybody theirs.

`server/forwarder.mjs` is that somebody. It is a small Node process anyone can
run - no inbound port, no TLS certificate, no domain. It works from behind
NAT, on a home connection, on a Raspberry Pi.

### The claim, and what it rests on

Every other conferencing system answers the same arithmetic by putting a
server in the media path that can see the media. Jitsi's videobridge does, by
default. This one cannot, and not as a promise:

- **It is configured with the room id, never the room key.** The room id is
  public - relays see it on every event. The room key is what decrypts
  everything, and this process is never given it. `loadConfigFromEnv`
  **refuses to start** if `KITHMOOT_ROOM_KEY`, `KITHMOOT_ROOM_SECRET`,
  `KITHMOOT_JOIN_URL` or `KITHMOOT_SECRET` is anywhere in its environment,
  and refuses a `KITHMOOT_ROOM_ID` that looks like a join URL - because a
  join URL's fragment carries the room secret.
- **It cannot read the roster**, which is encrypted to the room key, so it
  never learns who is in the room, what they are publishing, or which devices
  belong to one person. It does not subscribe to the roster kind at all.
- **It cannot read the media.** Once a forwarder is in the path, frames are
  encrypted end to end under a key derived from the room key
  (`src/media-crypto.ts`) - inside the DTLS-SRTP the hop already has. The
  forwarder moves RTP packets from one connection to another and never
  depacketises, decodes or inspects a payload.
- **It cannot forge attribution**, because it cannot produce a frame that
  opens under any member's media key.

`test/forwarder-blindness.test.ts` is where that is proven rather than
asserted.

### How a client reaches it, given it can't read the room

There is no forwarder-specific protocol and no socket to dial. A forwarder
holds its own Nostr key and is reached exactly the way any other endpoint in
a KithMoot room is reached: a gift-wrapped offer on a relay, addressed to its
pubkey. A wrap is sealed to its *recipient*, not to the room, so the
forwarder unwraps it with its own secret key - no room key involved. The
inner signal names a room, which is checked against the one it serves.

So the entry a room descriptor carries is just `{ url, pubkey }`, where `url`
is a relay to signal over. The forwarder prints that line at startup, ready
to paste.

The honest consequence: **anyone who knows the room id and this forwarder's
pubkey can ask it for a connection.** There is no membership check, because
the only thing that could perform one is the room key. What a stranger gets
is ciphertext they cannot read; what they cost is bandwidth, and that is what
the fan-out cap bounds. If that is not acceptable for your deployment, run
the forwarder for a room whose id you do not publish, or don't run one.

### What a forwarder costs

Like TURN, and unlike STUN, **a forwarder relays every byte it carries**, in
both directions, for the whole call. Unlike TURN it also *multiplies* them.
With `N` peers each sending one stream at `B`:

- **in:** `N x B`
- **out:** `N x (N-1) x B`

At the default cap of 24 peers on 600 kbps video that is roughly 14 Mbps in
and **330 Mbps out**. That is well past a domestic uplink and firmly into
what a VPS bills for. Budget on the outbound figure, not the inbound one, and
watch the bandwidth graph rather than the CPU graph - the process itself does
almost no work, which is the point.

Two caps bound it, both configurable, both refusing rather than degrading:

| Variable | Default | What it bounds |
|---|---|---|
| `KITHMOOT_MAX_PEERS` | 24 | Devices connected at once. A device past the cap gets no answer, and falls back to direct mesh - degraded, not broken. |
| `KITHMOOT_MAX_TRACKS_PER_PEER` | 4 | Tracks one device may fan out. Four is exactly the `TrackRole` set (camera, mic, screen, screen-audio). |

One process serves **one room**. That is deliberate: a fan-out cap is only a
meaningful promise if nothing else on the process is competing for the same
uplink, and a process with no cross-room state has no cross-room mistake to
make. Run several if you want to serve several rooms, and size the box for
the sum.

### Running it

The one-command version, from a checkout:

```bash
KITHMOOT_ROOM_ID=<64 hex> \
KITHMOOT_FORWARDER_SK=$(openssl rand -hex 32) \
NOSTR_RELAYS=wss://relay.trotters.cc \
  npx kithmoot-forwarder
```

That is fine for a look. For anything that has to survive a reboot, generate
the key **once** and keep it: a room descriptor names a forwarder by pubkey,
so a key regenerated on each restart silently orphans every room pointing at
it.

| Variable | Required | Meaning |
|---|---|---|
| `KITHMOOT_ROOM_ID` | yes | The room's 64-hex public id, or several comma-separated. Not the join URL. |
| `NOSTR_RELAYS` | yes | Comma-separated `ws:`/`wss:` relays. Use the ones the room uses, or it will never see the forwarder answer. |
| `KITHMOOT_FORWARDER_SK` | one of | This forwarder's own Nostr secret key, 64 hex (`openssl rand -hex 32`). **One room only.** No default, on purpose. |
| `KITHMOOT_FORWARDER_ROOT_SK` | one of | A root secret, 64 hex, from which a **separate key per room** is derived. Use this to serve several rooms from one process. |
| `KITHMOOT_FORWARDER_URL` | no | The relay advertised in the descriptor. Defaults to the first `NOSTR_RELAYS` entry. |
| `KITHMOOT_MAX_PEERS` | no | Fan-out cap. Default 24. |
| `KITHMOOT_MAX_TRACKS_PER_PEER` | no | Per-peer track cap. Default 4. |
| `KITHMOOT_LABEL` | no | A name for people. Never used for logic. |

#### Several rooms, one process

A box that forwards for more than one room does not need a process each.
List the ids and give it a root secret instead of a literal key:

```bash
KITHMOOT_ROOM_ID=<64 hex>,<64 hex>,<64 hex> \
KITHMOOT_FORWARDER_ROOT_SK=$(openssl rand -hex 32) \
NOSTR_RELAYS=wss://relay.trotters.cc \
  npx kithmoot-forwarder
```

**Each room gets its own pubkey**, derived from the root and that room's id.
That is not tidiness. A descriptor names its forwarder by pubkey, so one key
across several rooms publishes the same pubkey into all of them, and anyone
reading those descriptors can tell those rooms share infrastructure - the
cross-room linkage per-room device keys exist to prevent (see
`docs/decisions.md`, "Device keys are per room"). Derivation is also what
keeps the pubkeys **stable** across restarts without a file to back up.

Passing `KITHMOOT_FORWARDER_SK` with more than one room is refused rather
than quietly shared. The two variables are separate on purpose: an existing
single-room forwarder that upgrades keeps `KITHMOOT_FORWARDER_SK` and keeps
its exact pubkey, so nothing it already serves is orphaned. Moving to a root
secret changes the pubkey, and the descriptors have to be updated - which is
why it is a different variable and not a silent reinterpretation of the same
one.

What one process does **not** buy you is isolation. The rooms share an event
loop, an uplink and a `MemoryMax`, so a room busy enough to saturate any of
those is felt by the rest, and one crash takes them all down together. One
instance per room is still how you keep rooms apart; this is for a box
carrying several quiet ones.

For a persistent install, `deploy/forwarder@.service` is a systemd template
with a dedicated user, `Restart=always`, and the usual hardening:
`kithmoot-forwarder@<name>`, reading `/etc/kithmoot/forwarder-<name>.env`.
An instance serves one room or several, depending on what that env file
says. From a checkout on your own machine,
never on the box:

```bash
DEPLOY_HOST=deploy@YOUR_BOX deploy/forwarder-deploy.sh --name townhall --room-id <64 hex>
```

That ships the same tree the keepers run from (`deploy/keeper-deploy.sh
--ship-only`, see "Running a keeper" below) and runs
`deploy/forwarder-install.sh` on the box, which makes the `kithmoot-fwd`
user, generates this instance's Nostr key once and writes it into the env
file with a shell builtin (never as an argument, which `ps` would show),
installs the template, and starts `kithmoot-forwarder@townhall`. The env
file is written once and then left alone: edit it and `systemctl restart
kithmoot-forwarder@townhall` to change relays or caps. `--relays`, `--url`,
`--max-peers`, `--max-tracks` and `--label` set the first-run values, and
they are flags rather than environment variables on purpose: a
`NOSTR_RELAYS` left in your shell by some other tool must not quietly
become the relays this room's forwarder listens on. Give it the room's
relays; a forwarder on other relays is one the room never hears answer.

The room id is the one thing you bring, and deliberately the only thing:
`keeper-install.sh` prints it for a room the box keeps, and a member can
read it off `deriveRoom(secret).roomId`. Neither script has a flag for the
room key, and both refuse a room id that looks like a join URL.

```bash
journalctl -u kithmoot-forwarder@townhall -n 30
```

The startup banner states, in plain words, that this process relays
ciphertext it cannot read, and ends with the one-line JSON to add to the
room's descriptor:

```
{"url":"wss://relay.trotters.cc","pubkey":"<64 hex>","label":"trotters box"}
```

### Pointing a room at it

A room's forwarder list travels in its descriptor, encrypted to the room key
and published as an ephemeral event, next to its ICE servers. For a room a
keeper holds, put the JSON above in the keeper's `KITHMOOT_FORWARDER` (see
"Pointing the keeper's room at a forwarder" below) and the keeper publishes
it. From code, add it to `forwarders` and `publishDescriptor`. `selectForwarder` (`src/forwarder.ts`)
imposes a total order over the list, so every client in the room independently
picks the same one without negotiating - and picks `wss:` over `ws:` where a
forwarder offers both.

Nothing is mandatory. A room that names no forwarder stays a mesh; a room
whose forwarder is unreachable **falls back to mesh** rather than failing, so
a dead forwarder is a slower call for a big room and no change at all for a
small one. Promotion is decided on measured capacity, never on headcount
(`needsForwarding`): twenty people on audio-only never promote, and two
people sharing legible 1080p screens might.

### When a forwarder is *not* what you want

A pure mesh is already end-to-end encrypted by DTLS-SRTP, hop to hop, with no
hop in between. Putting a forwarder in the path adds a machine you have to
trust with your bandwidth (not your media), and switches on the extra
per-frame encryption pass that keeps it blind - which costs battery on a
phone and fights some hardware codec paths (`src/media-crypto.ts` documents
that honestly). For a five-person call it buys nothing and costs all of that.
Run one when the arithmetic at the top of this section says you need one, not
before.

## Running a keeper

A room admits newcomers for as long as somebody who can answer the link is
online. The creator's browser can; every admitted member can, for twelve
hours from the creator's grant and no longer, because a delegation is
bounded on purpose (see `docs/decisions.md`). A room meant to stay open for
days - people and their agents drifting in and out, the odd call - therefore
wants a creator that is always online. That is a keeper: `kithmoot-agent
create`, kept running by systemd, one instance per room.

```bash
DEPLOY_HOST=deploy@YOUR_BOX deploy/keeper-deploy.sh --room standing
```

builds the library locally, ships the entry points, `dist/src`, the
lockfile, the units and the install scripts to `/opt/kithmoot-keeper`, and
runs `keeper-install.sh` there as root: a `kithmoot-keeper` system user,
`npm ci --omit=dev`, the unit templates, an env file at
`/etc/kithmoot/keeper-standing.env` (written once, then left alone), and a
start of `kithmoot-keeper@standing`. `--room townhall` next makes a second
room with its own env file and its own state, running from the same tree.
Every running instance is restarted when a new tree lands, so one deploy
updates every room; each restart is a few seconds in which that room's link
is not answered. Without `--room` the old one-liner still keeps the room
named `default`.

The room's secret, its inviter key and the keeper's participant key live
under `/var/lib/kithmoot-keeper/<room>/`, mode 0600, created on first start
and reused on every restart, so the same link reopens the same room. Back
that directory up if the room matters; move it aside to make a new one.
The install ends by printing the room's public id (what a forwarder is
given) and the path of the link, not the link itself: a link is a
capability, and a deploy log is not where one belongs. `sudo cat
/var/lib/kithmoot-keeper/<room>/room.json.link` on the box prints it.

### Taking over a room that already exists

A room somebody's laptop has been keeping can move to the box without its
link changing:

```bash
DEPLOY_HOST=deploy@YOUR_BOX \
  deploy/keeper-deploy.sh --room standing --state-from ~/.kithmoot/standing-room.json
```

`--state-from` sends the keeper state that `kithmoot-agent create --state`
wrote (the room's secret, inviter key and bearer) over ssh on stdin, never
as an argument, and lands it 0600 under the new instance's state directory
before the first start. It is refused if the instance already has a room,
and rejected if it is not a v1 keeper state. The box's keeper gets its own
participant identity, generated there; only the room moves. With the same
base and relays the box writes the same link, byte for byte, and the old
keeper can be stopped, or switched to `join` on that link, once the box's
is up. Two keepers holding one room for a moment is fine.

### Migrating from the single-room kit

A box installed before instances existed has `kithmoot-keeper.service`,
state directly under `/var/lib/kithmoot-keeper/` and
`/etc/kithmoot/keeper.env`. The first run of the new `keeper-install.sh`
moves that room, unchanged, to the instance `default`: the three state
files are moved (not copied) into `/var/lib/kithmoot-keeper/default/`, the
env file becomes `keeper-default.env`, the old unit is stopped, disabled
and moved aside under `/etc/kithmoot/migrated-<stamp>/`, and
`kithmoot-keeper@default` is enabled and started. Same room, same link,
one restart. To reverse it: stop `kithmoot-keeper@default`, move the three
files back up a level, rename the env file back, copy the unit back out of
the `migrated-` directory, `daemon-reload`, and `enable --now
kithmoot-keeper`.

What it costs: nothing to speak of. A keeper with `--brain none` holds relay
sockets and answers admission requests; it publishes no media and, unless
started with `--listen`, opens no peer connection that carries any. The unit
caps each instance at 512M of memory, which is several times what it uses.

What it means: **the box holds the room key.** A forwarder is blind by
construction; a keeper is a member, and the operator of the box can read
that room the way any member can. Run a keeper for a room whose people are
content with that. It is the same trust a room's creator always had, moved
to a machine that does not close its lid.

To give a keeper ears or a voice, edit its env file: `KITHMOOT_BRAIN`,
`KITHMOOT_MODEL`, `KITHMOOT_PERSONA`, `KITHMOOT_MEMORY`, `KITHMOOT_WHISPERX`
are all read (see `kithmoot-agent --help`), though the unit as shipped
passes `--brain none` and a keeper that talks is usually better run as a
second, separate agent so the room's availability does not depend on a
model being reachable.

### Hosts: who may remove people

A keeper is the room's authority, and the only party that can remove a
member: it moves the room to a new epoch whose key the removed person is
not given (`docs/decisions.md`, "A member is removed by a room epoch"). The
people who may ask it to are named in that instance's env file,
`/etc/kithmoot/keeper-<room>.env`:

```
KITHMOOT_ADMINS=<hex pubkey>,<npub1...>
```

comma separated, hex or npub, the same as repeating `--admin`. Restart
`kithmoot-keeper@<room>` after editing. The keeper announces the list to the room, signed, and
anybody on it who signs in to the app with that key sees a Host panel:
Remove and Mute per person, and Close room. Remove and Close are enforced
by the key; Mute is a request the other person's client honours. With no
admins, only the box's operator can act on the room, from code.

The state file gains the epoch, its secret and the removed set, and a
keeper restarted by systemd reopens the room in the same epoch, still
refusing the same people. A file written before this reads as epoch 0. A
closed room's state says so and is not reopened: move
`/var/lib/kithmoot-keeper/<room>/` aside to make a new room. After a
removal, `sudo cat /var/lib/kithmoot-keeper/<room>/room.json.link` still
prints the link: it is the same link, and it still admits people; what
changed is the key behind it.
### Pointing the keeper's room at a forwarder

The descriptor that names a room's forwarders is an ephemeral event under
the room's epoch key, and the app publishes none: until now, attaching a
forwarder to a standing room needed a member to publish it by hand. The
keeper does it instead. Put the line `kithmoot-forwarder` printed in the
instance's env file:

```
KITHMOOT_FORWARDER='{"url":"wss://relay.example","pubkey":"<64 hex>","label":"townhall box"}'
```

single-quoted, because the value is JSON and systemd's `EnvironmentFile`
reads single quotes as quoting. A path to a file holding that line, or a
list of them, works too, as does repeating `--forwarder` on the command
line. Restart `kithmoot-keeper@<room>` after editing. A line that does not
parse - a missing `url`, a scheme other than `ws:`/`wss:`, a pubkey that is
not 64 hex - is refused at start with the reason, before the keeper joins
anything.

The keeper publishes the descriptor when it starts, again after every
rekey (the descriptor rides the epoch key, so the old one is unreadable to
whoever moved), and again whenever a device arrives, because a descriptor
is never replayed and a late joiner is otherwise never told. Whether a
room promotes is still decided on measured capacity, never on headcount:
naming a forwarder makes it available, not mandatory.

### Nudging absent members

| Variable | Default | Meaning |
|---|---|---|
| `KITHMOOT_ROOM_NAME` | unset | What the room is called. Rides in the link, and is what a nudge names. |
| `KITHMOOT_NUDGE` | unset | `1` to DM members who asked, when they miss messages. |

With `KITHMOOT_NUDGE=1` in the instance's env file, a member who signed in
with a Nostr key can turn on **Nudge me when I'm away** in the room. The
keeper writes their pubkey into `room.json` beside the room's secret, and
when a chat message lands while they are not in the roster it sends them
one NIP-17 gift-wrapped DM from the keeper's own participant key
(`identity.key` under the instance's state directory), over the room's
relays, saying there are new messages in the room, with the link. One an
hour at most per member, and not again until they have been back.

Say this plainly to the people in the room: a relay carrying the room now
also sees that the keeper's key sent a gift wrap to that member's pubkey,
and roughly when. It does not see the room, the text, or who else was
written to. The DM lands on the room's relays, so a member's DM client has
to be reading those to show it. See `docs/agents.md`, "Nudge".

## Running a Blossom server

Drop a file on a room's chat and the browser seals it into a Wildbloom
envelope under a fresh key, puts the sealed bytes on a Blossom server
(BUD-01: `PUT /upload`, authorised by a signed kind-24242 event), and hands
the key to the room inside the message; `docs/agents.md`, "Dropping a file
in", has the whole of it. The server is a default on the same terms as
TURN, not a dependency: `BLOSSOM_ENDPOINT` in `app/src/main.ts` names the
app's own origin, the Attach panel lets anyone name another, and a fork
that runs none sets the constant back to `''` and the panel asks.

The kit runs [blossom-server-ts](https://github.com/hzrd149/blossom-server),
the most used open-source Blossom server, pinned to 5.2.0, on the box's
Node 22. Wildbloom Node, ForgeSworn's own, is a Rust daemon with
deny-by-default writes and an owner, friend and guest model: the right
shape for a person's own machine and the wrong one for an open drop box.

```bash
DEPLOY_HOST=deploy@YOUR_BOX deploy/blossom-deploy.sh
```

ships `deploy/blossom.service`, `deploy/blossom.yml` and
`deploy/blossom-install.sh` to `/opt/kithmoot-blossom` and runs the install
there as root: a `kithmoot-blossom` system user, `npm install` of the
pinned server into the tree, the config as `config.yml`, an env file at
`/etc/kithmoot/blossom.env` (written once, then left alone: `PORT`,
`BLOSSOM_PUBLIC_URL`, `BLOSSOM_STATE`), the unit as
`kithmoot-blossom.service`, and the state under `/var/lib/kithmoot-blossom`:
`sqlite.db` (what is stored, under which key, last fetched when) and
`blobs/`. A second run updates the tree and the unit and restarts the
service; the env file, the database and the blobs are left alone.

**The quota.** `blobs/` is a fixed-size ext4 image, `blobs.img`, made by
the install script (`BLOSSOM_QUOTA_GIB`, default 20) and mounted from
`/etc/fstab`; the unit has `RequiresMountsFor` on it, so the server does
not start without it and cannot write past it. When it is full, uploads
fail until something expires. There is no retention beyond that: a blob
that has gone 90 days without being fetched is pruned (the one rule in
`blossom.yml`, counted from the last fetch, not the upload), and a full
image is a full image. To resize: stop the unit, unmount, move `blobs.img`
aside, take its line out of `/etc/fstab`, and run the deploy again with a
new `BLOSSOM_QUOTA_GIB`.

**The cap.** 70 MiB per blob: a 64 MiB source (`MAX_UPLOAD_SOURCE_BYTES`,
what the app refuses before sealing) plus the envelope's padding and tags.
It is Caddy's `request_body max_size` on `/upload`, because
blossom-server-ts 5.2.0 has no cap of its own: Caddy reads the body up to
70 MiB and no further, answers 413, and cuts the upstream, at which the
service removes the upload it was spooling. It does not pre-check the
`Content-Length`, so an over-cap upload costs 70 MiB of transfer before it
is refused; the app never sends one, and nothing is stored. An upload is
spooled to the unit's private `/tmp` before it is hashed and moved into
place, so the cap is what bounds that too.

**Caddy.** Two `handle` blocks in `Caddyfile.kithmoot`, beside `/turn`:
`/upload` (PUT and HEAD, the cap, proxied to `127.0.0.1:8092`) and
`/blossom/<sha256>` (GET and HEAD, the prefix stripped, proxied to the
same). The service is told in `BLOSSOM_PUBLIC_URL` that its blobs live
under `https://kithmoot.forgesworn.dev/blossom/`, so the descriptor it
answers an upload with names that, and the app checks the origin is its
own and the leaf is the hash before it trusts it. The upload is at the
root because the app takes an origin and nothing more for a Blossom server,
and BUD-01 puts the upload at `/upload` under it. Nothing else of the
server's is exposed: list, delete, mirror, the admin page and the landing
page answer on loopback only. The deploy script does not touch Caddy; put
the two handles in the vhost, `caddy validate`, reload.

**What the box learns, and who may use it.** An encrypted blob, its size,
and the device key that signed the upload; the device key is random per
device and per room, so it names nobody. Not the file's name, type or
contents, and never the key: those are inside the envelope, and the key
goes in the message. Uploads are open to any key, because there is nobody
to allowlist: a participant's device key is made on the device and
registered nowhere. What stands in the way of abuse is the cap, the quota,
the expiry, and one accepted media type,
`application/vnd.forgesworn.encrypted`, the envelope and nothing else. An
image or a video is refused, so the box is not a general file host and
nothing on it can be hot-linked as media; the worst anyone can do is fill
20 GiB with sealed bytes nobody can open, and wait 90 days.

The unit fences the socket to loopback (`IPAddressAllow=localhost`), because
5.2.0 takes a port and no host and listens on every interface; the firewall
would stop that too, but a unit should not depend on it.
`journalctl -u kithmoot-blossom -f` for logs, and
`curl -s -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:8092/upload`
prints 401 when it is up.

## Turning the donor ring on

Off by default, and off means off: no rings, no endpoint lookup, no relay
traffic and nothing on the console. Two constants in `app/src/main.ts` switch
it on, and both are required.

```ts
const DONATION_ADDRESS = 'you@your-wallet.example'   // where the money goes
const DONATION_RECIPIENT = ''                        // 64 hex, the pubkey zaps name
```

`DONATION_ADDRESS` is a Lightning address (LUD-16). The app fetches
`https://<host>/.well-known/lnurlp/<name>` at runtime and reads `nostrPubkey`
from it - the key that signs that address's zap receipts. It is never written
into the source, so a wallet that changes provider, or stops supporting zaps,
takes the ring dark instead of leaving it accepting whatever turns up.

`DONATION_RECIPIENT` is the Nostr pubkey, in hex, that a donation has to be
addressed to. It is not the same thing as the address and it is not optional.
Most Lightning addresses are at custodial wallets, and such a provider signs
every one of its customers' receipts with one key, so "signed by the key this
address advertises" proves the money reached the provider and not that it
reached you. The recipient inside the donor's own signed request is what says
who was paid. Set it to the pubkey your donors' clients will actually put in
a zap - normally the identity whose profile carries the address - and check
the two agree before switching this on, because a mismatch produces rings for
nobody rather than a wrong figure.

Then rebuild the PWA and deploy it as usual. There is no server side to this
and nothing to run: totals are worked out in each viewer's browser from
public zap receipts, and every receipt has to pass all three checks in
`src/donations.ts` before it counts. The bands are `DONOR_TIERS` in that same
file - five of them, top band 100,000 sats - and changing the figures there
changes every ring in the app.

What it asks relays for: receipts addressed to `DONATION_RECIPIENT`, and
nothing else. No participant pubkey is ever in the filter, so this adds
nothing to the relay correlation that `app/src/profiles.ts` already documents
and states.
