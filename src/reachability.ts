/**
 * What this device's own network will let other people do to it.
 *
 * ## Why a room needs this
 *
 * From the NAT measurements this design is built on: **a symmetric-NAT client
 * can always connect outbound to a peer that has a public address.** The
 * failure case is NAT against NAT. NAT against public behaves exactly like
 * reaching any ordinary server, which is the whole reason a server works at
 * all.
 *
 * So a participant who is publicly reachable can absorb the peers who cannot
 * connect to each other directly, with plain WebRTC and no TURN. Working out
 * who those participants are is this module's only job.
 *
 * ## Measured, never inferred
 *
 * Nothing here reads a user agent, a platform string, or a connection type.
 * Those are guesses, and a wrong guess here is a volunteer who cannot
 * actually carry anybody - which the room only discovers as a connection
 * that will not come up. The answer comes from the candidates ICE actually
 * gathered, compared against each other:
 *
 * - a server-reflexive candidate whose address and port match the host
 *   candidate it came from means nothing translated it, so this device is
 *   **public**;
 * - the same local base seen at two different external mappings means the NAT
 *   is address-dependent, so **symmetric**;
 * - a translation that is consistent is an ordinary **nat**;
 * - and nothing to compare is **unknown**, which is the honest answer rather
 *   than the flattering one.
 *
 * ## Why `unknown` exists
 *
 * A device that has gathered no reflexive candidate has measured nothing. It
 * could be a public server with no STUN configured, or a laptop whose
 * gathering has not finished. Reporting either `public` or `nat` there would
 * be a guess dressed as a measurement. `unknown` is treated exactly as `nat`
 * everywhere it matters - neither may volunteer to relay - so the extra state
 * costs nothing and stops the module claiming to know something it does not.
 *
 * ## The `nat` / `symmetric` distinction is diagnostic, not load-bearing
 *
 * Telling a cone NAT from a symmetric one needs reflexive candidates from at
 * least two STUN servers: with one server both look identical, because both
 * produce exactly one mapping. That is fine here. Both classes behave the
 * same way for every decision this room makes - neither can be a relay,
 * either can reach one - so the distinction is reported because it is worth
 * seeing, not because anything branches on it.
 */

/** How reachable this device is from outside its own network. */
export type Reachability = 'public' | 'nat' | 'symmetric' | 'unknown'

/** The candidate types ICE gathers, per RFC 8445 s5.1.1. */
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay'

/** One ICE candidate, parsed down to the fields that decide reachability. */
export interface ParsedCandidate {
  type: CandidateType
  /** The candidate's address. `.local` for an mDNS-obfuscated host candidate. */
  address: string
  port: number
  transport: string
  foundation: string
  /** The local address this candidate was derived from, for srflx and relay. */
  relatedAddress?: string
  relatedPort?: number
  /**
   * True for an mDNS host candidate - `4f7a...c1.local` rather than an
   * address.
   *
   * Chrome publishes these by default to keep a page from learning the
   * machine's local addresses, and only reveals real ones once camera or
   * microphone permission has been granted. They are perfectly good
   * candidates and completely useless for this comparison, so they are
   * counted and then ignored rather than silently treated as private.
   */
  obfuscated: boolean
}

/** Anything a browser might hand us for one candidate. */
export type CandidateLike = string | { candidate?: string | null } | null | undefined

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Whether an address is one the rest of the internet could route to.
 *
 * Deliberately a denylist of the ranges that are definitely not routable
 * rather than an allowlist of the ones that are: the reserved ranges are a
 * known, closed list, and treating an unrecognised address as private would
 * classify a perfectly good public host as unreachable.
 */
