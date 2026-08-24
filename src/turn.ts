import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/legacy'
import { base64 } from '@scure/base'

export interface TurnCredential {
  username: string
  credential: string
}

const DEFAULT_NAME = 'kithmoot'

/**
 * Mints a time-limited TURN credential per coturn's `use-auth-secret` REST
 * convention (https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api).
 *
 * `username` is `<expiry-unix>:<name>`; coturn reads the leading integer
 * back out as the credential's expiry and refuses a request made after it,
 * without either side storing anything. `credential` is
 * HMAC-SHA1(secret, username), base64-encoded - the same computation coturn
 * re-runs itself against its own copy of the secret when a client connects.
 *
 * This is why the deploy kit mints credentials per-viewer instead of
 * shipping one static TURN username/password: a static pair that leaks (a
 * bundle, a network trace) is usable forever and its bandwidth is stolen
 * indefinitely. A minted one expires on its own, no revocation needed.
 *
 * HMAC-SHA1 is what coturn's REST scheme specifies - not a free choice, and
 * not weakened by SHA-1's known collision weaknesses, which do not apply to
 * HMAC (see RFC 6151).
 */
export function mintTurnCredential(
  secret: string,
  ttlSeconds: number,
  now: number,
  name: string = DEFAULT_NAME,
): TurnCredential {
  const expiry = Math.floor(now) + Math.floor(ttlSeconds)
  const username = `${expiry}:${name}`
  const mac = hmac(sha1, secret, username)
  return { username, credential: base64.encode(mac) }
}
