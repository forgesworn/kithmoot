/**
 * Generation ownership and glare: section 3.3 of the call reliability design,
 * as a pure function.
 *
 * H2 is a pair whose two ends disagree about which connection they are on.
 * Nothing on the profile-1 wire says: an offer describes a session, not which
 * session, so a side that rebuilt its connection and a side that did not both
 * believe they are talking to each other while `setRemoteDescription` rejects
 * everything - each of them on its own rest timer, chasing the other round the
 * route ladder for the rest of the call.
 *
 * A generation is the missing sentence. An offer opens one; a rebuild always
 * goes to `max(local, lastSeenRemote) + 1`; a higher generation always wins
 * and always cancels the loser's timers. That is what makes convergence a
 * property of the numbering rather than of who happened to be quickest, and
 * it is why there is no negotiation anywhere about who negotiates.
 *
 * Kept here, away from the connection, because the table is the part that is
 * worth reading on its own and the part a test should be able to drive
 * exhaustively without a single `RTCPeerConnection`.
 */

/** What this side is currently owed an answer for. */
export type OutstandingOffer =
  /** Nothing outstanding: this side is not waiting on anybody. */
  | 'none'
  /** An offer that opened the current generation, and so created this
   *  connection's four transceivers. Amendment A1's case. */
  | 'opening'
  /** An offer inside a generation that is already established - an ICE
   *  restart. The slots already exist and nothing new was created for it. */
  | 'in-generation'

export interface GenerationInput {
  /** The `gen` on the incoming signal. */
  incomingGen: number
  /** The generation this side's current connection belongs to. */
  currentGen: number
  /** The `conn` on the incoming signal, when it carried one. */
  incomingConn: string | undefined
  /** The remote connection this side's channel is bound to, if it has
   *  learned one yet. */
  boundConn: string | undefined
  outstanding: OutstandingOffer
  /** This side's perfect-negotiation politeness, decided by pubkey order. */
  polite: boolean
  /** Whether the incoming offer carries a `slots` map, i.e. whether it opens
   *  a generation. */
  opensGeneration: boolean
}

export type GenerationAction =
  /** Older than ours: drop it and tell the far end where we are. One `sync`
   *  per two seconds, which the channel rate limits. */
  | { do: 'sync' }
  /** Newer than ours: abandon everything local and answer it on a fresh
   *  connection at that generation. */
  | { do: 'adopt'; gen: number }
  /** Ordinary perfect negotiation inside the generation we are already on. */
  | { do: 'negotiate' }
  /** Glare, and we are impolite: keep retransmitting our own and say
   *  nothing. */
  | { do: 'ignore' }
  /**
   * Glare on a generation-opening offer, and we are polite.
   *
   * Amendment A1: a rollback does not release the four transceivers this side
   * opened, so rolling back and answering would leave the far end's four
   * m-lines with nowhere to go and the browser would invent four more.
   * Discarding the connection object is the only thing that actually gives
   * them up.
   */
  | { do: 'rebuild-connection' }
  /**
   * Glare inside an established generation, and we are polite.
   *
   * Nothing was created for an in-generation offer - the slots have existed
   * since the generation opened - so A1's reason does not apply and ordinary
   * rollback is both correct and much cheaper than throwing away a connection
   * that is carrying media.
   */
  | { do: 'rollback' }
  /** Same generation, a connection we have never heard of, and nothing
   *  outstanding to explain it. A protocol error; the repair is to go up. */
  | { do: 'rebuild-generation'; gen: number }

/** Where a rebuild goes. Never reuses a number, on either side, whatever
 *  order the two sides rebuilt in. */
export function nextGeneration(localGen: number, lastSeenRemoteGen: number): number {
  return Math.max(localGen, lastSeenRemoteGen, 0) + 1
}

/**
 * The table of section 3.3, for an incoming **offer**.
 *
 * Answers and candidates need none of this: they belong to an offer that has
 * already been judged, and the reliable channel's `(conn, seq)` ordering is
 * what keeps them with it.
 */
export function decideOffer(input: GenerationInput): GenerationAction {
  const { incomingGen, currentGen, incomingConn, boundConn, outstanding, polite, opensGeneration } = input

  if (incomingGen < currentGen) return { do: 'sync' }
  if (incomingGen > currentGen) return { do: 'adopt', gen: incomingGen }

  if (outstanding !== 'none') {
    // Glare. Politeness is decided by pubkey order and the two sides reach
    // opposite answers without exchanging a word about it.
    if (!polite) return { do: 'ignore' }
    return outstanding === 'opening' && opensGeneration ? { do: 'rebuild-connection' } : { do: 'rollback' }
  }

  // Nothing outstanding, so this is the far end renegotiating on a connection
  // we should already know about.
  if (incomingConn !== undefined && boundConn !== undefined && incomingConn !== boundConn) {
    return { do: 'rebuild-generation', gen: nextGeneration(currentGen, incomingGen) }
  }
  return { do: 'negotiate' }
}