export function isGloballyRoutable(address: string): boolean {
  if (address === '') return false
  const v4 = IPV4.exec(address)
  if (v4) {
    const parts = v4.slice(1, 5).map(Number)
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
    const [a, b] = parts as [number, number, number, number]
    if (a === 0) return false // "this network"
    if (a === 10) return false // RFC 1918
    if (a === 127) return false // loopback
    if (a === 169 && b === 254) return false // link-local
    if (a === 172 && b >= 16 && b <= 31) return false // RFC 1918
    if (a === 192 && b === 168) return false // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return false // RFC 6598 carrier-grade NAT
    if (a === 192 && b === 0) return false // RFC 6890 protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false // RFC 2544 benchmarking
    if (a >= 224) return false // multicast and reserved
    return true
  }

  // IPv6. Only the global unicast block is routable; a link-local or
  // unique-local address is exactly as unreachable as an RFC 1918 one.
  const lower = address.toLowerCase()
  if (!lower.includes(':')) return false
  if (lower === '::' || lower === '::1') return false
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return false // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false // fc00::/7 unique-local
  if (lower.startsWith('ff')) return false // ff00::/8 multicast
  const first = Number.parseInt(lower.split(':')[0] ?? '', 16)
  if (!Number.isFinite(first)) return false
  // 2000::/3 is the only block IANA has allocated as global unicast.
  return first >= 0x2000 && first <= 0x3fff
}

/**
 * Parse one ICE candidate line.
 *
 * Accepts the bare attribute, the `a=`-prefixed SDP line, or an
 * `RTCIceCandidateInit`, because all three turn up depending on whether a
 * caller is reading `onicecandidate`, an SDP blob, or something another
 * implementation serialised. Returns null for anything that is not a
 * candidate: this runs over input a remote implementation produced, and a
 * malformed line is one lost measurement rather than an error.
 */
export function parseIceCandidate(input: CandidateLike): ParsedCandidate | null {
  const raw = typeof input === 'string' ? input : input?.candidate
  if (typeof raw !== 'string') return null

  let line = raw.trim()
  if (line.startsWith('a=')) line = line.slice(2)
  if (line.startsWith('candidate:')) line = line.slice('candidate:'.length)
  if (line === '') return null

  const parts = line.split(/\s+/)
  // foundation component transport priority address port typ <type>
  if (parts.length < 8) return null
  if (parts[6] !== 'typ') return null

  const type = parts[7]
  if (type !== 'host' && type !== 'srflx' && type !== 'prflx' && type !== 'relay') return null

  const port = Number(parts[5])
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null

  const address = parts[4] ?? ''
  const candidate: ParsedCandidate = {
    type,
    address,
    port,
    transport: (parts[2] ?? '').toLowerCase(),
    foundation: parts[0] ?? '',
    obfuscated: address.toLowerCase().endsWith('.local'),
  }

  // The extension attributes are `name value` pairs in any order after the
  // type, so they are read by name rather than by position.
  for (let i = 8; i + 1 < parts.length; i += 2) {
    const name = parts[i]
    const value = parts[i + 1] as string
    if (name === 'raddr') candidate.relatedAddress = value
    else if (name === 'rport') {
      const rport = Number(value)
      if (Number.isInteger(rport) && rport >= 0 && rport <= 65535) candidate.relatedPort = rport
    }
  }

  return candidate
}

/** What the gathered candidates say about this device. */
export interface ReachabilityReport {
  reachability: Reachability
  /** Host candidates seen, obfuscated ones included. */
  hosts: number
  /** How many of those were mDNS `.local` names rather than addresses. */
  obfuscatedHosts: number
  reflexive: number
  /** TURN candidates. Counted, never used to classify: a relay candidate
   *  says something about the TURN server's reachability, not this device's. */
  relayed: number
  /**
   * The largest number of distinct external mappings seen for one local base.
   *
   * 1 is an ordinary NAT. 2 or more means the mapping changed with the
   * destination, which is what symmetric means. 0 means nothing was measured.
   * Distinguishing the first two needs candidates from at least two STUN
   * servers - see the module comment.
   */
  mappings: number
  /** The routable address that made this device public, when one did. */
  publicAddress?: string
}

/** Key for "one local socket", which is what a NAT mapping is a mapping of. */
function baseOf(candidate: ParsedCandidate): string {
  if (candidate.relatedAddress !== undefined) {
    return `${candidate.relatedAddress}:${candidate.relatedPort ?? ''}`
  }
  // No raddr (some implementations omit it): the foundation is per base and
  // per STUN server, which is a coarser but still per-socket grouping.
  return `foundation:${candidate.foundation}`
}

