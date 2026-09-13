import type { PeerContext, PeerFactory, RTCPeerConnectionLike } from '../peer.js'

/** An ICE server as werift takes it: one url per entry. */
export interface IceServer {
  urls: string
  username?: string
  credential?: string
}

export interface WeriftFactoryOptions {
  /** STUN and TURN urls, in the shape a room link carries them. */
  iceUrls?: string[]
  /** Credentials for every TURN url in `iceUrls`. A room's TURN is normally
   *  minted per viewer by the app's credential endpoint; an agent that
   *  needs TURN is handed a static pair instead, and that is a downgrade,
   *  stated plainly. */
  turn?: { username: string; credential: string }
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
 * ICE defaults to no STUN and no TURN at all when `opts.iceUrls` names
 * neither: no server outside what the caller explicitly configured, ever
 * (see docs/decisions.md, 2026-09-13 - this used to fall back to Google's
 * public STUN server, which named a specific third party to every agent
 * and forwarder run with no `--ice`/`KITHMOOT_ICE` set). Two peers on the
 * same machine, or with at least one publicly reachable, still connect on
 * host candidates alone; a process that needs to get through NAT needs
 * `--ice stun:host:3478` (or `turn:`) or `KITHMOOT_ICE` pointing at a real
 * server - see `--ice` in `kithmoot-agent --help` and deploy/README.md.
 * Logged plainly at start-up so a process that can't get through NAT says
 * why, rather than failing silently the way a missing STUN server usually
 * does.
 *
 * Loaded on demand, so a process that never opens a connection - an agent
 * that reads and writes the chat - never loads a WebRTC stack.
 */
export async function createWeriftFactory(opts: WeriftFactoryOptions = {}): Promise<PeerFactory> {
  const { RTCPeerConnection } = await import('werift')
  const urls = opts.iceUrls ?? []
  if (urls.length === 0) {
    console.error(
      '[kithmoot-agent] no STUN or TURN server configured - connections will only succeed on host ' +
        "candidates (same machine, or a publicly reachable peer). Set --ice stun:host:3478 (or turn:), " +
        'or KITHMOOT_ICE, to get through NAT.',
    )
  }
  const isTurn = (url: string) => url.toLowerCase().startsWith('turn')
  const stun: IceServer[] = urls.filter((u) => !isTurn(u)).map((u) => ({ urls: u }))
  const turn: IceServer[] = urls
    .filter(isTurn)
    .map((u) => (opts.turn ? { urls: u, username: opts.turn.username, credential: opts.turn.credential } : { urls: u }))

  return (context?: PeerContext) => {
    const iceServers = context?.tier === 'turn' ? [...stun, ...turn] : stun
    const pc = new RTCPeerConnection({ iceServers })
    return pc as unknown as RTCPeerConnectionLike
  }
}
