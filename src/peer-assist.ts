/**
 * Choosing which member of the room carries a pair that cannot connect.
 *
 * ## The point of all this
 *
 * A fixed relay has fixed capacity. A room whose members relay has capacity
 * that grows with attendance: every person who arrives brings more spare
 * uplink than they consume, so the room gets more capable as it gets bigger
 * rather than less. That is the only honest answer to "why not just run an
 * SFU", and it is the whole of what this module exists to make work.
 *
 * ## Deterministic, so nobody has to agree about anything
 *
 * Both ends of a failing pair run this function over the same roster and get
 * the same answer, with no message exchanged about it. That matters more than
 * it sounds: the alternative is a negotiation, and a negotiation between two
 * devices that have just failed to connect to each other has to happen over
 * the relay path they have not chosen yet.
 *
 * Determinism here means determinism across implementations too - a browser
 * and an Android client in the same room must pick the same relay - so the
 * ordering is a SHA-256 over a fixed string, compared as hex. No floating
 * point in the comparison, no locale-dependent sort, no array order from the
 * wire.
 *
 * ## Spreading, not stacking
 *
 * The obvious rule - "pick the volunteer with the most spare uplink" - puts
 * every struggling pair onto one person's laptop and ruins their call, which
 * is precisely the way to make sure nobody volunteers twice. So capacity buys
 * *slots* rather than priority: a volunteer with room for three pairs enters
 * the draw three times, and the draw itself is a rendezvous hash. Twice the
 * capacity means twice the share of the load, not all of it.
 *
 * ## Consent
 *
 * Nothing in here decides to spend somebody's bandwidth. `assistDecision` is
 * the other half: it will not offer without an explicit opt-in, and it will
 * not even recommend offering on a phone, on battery, or on a metered
 * connection.
 */
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { DEFAULT_HEADROOM } from './forwarder.js'
import { normaliseHex } from './hex.js'
import type { Reachability } from './reachability.js'
import type { AssistOffer, CapacityEstimate } from './types.js'

export type { AssistOffer } from './types.js'

/**
 * The most pairs one volunteer will ever carry, whatever it advertises and
 * whatever its uplink says.
 *
 * Somebody who volunteers must not have their own call ruined for it. Three
 * pairs is six streams in and six out on top of what they are already
 * sending: real, visible on a bandwidth graph, and survivable on a desktop
 * connection. It is also the ceiling a lie is clamped to, so a device
 * advertising room for a hundred pairs is read as advertising room for three.
 *
 * The cap is what keeps this from becoming a load-balancing problem. Past it
 * the answer is another volunteer, or a forwarder, not a bigger number here.
 */
export const MAX_ASSISTED_PAIRS = 3

/**
 * How many streams of uplink one assisted pair costs its relay.
 *
 * A relay carries a pair in both directions: it receives A's media and sends
 * it to B, and receives B's and sends it to A. That is two outbound streams
 * per pair, which is the number that matters, because upload is the scarce
 * half of a domestic connection.
 */
export const ASSIST_STREAMS_PER_PAIR = 2

/** Hard limit on slots any one volunteer can enter the draw with, so a
 *  gigabit uplink does not make the ranking loop unbounded. Never binding in
 *  practice: `MAX_ASSISTED_PAIRS` is lower. */
const MAX_SLOTS = 16

/**
 * Spare uplink, in bits per second, after this device's own call is paid for.
 *
 * Same function, same numbers, every client - which is what lets a selection
 * be deterministic without anybody publishing a "spare bandwidth" figure that
 * could be computed differently at each end. Never negative: a device already
 * over its headroom has nothing to give, not a debt to advertise.
 */
export function spareUplinkBps(capacity: CapacityEstimate, headroom: number = DEFAULT_HEADROOM): number {
  const uplink = Number(capacity?.uplinkBps)
  const peers = Number(capacity?.peers)
  const perPeer = Number(capacity?.perPeerBps)
  if (!Number.isFinite(uplink) || !Number.isFinite(peers) || !Number.isFinite(perPeer)) return 0
  if (!Number.isFinite(headroom) || headroom <= 0 || headroom > 1) return 0
  const spare = uplink * headroom - peers * perPeer
  return spare > 0 ? spare : 0
}

