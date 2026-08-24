# Deploying KithMoot

This directory is a deploy *kit*, not a deploy. Nothing in it runs on its
own - you run `deploy/deploy.sh` yourself, by hand, when you mean to.

Three independent things live here:

1. **The static PWA** (`Caddyfile.kithmoot`, `deploy.sh`) - serving the app
   from a real domain so people other than you can open it.
2. **A default TURN server** (`coturn/`) - so calls survive the ~20% of
   real-world networks where STUN alone can't connect two peers directly.
3. **A TURN credential service** (`turn-credentials.service`, in the repo
   root's `server/`) - the only thing that lets a browser actually use #2;
   see "Minting TURN credentials for the browser" below.

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
this project and don't want to run TURN at all, delete `DEFAULT_TURN_URL`
from `app/src/main.ts` and rooms fall back to STUN-only, same as today.

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
`turnserver.conf` sets `user-quota`/`total-quota` - see the comments
there - and why the coturn container's actual data-plane cost is
bandwidth, not disk or CPU (coturn itself is a small binary; the box's
disk headroom here, ~6.6 GB free, is not the constraint).

Budget accordingly if this server gets real traffic: DigitalOcean droplets
come with a bandwidth allowance and overage billing past it. Watch the
droplet's bandwidth graph after this goes live, not just its disk.

## Prerequisites

- A subdomain for TURN - e.g. `turn.kithmoot.example` - with DNS A (and
  AAAA if the box has IPv6) records pointing at the DigitalOcean box.
  A separate subdomain from wherever the PWA is served, since it needs its
  own TLS cert and firewall rules.
- Docker + Docker Compose on the box (for coturn; the PWA itself is static
  files under Caddy, no container needed).
- A TLS certificate for the TURN subdomain. The simplest path, since Caddy
  already runs on this box and already gets certs automatically: give the
  TURN subdomain its own trivial Caddy site block that does nothing but
  hold the ACME challenge and let Caddy issue the cert, then point
  coturn's `cert`/`pkey` in `turnserver.conf` at the resulting files under
  `/etc/letsencrypt/live/turn.kithmoot.example/` (Caddy's own on-disk
  cert store is not in that format - use `certbot` directly for this one
  domain instead, the same way any other certbot-issued cert on this box
  would be obtained, or add a `tls` directive to a Caddy block for the
  subdomain and export from there if this box's Caddy build makes that
  easy; whichever it already does for other services here, match it).

## Firewall ports

Open these on the box's firewall (`ufw`, or DigitalOcean's cloud firewall,
or both - check which one is actually enforcing on this box before
assuming either is a no-op):

| Port(s)         | Protocol | Purpose                                    |
|-----------------|----------|---------------------------------------------|
| 3478            | TCP+UDP  | STUN/TURN, plaintext                        |
| 5349            | TCP      | TURN over TLS                               |
| 49152-49452     | UDP      | Relay range (`min-port`/`max-port` in `turnserver.conf`) |

The relay range is not optional to open - it's where the actual media
flows once an allocation is made. A closed relay range means the TURN
*handshake* succeeds (port 3478) but every call using it still fails,
which is a much more confusing failure mode than TURN not running at all.

## Deploying the PWA

```bash
# from a checkout of this repo, on your own machine - never on the box
DEPLOY_HOST=deploy@144.126.230.165 \
DEPLOY_KEY=~/.ssh/id_rsa_thecryptodonkey \
  deploy/deploy.sh --reload-caddy
```

This builds `app/dist` locally, rsyncs it to a new timestamped release
directory under `/srv/kithmoot/releases/` on the box, and atomically flips
`/srv/kithmoot/current` to point at it. See the comments at the top of
`deploy.sh` for the full sequence, the `--prune` flag, and why it's safe
to re-run.

Before the first deploy, install the vhost (see the comment block at the
top of `Caddyfile.kithmoot` for the exact steps - it needs a real hostname
substituted in, and to be wired into whatever this box's Caddy already
uses to include per-site config files) and make sure `/srv/kithmoot/`
exists and is writable by the `deploy` user:

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa_thecryptodonkey \
  deploy@144.126.230.165 'sudo mkdir -p /srv/kithmoot/releases && sudo chown -R deploy:deploy /srv/kithmoot'
```

## Deploying coturn

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa_thecryptodonkey -r \
  deploy/coturn deploy@144.126.230.165:~/kithmoot-coturn

ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa_thecryptodonkey deploy@144.126.230.165
```

Then, on the box:

1. Edit `~/kithmoot-coturn/turnserver.conf`: replace every `CHANGE_ME`
   (realm/server-name, cert paths, `static-auth-secret`). Generate the
   secret with `openssl rand -hex 32` and keep a copy of it somewhere
   safe - the same value goes into `TURN_SECRET` for the credential
   service below (`server/turn-credentials.mjs`), which is what actually
   calls `mintTurnCredential` (`src/turn.ts`) on a browser's behalf. See
   "Minting TURN credentials for the browser" further down.
