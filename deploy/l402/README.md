# A TURN endpoint that charges

`deploy/README.md` has a section called "The honest cost of an unauthenticated
endpoint". It lists three ways to stop strangers relaying their own traffic
through this operator's coturn, says none of them ship, and leaves the choice
open. This kit is a fourth: **make the credential cost a satoshi or two.**

That is not a business model bolted onto a security problem. It is the same
answer to both. A per-IP rate limiter is a speed bump because requests are
free; the moment a credential costs something, an attacker's bandwidth theft
has a price list, and the arithmetic below is the whole control.

## What this does not change

**`kithmoot.forgesworn.dev/turn` stays free and stays exactly as it is.** One
tap from a link in a Signal group is the product. It must not grow a payment
prompt, and nothing in this kit touches the app, `src/`, or the vhost that
serves it.

This kit stands up a **second, separate** TURN endpoint on its own host, behind
L402. A room can name it because a room already names its STUN and TURN servers
as a plural, swappable list carried in the join URL - so a paid provider is
just another entry, and swapping it out is one config change. That is what
makes charging for it honest: nobody is captive, including the people who
choose it.

It also means anybody else can run this. The kit is MIT like the rest, the
service announces itself on Nostr (below), and a second provider undercutting
this one is the system working, not a leak.

## Who pays, and why it is not the browser

The obvious design - browser gets a 402, browser pays - is wrong here, and it
is worth saying why before anyone builds it.

A guest was sent a link. They tap it and they are in. If joining can produce a
payment prompt, then the one property this project has over Zoom is gone for
exactly the people it was for. **A participant must never be asked to pay to
be in a room.**

So the payer is the room, not the person, and in this first version the room
means **the keeper**:

- A keeper (`kithmoot-agent create`, `deploy/keeper-deploy.sh`) already runs
  24/7, already holds room state across restarts, and already writes the room
  descriptor that names forwarders and ICE servers.
- It is therefore the natural place to hold an NWC connection (`nwc-kit`) and
  the only process in the system with a reason to have a wallet.
- It fetches an L402-gated credential, pays the invoice, and puts the result
  in the room descriptor where every device already looks for it.

Guests see a TURN server. They do not see a payment, an account, or a wallet.

The step after this one is bearer notes (`lnurlcash-kit`): the room carries a
float minted once, riding inside the room-key ciphertext alongside the roster
and the chat, split on demand and verified offline by the provider. That
removes the keeper as a single payer and removes the invoice-at-connection-time
metadata leak described under "What paying reveals" below. It is not built.
This kit is the layer under it.

## The arithmetic, which is the actual control

A credential is one hour (`TURN_TTL_SECONDS=3600`). An hour of relayed video
at a legible bitrate is roughly:

| Relayed at | For an hour | Marginal cost at Hetzner egress |
|---|---|---|
| Opus voice, ~32 kbps | ~14 MB | negligible |
| Video 360p, ~600 kbps | ~270 MB | ~£0.0002 |
| Screen share, ~1.5 Mbps | ~675 MB | ~£0.0006 |

Egress past the included allowance is about £1 per TB, so the marginal cost of
one credential is a fraction of a penny. **Pricing for margin is pointless.**

The cost that is real is the allowance itself - 20 TB on a typical box, gone in
about 30,000 abusive credentials. So price to make that expensive:

> **10 sats per credential.** Saturating a 20 TB allowance then costs an
> attacker roughly 300,000 sats. At £60,000/BTC that is about £180 to burn an
> allowance worth about £20, which is the point.

A legitimate room on a long call pays 10 sats an hour, per pair that actually
needed a relay - which, given peer assist tries the room's own members first,
is the residual and not the common case. Set `price` in `aperture.yaml`.

`auth: "freebie 3"` gives the first three requests free, so somebody can try
the endpoint before paying for it.

## Standing it up

Everything here is verified against `aperture-phoenixd`'s own working
`deploy/` (same `dbbackend: sqlite`, same authenticator block, same compose
shape), with the service definition changed to point at KithMoot's credential
minter instead of its echo server.