/**
 * What one assisted pair costs the volunteer, in bits per second of upload.
 *
 * The assisted pair's own bitrate is not on the wire - a device that is not
 * volunteering publishes no offer, so nothing states it - so the volunteer's
 * own per-peer bitrate stands in for it. Rooms are roughly homogeneous in
 * bitrate, and where they are not, the mitigation is the same one that covers
 * a volunteer lying about its uplink: a relay that cannot keep up shows as a
 * connection that fails, and is replaced.
 *
 * Using the volunteer's own figure has a property the alternatives do not:
 * it makes the whole selection a function of the roster alone, which is
 * exactly what every client needs to reach the same answer.
 */
export function assistCostBps(offer: AssistOffer): number {
  const perPeer = Number(offer?.capacity?.perPeerBps)
  if (!Number.isFinite(perPeer) || perPeer <= 0) return 0
  return perPeer * ASSIST_STREAMS_PER_PAIR
}

/**
 * How many more pairs this volunteer can take: the smaller of what its spare
 * uplink pays for and what it said it was willing to carry.
 *
 * Zero is an ordinary answer, and it is why a busy volunteer stops being
 * selected without having to withdraw its offer.
 */
export function assistSlots(offer: AssistOffer, headroom: number = DEFAULT_HEADROOM): number {
  const clamped = sanitiseAssistOffer(offer)
  if (!clamped) return 0
  const remaining = clamped.maxRelayed - clamped.relaying
  if (remaining <= 0) return 0

  const cost = assistCostBps(clamped)
  // A volunteer that advertises no per-peer bitrate has told us nothing about
  // what a pair would cost it. Believing its willingness rather than
  // inventing a cost is the honest reading, and the fan-out cap still bounds
  // it.
  const affordable = cost > 0 ? Math.floor(spareUplinkBps(clamped.capacity, headroom) / cost) : remaining
  return Math.max(0, Math.min(remaining, affordable, MAX_SLOTS))
}

function finiteNonNegative(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

const REACHABILITY: readonly Reachability[] = ['public', 'nat', 'symmetric', 'unknown']

/**
 * Defuse an assist offer read off the wire.
 *
 * The boundary, in the same place and for the same reason as
 * `sanitiseDisplayName`: an offer is attacker-controlled JSON published by
 * another implementation that owes us nothing. A NaN uplink or a negative
 * peer count would otherwise flow straight into arithmetic that decides who
 * carries a room.
 *
 * Returns undefined rather than throwing, and undefined rather than a
 * repaired half-offer, for a reason worth stating: the entry carrying it is
 * usually genuine, so the person stays in the room and only their offer is
 * dropped. That is the same shape as a hostile display name - the name is
 * neutralised, the person is not evicted.
 */
export function sanitiseAssistOffer(value: unknown): AssistOffer | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const offer = value as Partial<AssistOffer>

  const reachability = offer.reachability
  if (typeof reachability !== 'string' || !REACHABILITY.includes(reachability as Reachability)) return undefined

  const capacity = offer.capacity
  if (capacity === null || typeof capacity !== 'object') return undefined
  const uplinkBps = finiteNonNegative((capacity as CapacityEstimate).uplinkBps)
  const peers = finiteNonNegative((capacity as CapacityEstimate).peers)
  const perPeerBps = finiteNonNegative((capacity as CapacityEstimate).perPeerBps)
  if (uplinkBps === null || peers === null || perPeerBps === null) return undefined
  if (!Number.isInteger(peers)) return undefined

  const relaying = finiteNonNegative(offer.relaying)
  const maxRelayed = finiteNonNegative(offer.maxRelayed)
  if (relaying === null || maxRelayed === null) return undefined
  if (!Number.isInteger(relaying) || !Number.isInteger(maxRelayed)) return undefined

  return {
    reachability: reachability as Reachability,
    capacity: { uplinkBps, peers, perPeerBps },
    relaying,
    // Clamped rather than refused: a client with a different idea of the cap
    // is not hostile, and reading its offer as the cap this room enforces is
    // both safe and the answer every other client will reach.
    maxRelayed: Math.min(maxRelayed, MAX_ASSISTED_PAIRS),
  }
}

/** A member of the room offering to relay. */
export interface AssistVolunteer {
  /** The volunteering device's pubkey. */
  device: string
  offer: AssistOffer
}

/** A volunteer that could carry this pair, with what it has room for. */
export interface AssistCandidate extends AssistVolunteer {
  /** How many pairs it can still take. Always at least 1 here. */
  slots: number
}

export interface AssistSelectionOptions {
  /** Volunteers already tried for this pair and found wanting - one that
   *  vanished, or one whose connection would not come up. */
  exclude?: readonly string[]
  /** How much of a volunteer's uplink a room may claim. Defaults to the same
   *  fraction `needsForwarding` leaves. */
  headroom?: number
}

