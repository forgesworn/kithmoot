import type { PeerContext, PeerFactory, RTCPeerConnectionLike } from '../peer.js'

/** An ICE server as werift takes it: one url per entry. */
export interface IceServer {
  urls: string
  username?: string
  credential?: string
}

/** One resolved set of ICE servers: STUN and TURN urls together, and the
 *  one credential pair (if any) that every `turn:`/`turns:` url among them
 *  needs. Returned by both a static config and a refreshing one - see
 *  `WeriftFactoryOptions.refresh` below and `resolveNodeIceServers` in
 *  `ice-resolve.ts`. */
export interface IceResolution {
  iceUrls: string[]
  turn?: { username: string; credential: string }
}

export interface WeriftFactoryOptions {
  /** STUN and TURN urls, in the shape a room link carries them. Ignored
   *  once `refresh` is given - that becomes the sole source, so the two
   *  are not merged and quietly disagree with each other. */
  iceUrls?: string[]
  /** Credentials for every TURN url in `iceUrls`. A room's TURN is normally
   *  minted per viewer by the app's credential endpoint; an agent that
   *  needs TURN is handed a static pair instead, and that is a downgrade,
   *  stated plainly. Ignored once `refresh` is given, for the same reason
   *  as `iceUrls`. */
  turn?: { username: string; credential: string }
  /** Keeps the ICE configuration fresh for a long-running process, the
   *  Node equivalent of the web app's own 40-minute refresh against an
   *  hour-long minted TURN credential (`ICE_REFRESH_MS` in
   *  app/src/main.ts). `resolve` is called once immediately (its result
   *  becomes the first configuration, overriding `iceUrls`/`turn` above)
   *  and then again every `intervalMs` (default: the same 40 minutes). A
   *  failed refresh leaves the last good configuration in place - this
   *  never throws past its own timer, and only future connections see a
   *  refreshed list; a connection already open keeps what it negotiated
   *  with, exactly as in the browser. */
  refresh?: {
    resolve: () => Promise<IceResolution>
    intervalMs?: number
  }
}

/** Mirrors the browser's own ICE_REFRESH_MS (app/src/main.ts): a minted
 *  TURN credential lasts an hour, and this stays well inside that. */
export const DEFAULT_ICE_REFRESH_MS = 40 * 60 * 1000

function buildServers(urls: string[], turn: { username: string; credential: string } | undefined) {
  const isTurn = (url: string) => url.toLowerCase().startsWith('turn')
  const stun: IceServer[] = urls.filter((u) => !isTurn(u)).map((u) => ({ urls: u }))
  const turnServers: IceServer[] = urls
    .filter(isTurn)
    .map((u) => (turn ? { urls: u, username: turn.username, credential: turn.credential } : { urls: u }))
  return { stun, turnServers }
}

/**
 * A `PeerFactory` over werift, so a Node process can hold the same peer
 * connections a browser does.
 *
 * werift's `RTCPeerConnection` satisfies `RTCPeerConnectionLike` as it
 * stands - the forwarder has run on exactly this seam since it existed -
 * and the only thing this adds is the app's rule about ICE: TURN is handed
 * to a connection only on the TURN rung, because ICE will relay through any
 * TURN server it is given, and giving it one on the first attempt is how
 * "try direct first" stops meaning anything.
 *
 * ICE defaults to no STUN and no TURN at all when neither `opts.iceUrls`
 * nor `opts.refresh` names one: no server outside what the caller
 * explicitly configured, ever (see docs/decisions.md, 2026-09-13 - this
 * used to fall back to Google's public STUN server, which named a specific
 * third party to every agent and forwarder run with no `--ice`/
 * `KITHMOOT_ICE` set). The CLI (`src/node/cli.ts`) does not actually rely
 * on that bare default for a normal join or create any more - it derives
 * an origin-relative default via `resolveNodeIceServers`/`refresh` first,
 * the Node equivalent of the web app's own default (`ice-resolve.ts`,
 * `../ice-defaults.ts`) - so this fires only when there is truly nothing
 * to derive one from, or a caller (a test, a library consumer) builds a
 * factory directly with neither option set. Two peers on the same machine,
 * or with at least one publicly reachable, still connect on host
 * candidates alone; a process that needs to get through NAT and has
 * neither needs `--ice stun:host:3478` (or `turn:`) or `KITHMOOT_ICE`
 * pointing at a real server - see `--ice` in `kithmoot-agent --help` and
 * deploy/README.md. Logged plainly at start-up so a process that can't get
 * through NAT says why, rather than failing silently the way a missing
 * STUN server usually does.
 *
 * Loaded on demand, so a process that never opens a connection - an agent
 * that reads and writes the chat - never loads a WebRTC stack.
 */
export async function createWeriftFactory(opts: WeriftFactoryOptions = {}): Promise<PeerFactory> {
  const { RTCPeerConnection } = await import('werift')

  const initial: IceResolution = opts.refresh
    ? await opts.refresh.resolve()
    : { iceUrls: opts.iceUrls ?? [], turn: opts.turn }
  let { stun, turnServers } = buildServers(initial.iceUrls, initial.turn)
  if (initial.iceUrls.length === 0) {
    console.error(
      '[kithmoot-agent] no STUN or TURN server configured - connections will only succeed on host ' +
        "candidates (same machine, or a publicly reachable peer). Set --ice stun:host:3478 (or turn:), " +
        'or KITHMOOT_ICE, to get through NAT.',
    )
  }

  if (opts.refresh) {
    const intervalMs = opts.refresh.intervalMs ?? DEFAULT_ICE_REFRESH_MS
    const timer = setInterval(() => {
      opts.refresh!.resolve()
        .then((fresh) => {
          ;({ stun, turnServers } = buildServers(fresh.iceUrls, fresh.turn))
        })
        .catch(() => {
          // A refresh that fails leaves the last good configuration in
          // place - see the option's own doc comment above.
        })
    }, intervalMs)
    // Never the reason this process stays alive on its own.
    timer.unref?.()
  }

  return (context?: PeerContext) => {
    const iceServers = context?.tier === 'turn' ? [...stun, ...turnServers] : stun
    const pc = new RTCPeerConnection({ iceServers })
    return pc as unknown as RTCPeerConnectionLike
  }
}
