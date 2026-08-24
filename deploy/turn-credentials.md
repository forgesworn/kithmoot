# TURN credentials

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
a device pubkey, anything) that's useful for identifying traffic in logs; it
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
  urls: 'turn:turn.kithmoot.example:3478',
  username,
  credential,
}
```

**The secret never reaches the browser.** Minting has to happen somewhere
that holds `TURN_SECRET` - a small server-side endpoint, a serverless
function, anything that isn't the client bundle. KithMoot ships no such
endpoint today: this repo's ICE defaults are STUN-only
(`app/src/main.ts`), and turning on the default TURN server means standing
up *some* minting step of your own, then putting the resulting `turn:` URL
(with credentials baked in, or a link to your own minting endpoint) into a
room's ICE server list the same way any other custom ICE server goes in -
see `DEFAULT_TURN_URL` in `app/src/main.ts` and the README for where that
one line lives.

A short TTL is the main defence once a credential is out - it's sent to
every peer in a room's signalling, and once your process discloses it
(as it must, for WebRTC to use it) it can't be recalled. Mint short, mint
often, and never reuse one credential across sessions if you can avoid it.
