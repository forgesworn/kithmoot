import { originStunGuess, stunFromTurnUrl } from '../ice-defaults.js'
import type { IceResolution } from './webrtc.js'

const FETCH_TIMEOUT_MS = 4000

interface TurnCredentialResponse {
  urls: string[]
  username: string
  credential: string
  ttl?: number
}

/**
 * Fetches one TURN credential from `<origin>/turn` - the same endpoint,
 * response shape and timeout budget as the web app's own
 * `fetchTurnCredential` in app/src/main.ts (see server/turn-credentials.mjs
 * for what answers it). A malformed or slow response is treated the same
 * as no endpoint at all: the caller decides the fallback.
 *
 * Sends no `Origin` header. A browser's fetch adds one automatically for a
 * cross-origin request; a plain Node fetch has none to add, because a Node
 * process is not a page with an origin of its own. `applyCors` in
 * server/turn-credentials.mjs treats a request with no `Origin` header as
 * "not a cross-origin browser request" and lets it through regardless of
 * `ALLOWED_ORIGINS` - that is an existing, documented property of the
 * endpoint (see the comment on `applyCors` there: "a caller that omits
 * Origin entirely bypasses this regardless"), not a hole this opens: a
 * `curl` from the box itself already has exactly the same access, and
 * CORS was only ever a check on what a *browser* running someone else's
 * page is allowed to read back, not a login. Setting an `Origin` header
 * here to the link's own origin would not gain anything - it would only
 * risk a 403 on a box whose `ALLOWED_ORIGINS` does not happen to list it -
 * so this deliberately sends none, the same as any other server-side
 * caller of this endpoint.
 */
async function fetchTurnCredential(origin: string, fetchImpl: typeof fetch): Promise<TurnCredentialResponse | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(new URL('/turn', origin).href, { signal: controller.signal })
    if (!res.ok) return undefined
    const body = (await res.json()) as Partial<TurnCredentialResponse>
    if (!Array.isArray(body.urls) || body.urls.length === 0 || !body.username || !body.credential) return undefined
    return { urls: body.urls, username: body.username, credential: body.credential, ttl: body.ttl }
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

export interface ResolveNodeIceOptions {
  /** The origin to derive STUN/TURN from - the room link's own origin for
   *  `join`, or `--base` for `create`. Anything `new URL` accepts as a
   *  base; only its `protocol`, `hostname` and origin are read. */
  origin: string
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The Node equivalent of `resolveIceServers` in app/src/main.ts, for an
 * agent or keeper joining or creating a room with no explicit `--ice` /
 * `KITHMOOT_ICE` and no ICE servers of the room's own to fall back to: it
 * derives this origin's own STUN/TURN rather than leaving the process on
 * host candidates alone, which is a real regression for an agent run on an
 * ordinary home connection behind NAT (docs/decisions.md, 2026-09-13,
 * covers why the old Google default was removed everywhere; this is what
 * replaces it here).
 *
 * Mirrors the browser's own priority order exactly: the minted TURN
 * credential's own host when `/turn` answers (`turn:host:port` becomes
 * `stun:host:port`, via `stunFromTurnUrl` - coturn answers STUN on the
 * same listener it answers TURN on), or a same-host guess on the standard
 * port 3478 when it doesn't, restricted to a non-loopback `https:` origin
 * exactly as `originStunGuess` restricts it for the browser. Never throws:
 * a fetch failure, a bad response, or a plain `http:`/loopback origin all
 * just mean less to offer, the same as an unreachable credential endpoint
 * does for the web app. Logs nothing itself - `createWeriftFactory` is the
 * one place that logs "nothing configured", since it is the one that knows
 * whether the final resolved list actually ended up empty.
 */
export async function resolveNodeIceServers(opts: ResolveNodeIceOptions): Promise<IceResolution> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const origin = new URL(opts.origin)

  const credential = await fetchTurnCredential(origin.origin, fetchImpl)
  if (credential) {
    const stunUrls = [...new Set(credential.urls.map(stunFromTurnUrl).filter((u): u is string => u !== undefined))]
    return {
      iceUrls: [...stunUrls, ...credential.urls],
      turn: { username: credential.username, credential: credential.credential },
    }
  }

  return { iceUrls: originStunGuess(origin) }
}