/**
 * Classify this device from the candidates it gathered.
 *
 * Pure: candidates in, an answer out. No network, no globals, no clock - so
 * the whole classification can be checked against recorded candidate sets
 * from real networks without any of them being present.
 */
export function classifyReachability(candidates: Iterable<CandidateLike | ParsedCandidate>): ReachabilityReport {
  const parsed: ParsedCandidate[] = []
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && 'type' in candidate && 'obfuscated' in candidate) {
      parsed.push(candidate as ParsedCandidate)
      continue
    }
    const one = parseIceCandidate(candidate as CandidateLike)
    if (one) parsed.push(one)
  }

  const hosts = parsed.filter((c) => c.type === 'host')
  const reflexive = parsed.filter((c) => c.type === 'srflx')
  const relayed = parsed.filter((c) => c.type === 'relay')

  const report: ReachabilityReport = {
    reachability: 'unknown',
    hosts: hosts.length,
    obfuscatedHosts: hosts.filter((c) => c.obfuscated).length,
    reflexive: reflexive.length,
    relayed: relayed.length,
    mappings: 0,
  }

  // A local socket the outside world sees at exactly the address and port it
  // is bound to has nothing between it and the internet. Both halves have to
  // match: an address that survives translation but a port that does not is
  // still a NAT, and calling it public would volunteer a device that cannot
  // be reached where it says it can.
  const hostSockets = new Set(hosts.filter((c) => !c.obfuscated).map((c) => `${c.address}:${c.port}`))
  for (const candidate of reflexive) {
    if (!isGloballyRoutable(candidate.address)) continue
    const matchesRelated =
      candidate.relatedAddress !== undefined &&
      candidate.relatedAddress === candidate.address &&
      candidate.relatedPort === candidate.port
    if (matchesRelated || hostSockets.has(`${candidate.address}:${candidate.port}`)) {
      report.reachability = 'public'
      report.publicAddress = candidate.address
      return report
    }
  }

  // Otherwise: how many different places did the outside world see one local
  // socket at? A NAT that answers differently per destination cannot be
  // punched through by a peer behind another one.
  const seen = new Map<string, Set<string>>()
  for (const candidate of reflexive) {
    const base = baseOf(candidate)
    let mappings = seen.get(base)
    if (!mappings) {
      mappings = new Set()
      seen.set(base, mappings)
    }
    mappings.add(`${candidate.address}:${candidate.port}`)
  }

  for (const mappings of seen.values()) report.mappings = Math.max(report.mappings, mappings.size)

  if (report.mappings >= 2) report.reachability = 'symmetric'
  else if (report.mappings === 1) report.reachability = 'nat'
  // else: nothing reflexive was gathered, so nothing was measured. `unknown`.

  return report
}

/**
 * Accumulates candidates as ICE trickles them out, and can be asked for the
 * current answer at any point.
 *
 * The same pure classification, wrapped so an app can feed it straight from
 * `onicecandidate` without collecting an array itself. Gathering is
 * incremental and the answer sharpens as it goes: the honest thing to do with
 * a half-gathered probe is read `unknown` off it, which is exactly what it
 * reports.
 */
export class ReachabilityProbe {
  readonly #candidates: ParsedCandidate[] = []

  /** Feed in one candidate. Anything unparseable is ignored. */
  add(candidate: CandidateLike): boolean {
    const parsed = parseIceCandidate(candidate)
    if (!parsed) return false
    this.#candidates.push(parsed)
    return true
  }

  /** Every candidate accepted so far, in arrival order. */
  get candidates(): readonly ParsedCandidate[] {
    return this.#candidates
  }

  /** The classification as it stands. Recomputed on read, because a probe is
   *  read rarely and fed often. */
  get report(): ReachabilityReport {
    return classifyReachability(this.#candidates)
  }

  get reachability(): Reachability {
    return this.report.reachability
  }
}