/**
 * The stable name of one pair, whichever end is asking.
 *
 * Both devices have to derive the same string or the whole scheme collapses
 * into each end picking a different relay, so it is sorted and case-folded -
 * a hex pubkey off the wire is not guaranteed to arrive in either case. See
 * `hex.ts`.
 */
export function assistPairKey(a: string, b: string): string {
  const first = normaliseHex(a)
  const second = normaliseHex(b)
  return first < second ? `${first}:${second}` : `${second}:${first}`
}

/** The rendezvous score for one volunteer's one slot. Hex, so the comparison
 *  is a string comparison rather than anything that could round differently
 *  in another language. */
function slotScore(pairKey: string, device: string, slot: number): string {
  return bytesToHex(sha256(utf8ToBytes(`kithmoot/v1/assist|${pairKey}|${device}|${slot}`))).slice(0, 16)
}

/** The best score this volunteer holds for this pair, over all its slots. */
function bestScore(pairKey: string, candidate: AssistCandidate): string {
  let best = ''
  for (let slot = 0; slot < candidate.slots; slot += 1) {
    const score = slotScore(pairKey, candidate.device, slot)
    if (score > best) best = score
  }
  return best
}

/**
 * Every volunteer that could carry this pair, best first.
 *
 * The order is the failover order: if the first one vanishes mid-sentence -
 * which is the normal case, not the edge case - the next one down is the
 * answer, and it is the same next one at both ends because both ends
 * computed the same list from the same roster.
 *
 * Neither end of the pair can be its own relay, and neither is silently
 * skipped: a volunteer that happens to be one of the two is simply not a
 * third party.
 */
export function rankAssistants(
  pair: readonly [string, string],
  volunteers: readonly AssistVolunteer[],
  opts: AssistSelectionOptions = {},
): AssistCandidate[] {
  const pairKey = assistPairKey(pair[0], pair[1])
  const ends = new Set([normaliseHex(pair[0]), normaliseHex(pair[1])])
  const excluded = new Set((opts.exclude ?? []).map(normaliseHex))

  const eligible: AssistCandidate[] = []
  for (const volunteer of volunteers ?? []) {
    const device = normaliseHex(volunteer?.device ?? '')
    if (device === '' || ends.has(device) || excluded.has(device)) continue
    const offer = sanitiseAssistOffer(volunteer.offer)
    // Only a publicly reachable member is any use. A member behind a NAT
    // cannot be reached by the other NATed member, which is the entire
    // failure this exists to route around.
    if (!offer || offer.reachability !== 'public') continue
    const slots = assistSlots(offer, opts.headroom)
    if (slots < 1) continue
    eligible.push({ device, offer, slots })
  }

  return eligible
    .map((candidate) => ({ candidate, score: bestScore(pairKey, candidate) }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score < b.score ? 1 : -1
      // Two identical scores means a SHA-256 collision on 8 bytes, which will
      // not happen - but a total order must be total, and the pubkey is the
      // one tiebreak both ends already agree on.
      return a.candidate.device < b.candidate.device ? -1 : 1
    })
    .map((ranked) => ranked.candidate)
}

/**
 * The one volunteer this pair should route through, or null.
 *
 * Null is an ordinary answer, not an error: a room where nobody is publicly
 * reachable, or where everybody who is has their hands full, falls through to
 * the next thing the mesh knows how to try. Peer assist raises the ceiling on
 * what a room can do without a server; it does not promise there is always
 * somebody to help.
 */
