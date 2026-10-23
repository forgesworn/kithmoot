# TURN credentials

Browser issuer contract, updated 23 October 2026: the configured endpoint must
return `application/json` containing only `urls`, `username`, `credential` and
an integer `ttl` from 3,600 to 86,400 seconds (optional
`credentialType: "password"`). `ttl` is the remaining credential lifetime in
seconds. The existing client refreshes every forty minutes; shorter leases
need a different scheduler and are refused. Responses are bounded to 16 KiB
and four seconds. The endpoint is a same-origin absolute path or HTTPS URL
without userinfo, query or fragment; redirects, cookies and referrers are
disabled. A managed provider's API key and raw response wrapper are not this
contract: keep its root key server-side and return only a temporary client
login. See [the independent deployment model and limitations](../docs/research/automatic-guest-transport-20261023.md).

coturn is configured (`deploy/coturn/turnserver.conf`) for `lt-cred-mech` +
`use-auth-secret` - the REST API credential scheme. Not static
username/password: a static TURN password baked into a browser bundle is
public the moment the bundle ships, and a public TURN credential gets
scraped and used to relay someone else's traffic on your bandwidth bill,
indefinitely, with no way to revoke it short of rotating the password for
every legitimate client too. A time-limited credential expires on its own.

## How it works

Both sides - whoever mints the credential, and coturn checking it - do the
same computation, and never exchange anything but the result:

```
expiry     = now + ttlSeconds                    (unix seconds)
username   = "<expiry>:<name>"
credential = base64( HMAC-SHA1( staticAuthSecret, username ) )
```

`staticAuthSecret` is `static-auth-secret` from `turnserver.conf` - it never
leaves the server that mints credentials. `name` is any label (a session id,
a fresh random label) that distinguishes simultaneous browser allocations; it
carries no authority of its own. coturn accepts the pair if the HMAC checks
out *and* the leading timestamp in `username` hasn't passed - so an expired
credential fails even if nothing else about it changed.

## Worked example

```
staticAuthSecret = "my-shared-secret"
now              = 1735689600   (2025-01-01T00:00:00Z)
ttlSeconds       = 86400        (1 day)

expiry   = 1735689600 + 86400 = 1735776000
username = "1735776000:kithmoot"

credential = base64( HMAC-SHA1("my-shared-secret", "1735776000:kithmoot") )
           = "6ALV1ws8NhxOgTy3BzMBan5OyVQ="
```

Verified independently against Node's `crypto` module:

```js
crypto.createHmac('sha1', 'my-shared-secret')
  .update('1735776000:kithmoot')
  .digest('base64')
// -> '6ALV1ws8NhxOgTy3BzMBan5OyVQ='
```

and matches `mintTurnCredential('my-shared-secret', 86400, 1735689600)` in
`src/turn.ts` (see `src/turn.test.ts` for the same vector as a regression
test).

## Minting a credential for a browser client

`src/turn.ts` exports `mintTurnCredential(secret, ttlSeconds, now, name?)`.
It returns `{ username, credential }` - hand that pair to the browser as an
ICE server entry:

```ts
import { mintTurnCredential } from '../src/turn.js'

const { username, credential } = mintTurnCredential(
  process.env.TURN_SECRET!,   // static-auth-secret, server-side only
  3600,                        // 1 hour - long enough for a call, short
                                // enough that a leaked credential decays fast
  Math.floor(Date.now() / 1000),
)

const iceServer = {
  urls: 'turn:kithmoot.example:3478',
  username,
  credential,
}
```

**The secret never reaches the browser.** Minting has to happen somewhere
that holds `TURN_SECRET` - a small server-side endpoint, a serverless
function, anything that isn't the client bundle. `server/turn-credentials.mjs`
is that endpoint for a deployer's own TURN server: a small Node HTTP
service that calls `mintTurnCredential` and returns JSON, which
`app/src/main.ts` fetches from at join time only when the app was built
with `VITE_TURN_CREDENTIAL_ENDPOINT` (there is no default) (see
`deploy/README.md`, "Minting TURN credentials for the browser", for install
and verification steps, and the cost of leaving it unauthenticated).
Rooms with custom ICE hints bypass this endpoint. An authenticated relay
can instead be chosen in each device's Connections settings; that device
choice takes precedence. Never bake TURN logins, provider API keys or issuer
access tokens into room links or ICE hint URLs. An issuer URL is separate
deployment configuration, not a TURN URL or a room-admission credential.

A bounded TTL limits exposure if a credential response or browser session
is compromised. The browser needs this login to authenticate to TURN; the
client does not deliberately distribute it to other room participants.
Keep issuer/master secrets server-side, mint separate temporary client
logins and refresh within their actual lifetime. Expiry does not promise
immediate termination of an established allocation or per-login revocation.
