/**
 * KithMoot's ICE default: no host outside the origin that served the room,
 * and no host outside what the room itself named.
 *
 * A room names its own STUN and TURN servers in its join URL, the way it
 * names its relays (see encodeRoomUrl and decodeExtras in
 * app/src/main.ts). This module is only what stands in for a room that
 * never set its own - and until 2026-09-13 that stand-in was
 * `stun:stun.l.google.com:19302`, hardcoded into every fresh install. That
 * named a specific third party by default, on every call, whether or not a
 * person ever chose it: Google learned the IP address and timing of every
 * call attempt made on defaults. See docs/decisions.md, 2026-09-13, for the
 * full finding.
 *
 * The replacement is origin-relative rather than a different hardcoded
 * host: derive a STUN server from the room's own TURN endpoint when one
 * answers (coturn answers STUN on the same listener it answers TURN on -
 * deploy/coturn/turnserver.conf carries no `no-stun`), fall back to a
 * same-host guess on the standard port when it doesn't, and add nothing at
 * all on localhost, where host candidates already connect two processes on
 * one machine.
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
 * upgraded to this origin's own STUN/TURN rather than kept as Google's
 * server. A room that had deliberately and only ever named Google's STUN
 * server by itself cannot be told apart from that old default, and is
 * upgraded the same way - see docs/decisions.md, 2026-09-13.
 */
export const LEGACY_DEFAULT_ICE_URLS: string[] = ['stun:stun.l.google.com:19302']

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
 * This origin's own best guess at a STUN server: used only when a room is
 * on the ICE defaults (see isDefaultIceUrls) and no TURN credential could
 * be minted to derive one from with stunFromTurnUrl - the credential
 * endpoint is down, or this deployment runs without one.
 *
 * Guessed only for a non-loopback https origin, on deploy/README.md's
 * working assumption that an operator who follows it runs coturn on the
 * same box that serves the app, listening on the standard port 3478.
 * Wrong for a deployment that splits STUN onto a different host - but that
 * deployment already has a working TURN endpoint to derive from instead,
 * or names its own ICE servers rather than relying on this guess.
 *
 * A loopback origin gets nothing, on purpose: two processes on the same
 * machine connect on host candidates alone, and guessing a public STUN
 * host for `localhost` would still be naming an outside server on a
 * deployment that has none. A non-https origin gets nothing either - this
 * app's own TURN credential endpoint is same-origin and would refuse to
 * mix content anyway, so a guessed STUN host would be the only thing named
 * and unlikely to be reachable in the same way.
 */
export function originStunGuess(origin: { protocol: string; hostname: string }): string[] {
  if (origin.protocol !== 'https:' || isLoopbackHostname(origin.hostname)) return []
  return [`stun:${origin.hostname}:3478`]
}
