/**
 * The lane a message actually travelled, and what that lane delivers.
 *
 * Three states, fixed in meaning. A client shows the lane a message took,
 * never the lane it asked for, and never claims more than the lane gives.
 * The state is worked out from where the bytes went, so nothing on the
 * wire can assert it: a message that says it was sheltered is not.
 *
 * - public: a relay operator could see who this was for and when.
 * - sheltered: no operator outside your circle saw this.
 * - direct: only the two devices were involved.
 *
 * Today a room's traffic rides ordinary relays, so almost everything is
 * public. That is the honest answer and it is shown. An onion relay run by
 * the room's own people is sheltered. A data channel is direct. As more
 * carriers arrive they classify here, and nowhere else.
 */
export type Lane = 'public' | 'sheltered' | 'direct'

export const LANES: readonly Lane[] = ['public', 'sheltered', 'direct']

/** The fixed meaning of each state, shown wherever the state is. */
export const LANE_MEANING: Readonly<Record<Lane, string>> = {
  public: 'A relay operator could see who this was for and when.',
  sheltered: 'No operator outside your circle saw this.',
  direct: 'Only the two devices were involved.',
}

/** Short label, readable without colour. */
export const LANE_LABEL: Readonly<Record<Lane, string>> = {
  public: 'public',
  sheltered: 'sheltered',
  direct: 'direct',
}

/** A glyph beside the label, so the state is told apart without colour. */
export const LANE_GLYPH: Readonly<Record<Lane, string>> = {
  public: '○',
  sheltered: '◐',
  direct: '●',
}

/** Weakest first. A message that touched a public relay is public,
 *  whatever else it also touched. */
const RANK: Readonly<Record<Lane, number>> = { public: 0, sheltered: 1, direct: 2 }

export function isLane(value: unknown): value is Lane {
  return value === 'public' || value === 'sheltered' || value === 'direct'
}

/** The lane one relay URL puts a message on. */
export function laneOfRelayUrl(url: string): Lane {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.endsWith('.onion')) return 'sheltered'
  } catch {
    // An unparseable URL is nobody's onion.
  }
  return 'public'
}

/** The weakest of several lanes. Undefined when there are none. */
export function weakestLane(lanes: readonly Lane[]): Lane | undefined {
  let out: Lane | undefined
  for (const lane of lanes) if (out === undefined || RANK[lane] < RANK[out]) out = lane
  return out
}

/** The lane a message takes when it is published to all of these relays. */
export function laneOfRelays(urls: readonly string[]): Lane | undefined {
  return weakestLane(urls.map(laneOfRelayUrl))
}

/** A message went by a weaker lane than the one asked for. */
export function isDowngrade(requested: Lane, actual: Lane): boolean {
  return RANK[actual] < RANK[requested]
}
