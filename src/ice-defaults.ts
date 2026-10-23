/**
 * KithMoot's ICE default: a public STUN server run by somebody else, and no
 * host outside what the room itself named.
 *
 * A room names its own STUN and TURN servers in its join URL, the way it
 * names its relays (see encodeRoomUrl and decodeExtras in
 * app/src/main.ts). This module is only what stands in for a room that
 * never set its own.
 *
 * Until 2026-09-13 that stand-in was `stun:stun.l.google.com:19302`. It was
 * then derived from the origin that served the app, which on the public
 * host meant ForgeSworn's own STUN server. Since 2026-10-23 the publisher
 * runs no default servers of its own (docs/decisions.md, 2026-10-23), so
 * the stand-in is Cloudflare's public STUN server: `DEFAULT_STUN_URLS`.
 * Any STUN server learns the IP address and timing of a call attempt, so
 * the choice is named on the privacy page; Google stays out under the
 * 2026-10-19 rule.
 *
 * A deployment that mints its own TURN credential still uses its own
 * servers: when its `/turn` answers, STUN is derived from the minted TURN
 * URL (stunFromTurnUrl; coturn answers STUN on the same listener) and the
 * stand-in is not used. Localhost and plain http get nothing at all, where
 * host candidates already connect two processes on one machine, and tests
 * stay off the network.
 *
 * This module has no runtime dependency of its own - no DOM, no Node
 * builtin - so both callers that actually fetch a TURN credential share it:
 * `resolveIceServers` in app/src/main.ts (the browser, reading
 * `location`), and `resolveNodeIceServers` in src/node/ice-resolve.ts (a
 * long-running agent or keeper, reading the room link's or `--base`'s
 * origin instead of `location`, since a Node process has neither). Kept
 * here, in the shared library, rather than under app/src, precisely
 * because both need it.
 */

/**
 * The literal STUN URL this app used to hand out as its own default,
 * before this origin started deriving one instead. Every join URL encoded
 * under the old default carried exactly this one entry and nothing else in
 * its ICE hint - encodeRoomUrl never wrote anything else for a room that
 * had not named its own servers - so a link carrying only this one URL is
 * indistinguishable from "this room never named its own ICE servers", and
 * isDefaultIceUrls below treats it exactly the same way: as the default,
 * upgraded to the current stand-in rather than kept as Google's server. A room that had deliberately and only ever named Google's STUN
 * server by itself cannot be told apart from that old default, and is
 * upgraded the same way - see docs/decisions.md, 2026-09-13.
 */
export const LEGACY_DEFAULT_ICE_URLS: string[] = ['stun:stun.l.google.com:19302']

/**
 * The public STUN server a room on the defaults uses: Cloudflare's, which
 * needs no account. It tells a device its own public address and carries
 * no content. Named on the privacy page; see the module comment above.
 */
export const DEFAULT_STUN_URLS: readonly string[] = Object.freeze(['stun:stun.cloudflare.com:3478'])

/**
 * This app's own ICE default: no host named at all. A room that has never
 * set its own ICE servers carries this, and resolveIceServers derives
 * whatever this origin can offer at connect time - see the module comment
 * above.
 */
export const DEFAULT_ICE_URLS: string[] = []

/**
 * True when `urls` is the built-in default - either the current empty
 * default, or the old literal Google default a link made before this
 * origin started deriving its own still carries. Compared by content, not
 * by reference. A room that named other servers - including Google's STUN
 * server alongside anything else - keeps exactly what it named.
 */
export function isDefaultIceUrls(urls: string[]): boolean {
  if (urls.length === 0) return true
  return urls.length === LEGACY_DEFAULT_ICE_URLS.length && urls.every((u, i) => u === LEGACY_DEFAULT_ICE_URLS[i])
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** True for a hostname that only ever means "this machine" - a STUN or TURN
 *  hint aimed at one of these would be naming this same device to itself. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

/**
 * Derives the `stun:` URL for the same host and port as a plain `turn:`
 * URL, e.g. `turn:example.com:3478` becomes
 * `stun:example.com:3478`. coturn answers a STUN Binding request on
 * exactly the listener it answers a TURN Allocate on, so a URL already
 * known to work for this room's minted TURN credential is a safer guess
 * for STUN than a bare hostname guess would be (see originStunGuess,
 * below, for that guess). Any `?transport=...` suffix is TURN-only and is
 * dropped.
 *
 * A `turns:` URL is deliberately not converted into `stuns:`. STUN over
 * TLS is an optional browser protocol and Safari rejects an
 * RTCPeerConnection configuration containing it with NotSupportedError.
 * The original `turns:` URL remains in the returned TURN server, with its
 * credential, so this only avoids inventing an unnecessary and less
 * interoperable extra URL. Returns undefined for anything except `turn:`.
 */
export function stunFromTurnUrl(turnUrl: string): string | undefined {
  const match = /^turn:(.+)$/i.exec(turnUrl.trim())
  if (!match) return undefined
  const hostAndPort = match[1].split('?')[0].trim()
  if (!hostAndPort) return undefined
  return `stun:${hostAndPort}`
}

/**
 * Removes a redundant plain TURN/TCP alternative from the operator's
 * browser default. WebKit rejects the otherwise standard
 * `turn:host:port?transport=tcp` spelling with SyntaxError. The deployment
 * also supplies `turns:` on its TLS listener, which is TURN over TCP with
 * transport security, so omitting the rejected plain-TCP alternative still
 * leaves both UDP TURN and firewall-friendly TCP TURN available.
 *
 * This applies only to URLs returned by this origin's `/turn` endpoint.
 * Room-authored ICE hints remain the room author's explicit choice.
 */
export function browserDefaultTurnUrls(urls: string[]): string[] {
  return urls.filter(url => !/^turn:[^?]+\?transport=tcp$/i.test(url.trim()))
}

/**
 * The STUN stand-in for a room on the ICE defaults (see isDefaultIceUrls)
 * when no TURN credential could be minted to derive one from with
 * stunFromTurnUrl: the public host has no `/turn`, or a deployment runs
 * without one. Returns DEFAULT_STUN_URLS, somebody else's server, never a
 * guess at a server on the origin itself: the publisher runs no default
 * servers (docs/decisions.md, 2026-10-23). The name is historical.
 *
 * A loopback origin gets nothing, on purpose: two processes on the same
 * machine connect on host candidates alone, and naming a public STUN host
 * for `localhost` would send local development and every test to an
 * outside server. A non-https origin gets nothing either: it cannot hold a
 * camera or microphone outside localhost, so it cannot make a call.
 */
export function originStunGuess(origin: { protocol: string; hostname: string }): string[] {
  if (origin.protocol !== 'https:' || isLoopbackHostname(origin.hostname)) return []
  return [...DEFAULT_STUN_URLS]
}
