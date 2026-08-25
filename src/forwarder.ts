import { hexEquals, normaliseHex } from './hex.js'
import type { ForwarderRef } from './types.js'

export type { ForwarderRef } from './types.js'

/**
 * A local, measured view of what this device is being asked to send.
 *
 * `peers` is the number of OTHER devices being sent to, so mesh cost is
 * `peers x perPeerBps` directly - the `(N-1)` is already applied by the
 * caller counting the room minus itself.
 */
export interface CapacityEstimate {
  /** Measured upload capacity, bits per second. */
  uplinkBps: number
  /** How many other devices this one is sending to. */
  peers: number
  /** Measured or configured send bitrate per peer, bits per second. */
  perPeerBps: number
}

/**
 * How much of the measured uplink a mesh may claim before a forwarder is
 * wanted.
 *
 * Promotion has to happen while the connection still works, not after it has
 * stopped: at 100% of the uplink a domestic link is already dropping packets,
 * bufferbloat has already added hundreds of milliseconds, and the switch to a
 * forwarder then happens across a link too congested to complete it. 0.8
 * leaves a fifth of the uplink for ACKs, retransmits, and everything else on
 * the household's connection.
 */
export const DEFAULT_HEADROOM = 0.8

function requireFiniteNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`capacity estimate has an unusable ${what}`)
  }
}

/**
 * Decide whether this device's uplink can carry the mesh, or whether the room
 * needs a forwarder in the path.
 *
 * **This is a capacity question, never a headcount question.** Mesh upload is
 * `(N-1) x bitrate`, and the two terms trade off completely: twenty people on
 * Opus voice cost 0.64 Mbps and need nothing, while two people sharing legible
 * 1080p screens cost 4 Mbps and can already be past a slow uplink. Any rule of
 * the form "more than N people means forward" is wrong in both directions - it
 * promotes rooms that did not need it and leaves rooms that did.
 *
 * Throws rather than answers when the estimate is not a measurement. A NaN
 * uplink silently answering "no" is a room that congests and never promotes,
 * and that presents to the people in it as nothing more informative than "the
 * call is bad".
 */
export function needsForwarding(estimate: CapacityEstimate, headroom: number = DEFAULT_HEADROOM): boolean {
  requireFiniteNonNegative(estimate.uplinkBps, 'uplinkBps')
  requireFiniteNonNegative(estimate.perPeerBps, 'perPeerBps')
  requireFiniteNonNegative(estimate.peers, 'peers')
  if (!Number.isInteger(estimate.peers)) throw new Error('capacity estimate has an unusable peers')
  if (!Number.isFinite(headroom) || headroom <= 0 || headroom > 1) {
    throw new Error('headroom must be a fraction of the uplink, in (0, 1]')
  }

  const required = estimate.peers * estimate.perPeerBps
  if (required === 0) return false
  return required > estimate.uplinkBps * headroom
}

/**
 * Schemes a forwarder may be reached on, best first.
 *
 * A forwarder entry rides the room descriptor, which every member can write,
 * so `url` is member-controlled input that ends up in a connection attempt.
 * The list is deliberately narrow: a forwarder is a signalling endpoint and
 * nothing else, so anything that is not a WebSocket address is a mistake or
 * an attempt to get a client to dereference something it should not.
 *
 * The order is also the preference order, which is why it is a list rather
 * than a set: given a choice between the same forwarder over `wss:` and over
 * `ws:`, every client in the room independently picks the encrypted one.
 */
const SCHEMES = ['wss:', 'ws:']

/** Rank of a ref's scheme, or -1 when it is not a usable forwarder address. */
function schemeRank(url: string): number {
  if (typeof url !== 'string' || url === '') return -1
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return -1
  }
  return SCHEMES.indexOf(parsed.protocol)
}

function isUsable(ref: ForwarderRef | undefined): ref is ForwarderRef {
  return ref !== undefined && ref !== null && schemeRank(ref.url) >= 0
}

/**
 * Order two usable refs. Encrypted schemes first, then url, then pubkey.
 *
 * Comparison is by UTF-16 code unit (`<`), never `localeCompare`: a locale
 * comparison is configuration-dependent, and two clients that order the list
 * differently pick different forwarders and stop being able to see each
 * other. The whole point of ordering rather than trusting the descriptor's
 * order is that the answer must not depend on anything local.
 */
function compareRefs(a: ForwarderRef, b: ForwarderRef): number {
  const rank = schemeRank(a.url) - schemeRank(b.url)
  if (rank !== 0) return rank
  if (a.url !== b.url) return a.url < b.url ? -1 : 1
  const pa = normaliseHex(a.pubkey ?? '')
  const pb = normaliseHex(b.pubkey ?? '')
  if (pa !== pb) return pa < pb ? -1 : 1
  return 0
}

/**
 * Choose one forwarder from the list the room descriptor names.
 *
 * Deterministic by construction: every client in the room holds the same
 * descriptor, and the answer is a total order over its entries rather than a
 * negotiation, so all of them promote to the same forwarder without
 * exchanging a message about which. Re-ordering the list changes nothing,
 * which matters because nothing on the wire preserves array order across two
 * independent implementations.
 *
 * `prefer` names a pubkey or a url - a forwarder the operator runs, or the
 * one this client used last. A preference that names nothing in the list, or
 * names an entry that is not a usable address, is ignored rather than
 * honoured or refused: a room whose forwarder list has moved on must keep
 * working.
 *
 * Returns `null` when the room names no usable forwarder. A room without one
 * degrades - it stays a mesh, and the mesh is what it always was for a small
 * group - so this is an ordinary answer, not an error.
 */
export function selectForwarder(refs: ForwarderRef[], prefer?: string): ForwarderRef | null {
  if (!Array.isArray(refs)) return null
  const usable = refs.filter(isUsable)
  if (usable.length === 0) return null

  if (prefer !== undefined && prefer !== '') {
    const preferred = usable.find((ref) => (ref.pubkey !== undefined && hexEquals(ref.pubkey, prefer)) || ref.url === prefer)
    if (preferred) return preferred
  }

  return usable.reduce((best, ref) => (compareRefs(ref, best) < 0 ? ref : best))
}