export function selectAssistant(
  pair: readonly [string, string],
  volunteers: readonly AssistVolunteer[],
  opts: AssistSelectionOptions = {},
): AssistCandidate | null {
  return rankAssistants(pair, volunteers, opts)[0] ?? null
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** A reason this device should not, or must not, be relaying. */
export type AssistBlock =
  /** The browser cannot forward encoded frames without decoding them, so it
   *  cannot relay end-to-end encrypted media at all. Hard. */
  | 'no-relay-support'
  /** Nobody behind a NAT could reach this device, so an offer would be an
   *  advertisement for a path that does not exist. Hard. */
  | 'not-publicly-reachable'
  /** Nothing left over after this device's own call. Hard, and temporary. */
  | 'no-spare-uplink'
  /** A phone, or something we could not tell apart from one. Soft. */
  | 'mobile'
  /** Running on battery. Relaying is sustained radio and CPU. Soft. */
  | 'on-battery'
  /** A metered connection: somebody is paying by the byte. Soft. */
  | 'metered'

/** Hard blocks are technical impossibilities; the rest are courtesies. */
const HARD_BLOCKS: readonly AssistBlock[] = ['no-relay-support', 'not-publicly-reachable', 'no-spare-uplink']

/**
 * What this device can see about its own situation.
 *
 * Every field is measured or reported by a platform API, never sniffed from a
 * user agent - `reachability` from gathered candidates, `canRelay` from
 * feature detection on the actual connection objects, `formFactor` from
 * `navigator.userAgentData.mobile` where the platform offers it. Where a
 * platform will not say, the field is undefined and is read as "not
 * detectable" rather than as "no".
 */
export interface AssistEnvironment {
  /** Measured - see `classifyReachability`. */
  reachability: Reachability
  /** Whether this browser can forward encoded frames verbatim - see
   *  `detectRelayCapability`. */
  canRelay: boolean
  /** This device's uplink and what its own call is already spending. */
  capacity: CapacityEstimate
  /** Desktop, mobile, or undetectable. Undetectable is treated as mobile for
   *  the purpose of not volunteering somebody's phone by accident. */
  formFactor?: 'desktop' | 'mobile' | 'unknown'
  /** True when running on battery. Undefined when the platform will not say. */
  onBattery?: boolean
  /** True when the connection is metered or in data-saver mode. Undefined
   *  when the platform will not say. */
  metered?: boolean
  headroom?: number
}

export interface AssistDecision {
  /** Whether to publish an offer. Requires an explicit opt-in, always. */
  offering: boolean
  /**
   * Whether this device is a good candidate to be asked at all.
   *
   * What a UI should use to decide whether to suggest the toggle, and what
   * state to leave it in before anybody has touched it. False does not mean
   * refused: somebody on a train who chooses to help may.
   */
  recommended: boolean
  /** Everything standing in the way, hard and soft, for honest copy. */
  blocks: AssistBlock[]
}

/**
 * Decide whether this device offers to relay.
 *
 * **Opt in, always.** `enabled` is the person's own choice, and nothing else
 * in this function can turn an offer on without it. That is not a UI
 * preference: relaying spends their bandwidth, their battery and their data
 * allowance, and a default that quietly volunteers a phone on mobile data is
 * the kind of thing that gets an app uninstalled and deserves to.
 *
 * The soft blocks are why `recommended` exists separately. A person on a
 * laptop on mains power on a home connection should see an offer worth
 * making; a person on a phone on 5G should not be asked, and if they insist,
 * that is theirs to insist on.
 *
 * The hard blocks bind regardless. There is no amount of willingness that
 * makes an unreachable device reachable, and advertising a capability that
 * cannot be delivered is worse than not advertising: it wins the selection,
 * fails the connection, and costs the pair a round of fallback.
 */
export function assistDecision(env: AssistEnvironment, enabled?: boolean): AssistDecision {
  const blocks: AssistBlock[] = []

  if (!env.canRelay) blocks.push('no-relay-support')
  if (env.reachability !== 'public') blocks.push('not-publicly-reachable')
  if (spareUplinkBps(env.capacity, env.headroom) < (env.capacity?.perPeerBps ?? 0) * ASSIST_STREAMS_PER_PAIR) {
    blocks.push('no-spare-uplink')
  }
  // Unknown counts as mobile. The failure we are avoiding is volunteering
  // somebody's phone by default, and "we could not tell" is not a reason to
  // risk it.
  if (env.formFactor !== 'desktop') blocks.push('mobile')
  if (env.onBattery === true) blocks.push('on-battery')
  if (env.metered === true) blocks.push('metered')

  const hard = blocks.some((block) => HARD_BLOCKS.includes(block))
  return { offering: enabled === true && !hard, recommended: blocks.length === 0, blocks }
}

/**
 * The offer to publish, or null.
 *
 * `relaying` is how many pairs this device is carrying right now, which is
 * what makes a busy volunteer stop being chosen without withdrawing - see
 * `assistSlots`.
 */
export function buildAssistOffer(env: AssistEnvironment, relaying: number, enabled?: boolean): AssistOffer | null {
  if (!assistDecision(env, enabled).offering) return null
  const carried = Number.isInteger(relaying) && relaying >= 0 ? relaying : 0
  return sanitiseAssistOffer({
    reachability: env.reachability,
    capacity: env.capacity,
    relaying: carried,
    maxRelayed: MAX_ASSISTED_PAIRS,
  }) ?? null
}