2. Edit `docker-compose.yml`: replace `CHANGE_ME` in the cert volume
   mount to match the real TURN hostname.
3. `cd ~/kithmoot-coturn && docker compose up -d`
4. `docker compose logs -f` - watch for startup errors (a missing cert
   file is the most likely one at this point).

## Verifying TURN actually works

Getting this wrong is easy and silent: a browser can establish a call
using only STUN-discovered `srflx` (server-reflexive) candidates on your
own network and look completely healthy, while still failing for the next
real user on a stricter network, because your test never needed the relay
candidate at all.

Use a trickle-ICE tester against the exact TURN URL and credentials you
intend to ship - either https://icetest.info or the WebRTC project's own
[trickle-ice sample](https://webrtc.github.io/samples/src/content/peerconnections/trickle-ice/).
Enter:

- STUN URL: `stun:turn.kithmoot.example:3478`
- TURN URL: `turn:turn.kithmoot.example:3478`, plus username/credential
  from a `mintTurnCredential(...)` call (or a manually-computed pair per
  `deploy/turn-credentials.md`, for a quick manual check)
- TURNS URL (optional but worth testing): `turns:turn.kithmoot.example:5349`

**A healthy result shows at least one candidate of type `relay`.** A
`host` candidate (your own local address) and a `srflx` candidate (what
STUN found) proving out is not enough - those two prove your network path
works, not that TURN does. If gathering finishes with only `host` and
`srflx` candidates and no `relay` one, TURN is not reachable or not
authenticating: check the firewall ports above first (a closed relay range
is the single most common cause), then the container logs, then the
credential (an expired or wrongly-computed one fails silently from the
browser's point of view - it just never gets a relay candidate).

## Minting TURN credentials for the browser

coturn above only checks credentials - something else has to hand a
browser a fresh `{username, credential}` pair before it can use the
server at all. That something is `server/turn-credentials.mjs`: a small
Node HTTP service, using `mintTurnCredential` (`src/turn.ts`) against the
same `static-auth-secret` as `turnserver.conf`, that `app/src/main.ts`
fetches from at join time (see `TURN_CREDENTIAL_ENDPOINT` there) whenever
a room is using this default TURN server rather than one of its own. A
failed or unreachable fetch never blocks joining - the room just falls
back to STUN-only, same as if `DEFAULT_TURN_URL` were never set.

### Generating and placing the secret

```bash
openssl rand -hex 32
```

This one value goes in exactly two places, and must match between them:

- `static-auth-secret=` in `deploy/coturn/turnserver.conf` (coturn's copy)
- `TURN_SECRET` in the credential service's `EnvironmentFile` (its copy)

Nowhere else. It never appears in `app/src/main.ts` or anything shipped to
a browser - see `deploy/turn-credentials.md` for why a static credential
in the client bundle is the thing this whole scheme exists to avoid.

### Installing the credential service

Full step-by-step install, including the dedicated user, the
`EnvironmentFile` layout, and how to verify it, lives in the comment block
at the top of `deploy/turn-credentials.service` - copy that file to
`/etc/systemd/system/` and follow it. In short:

```bash
# on the box, in a checkout of this repo (e.g. /opt/kithmoot)
npm ci && npm run build:lib   # produces dist/src/turn.js - repeat after every pull
sudo cp deploy/turn-credentials.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now turn-credentials
```

`deploy/Caddyfile.kithmoot` reverse-proxies `/turn` and `/healthz` on the
app's own domain to this service (which listens on `127.0.0.1:8089` only -
never exposed directly) - re-run the Caddy install step above if it's
already deployed, so the updated vhost picks up those routes.

### Verifying the credential service end to end

```bash
curl -s https://kithmoot.example/healthz                                    # -> ok
curl -s https://kithmoot.example/turn -H 'Origin: https://kithmoot.example' # -> {"urls":[...],"username":"...","credential":"...","ttl":3600}
```

Then feed that `urls`/`username`/`credential` triple into the trickle-ICE
tester from the section above and confirm a `relay` candidate still
appears - the credential service answering with valid JSON is necessary
but not sufficient; the round trip through actual coturn auth is the real
test.

Once that's confirmed, uncomment `DEFAULT_TURN_URL` **and**
`TURN_CREDENTIAL_ENDPOINT` together in `app/src/main.ts` (they're designed
to be switched on as a pair - see the comment there) and redeploy the PWA.

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

None of these ship in this kit today - `server/turn-credentials.mjs` mints
on request to anyone who can reach it, by design, so the choice above is
made deliberately rather than defaulted into.
