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

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302'

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
 * Loaded on demand, so a process that never opens a connection - an agent
 * that reads and writes the chat - never loads a WebRTC stack.
 */
export async function createWeriftFactory(opts: WeriftFactoryOptions = {}): Promise<PeerFactory> {
  const { RTCPeerConnection } = await import('werift')
  const urls = opts.iceUrls?.length ? opts.iceUrls : [DEFAULT_STUN]
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