```
browser or keeper
      |
      v
 Caddy (turn.forgesworn.dev)     deploy/l402/Caddyfile.turn-paid
      |
      v
 Aperture :8081  <---- invoices ---->  Phoenixd :9740
      |                                 deploy/l402/aperture.yaml
      v
 turn-credentials.mjs :8089            the existing minter, unchanged
      |
      v
 coturn                                the existing coturn, unchanged
```

1. **Have the free side working first.** This proxies
   `server/turn-credentials.mjs`; if `/turn` does not already mint on the box,
   fix that before adding a paywall to it. `deploy/turn-deploy.sh`.
2. **Patch and build Aperture.** `aperture-phoenixd` is an adapter, not a
   fork: apply `testdata/aperture-patch.diff` to
   `github.com/lightninglabs/aperture` and build. That is the ~20-line diff
   adding `phoenixdurl` and `phoenixdpassword` to `AuthConfig`.
3. **Set the password.** `PHOENIXD_PASSWORD` in a `.env` beside the compose
   file, mode 0600. Phoenixd generates it into `~/.phoenix/phoenix.conf` on
   first run.
4. **Bring it up.** `docker compose up -d` from this directory.
5. **Install the vhost.** `Caddyfile.turn-paid` as an additive drop-in under
   `/etc/caddy/conf.d/`, the same pattern `deploy/deploy.sh --install-caddy`
   uses. Validate the whole config before reloading: a broken drop-in takes
   every site on the box down.
6. **Announce it.** `./announce.sh`. Publishes a kind 31402 event so the
   endpoint is discoverable on [402.pub](https://402.pub/) and payable by any
   `402-mcp` client without anybody being told a URL.

Verify:

```bash
curl -i https://turn.forgesworn.dev/turn
# expect: 402 Payment Required, with a WWW-Authenticate: L402 ... header
```

A 200 with a credential means Aperture is not in the path, or the freebie
allowance has not been spent yet.

## What is not verified here

Stated before anyone finds it:

- **Nothing in this kit has been run.** The config is derived from a working
  one in another repo, not from a live KithMoot deployment. Treat the first
  `docker compose up` as the test.
- **The Aperture patch is against an unpinned upstream.** `aperture-patch.diff`
  carries `@@ -XX` hunk headers rather than real line numbers, so it is a guide
  to the change, not a patch that applies cleanly. Expect to make the edit by
  hand and pin the Aperture commit you built from.
- **`strictverify` must stay false.** Phoenixd's WebSocket does not emit the
  invoice cancellation events full status tracking needs. The security model
  is macaroon plus preimage, which is Aperture's default and is fine here -
  but do not turn it on expecting it to work.
- **Nothing is wired to pay this yet.** `src/node/l402.ts` is the client half
  - it answers a 402, checks the amount against a cap, pays through a `Payer`
  (`nwcPayer` adapts `nwc-kit` in three lines) and re-sends the token rather
  than paying twice. It is tested and it is not *called* by anything: the
  keeper does not yet fetch a credential or put one in the room descriptor.
  Until it does, this endpoint's users are `402-mcp`, `curl`, or a few lines
  of Node. The browser is deliberately not on that list and should stay off
  it - `src/node/` never reaches the app bundle.
- **What paying reveals.** An invoice settled at the moment a pair needs a
  relay is a timestamped event linking a payer to a call. It does not name the
  room - the credential minter never learns a room id, and coturn sees only an
  allocation - but it is a correlation the rest of this architecture works hard
  to avoid, and it is the strongest argument for moving to pre-minted bearer
  notes rather than per-connection invoices.
- **Phoenixd holds funds on the box.** This is a hot wallet on a public-facing
  host. Keep the balance at what you would be relaxed about losing, and sweep
  it.

## Files

| File | What it is |
|---|---|
| `aperture.yaml` | Aperture config: the `/turn` service, its price, its freebie |
| `docker-compose.yml` | Phoenixd and Aperture, loopback-bound |
| `Caddyfile.turn-paid` | The public vhost, an additive drop-in |
| `announce.sh` | Publishes the kind 31402 announcement to Nostr |
