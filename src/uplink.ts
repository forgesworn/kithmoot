/**
 * What this device actually has spare, measured from its own connections.
 *
 * ## Why this exists at all
 *
 * `assistDecision` will not let a device volunteer without a `CapacityEstimate`,
 * and until this module there was nowhere honest to get one. The app filled the
 * shape with zeroes, which reads as "measured nothing" and is the right answer
 * to "we do not know" - but it also meant the consent control could never turn
 * into a published offer, so peer assist was plumbing nobody could switch on.
 *
 * ## Measured, never asked
 *
 * Every number here comes out of `RTCPeerConnection.getStats()` on connections
 * this device already has open. Nothing is inferred from a user agent, nothing
 * is asked of the person, and nothing is a constant standing in for a
 * measurement:
 *
 * - **`uplinkBps`** is the sum of `availableOutgoingBitrate` across the
 *   selected candidate pair of every live connection. That is the congestion
 *   controller's own send-side estimate, which is the only thing in a browser
 *   that has actually probed the path.
 * - **`peers`** is how many connections are currently carrying anything.
 * - **`perPeerBps`** is the measured rate of one peer's media, taken as the
 *   larger of what this device sends per peer and what it receives per peer.
 *
 * ## Why the sum, and why it errs low
 *
 * Several connections from one laptop share one last-mile bottleneck. Flows
 * competing over a shared bottleneck converge on shares that add up to its
 * capacity, so adding the per-connection estimates is the right arithmetic:
 * the sum approximates the link, not some multiple of it.
 *
 * Where it is wrong, it is wrong downwards. A light call never probes hard
 * enough to find the ceiling, so each estimate sits somewhere above what that
 * flow is sending and well below what the link could do, and the sum with it.
 * That is the side to be wrong on. Under-reporting costs a room one volunteer
 * it could have had; over-reporting wins the selection and then fails the
 * connection, which costs a pair a round of fallback and ruins the volunteer's
 * own call on the way past.
 *
 * ## Why `perPeerBps` looks at both directions
 *
 * The figure is a stand-in for what one relayed pair will cost, and a relay
 * pays for a stream it *receives* from A and *sends* on to B. A device sitting
 * in a room with its camera off sends almost nothing and would report a
 * per-peer cost near zero, which would make every pair look free. What it
 * receives is the same media at the same bitrate, so the larger of the two is
 * the honest reading of "what one person's media costs in this room", and it
 * is still measured rather than assumed.
 *
 * ## Staleness
 *
 * A reading is a rate between two samples, so it needs two, and connections
 * that have stopped being sampled stop counting. `forget` is what a closed
 * connection calls; `STALE_AFTER_MS` is the backstop for one that was dropped
 * without saying so, because an offer built on a minute-old measurement is a
 * claim about a room that has since changed.
 */
import type { CapacityEstimate } from './types.js'

export type { CapacityEstimate } from './types.js'

/**
 * How long a connection's last sample stays worth counting.
 *
 * Long enough to ride out a slow polling interval or a tab the browser has
 * throttled, short enough that a connection which quietly died stops
 * contributing an uplink figure it can no longer deliver.
 */
export const STALE_AFTER_MS = 30_000

/**
 * The shortest gap between two samples that yields a usable rate.
 *
 * Two `getStats()` calls a few milliseconds apart divide a small byte delta by
 * a smaller interval and produce a number with no relationship to the link.
 */
export const MIN_SAMPLE_MS = 500

/**
 * The one stat field this module reads, loosely typed on purpose.
 *
 * `RTCStatsReport` is a `Map` of dictionaries whose members are all optional
 * and differ by browser and by version. Narrowing to a DOM type would make
 * this untestable without a browser and no more correct, so every field is
 * read defensively and anything unexpected is skipped.
 */
export interface StatLike {
  type?: string
  kind?: string
  state?: string
  bytesSent?: number
  bytesReceived?: number
  availableOutgoingBitrate?: number
  [key: string]: unknown
}

/** What one connection contributed at one moment. */
interface Sample {
  /** Cumulative bytes this connection has sent, across every outbound stream. */
  bytesSent: number
  /** Cumulative bytes it has received. */
  bytesReceived: number
  /** The congestion controller's estimate for it, or 0 where none was given. */
  availableOutgoingBitrate: number
  atMs: number
}

/** A connection's current rates, once there have been two samples of it. */
interface Reading extends Sample {
  sendBps: number
  receiveBps: number
  /** True once this connection has moved bytes, in either direction. */
  active: boolean
}

function finite(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * Fold one `getStats()` report down to the three numbers that matter.
 *
 * Only the *selected* candidate pair's estimate is taken. A connection reports
 * a candidate pair per combination it tried, and the ones ICE did not choose
 * describe paths nothing is flowing over.
 */
export function summariseStats(report: Iterable<StatLike>, atMs: number): Sample {
  let bytesSent = 0
  let bytesReceived = 0
  let availableOutgoingBitrate = 0

  for (const stat of report ?? []) {
    if (stat === null || typeof stat !== 'object') continue
    if (stat.type === 'outbound-rtp') bytesSent += finite(stat.bytesSent)
    else if (stat.type === 'inbound-rtp') bytesReceived += finite(stat.bytesReceived)
    else if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
      // Several pairs can read `succeeded` while ICE settles, so take the
      // largest rather than the last one iterated: report order is not
      // specified, and a stale pair reads as a smaller estimate, never a
      // bigger one.
      const estimate = finite(stat.availableOutgoingBitrate)
      if (estimate > availableOutgoingBitrate) availableOutgoingBitrate = estimate
    }
  }

  return { bytesSent, bytesReceived, availableOutgoingBitrate, atMs }
}

function rate(from: number, to: number, seconds: number): number {
  // A counter that went backwards means the connection was replaced under the
  // same key. Nothing useful can be said about the interval, so say nothing.
  if (to < from) return 0
  return ((to - from) * 8) / seconds
}

/**
 * This device's own capacity, kept up to date from the connections it has.
 *
 * Fed by the app polling `getStats()` on every open connection. Costs one
 * stats call per connection per interval and nothing else - no probe traffic,
 * no extra sockets, nothing sent anywhere.
 */
export class UplinkProbe {
  readonly #last = new Map<string, Sample>()
  readonly #readings = new Map<string, Reading>()
  readonly #staleAfterMs: number

  constructor(opts: { staleAfterMs?: number } = {}) {
    this.#staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS
  }

  /**
   * Record one connection's stats.
   *
   * The first call for a key establishes a baseline and changes nothing: a
   * rate needs two samples, and inventing one from a cumulative counter would
   * report a connection's whole history as if it happened in an instant.
   */
  update(key: string, report: Iterable<StatLike>, atMs: number = Date.now()): void {
    const sample = summariseStats(report, atMs)
    const previous = this.#last.get(key)
    this.#last.set(key, sample)
    if (!previous) return

    const seconds = (sample.atMs - previous.atMs) / 1000
    if (!(seconds >= MIN_SAMPLE_MS / 1000)) return

    const sendBps = rate(previous.bytesSent, sample.bytesSent, seconds)
    const receiveBps = rate(previous.bytesReceived, sample.bytesReceived, seconds)
    this.#readings.set(key, {
      ...sample,
      sendBps,
      receiveBps,
      active: sendBps > 0 || receiveBps > 0,
    })
  }

  /** Stop counting a connection. What a closed connection calls. */
  forget(key: string): void {
    this.#last.delete(key)
    this.#readings.delete(key)
  }

  /** Stop counting everything. */
  clear(): void {
    this.#last.clear()
    this.#readings.clear()
  }

  /**
   * True once there is enough measurement to say anything at all.
   *
   * The distinction the consent control needs: a device that has not measured
   * its uplink is not a device with no uplink, and the copy for the two is not
   * the same sentence.
   */
  measured(nowMs: number = Date.now()): boolean {
    return this.capacity(nowMs).uplinkBps > 0
  }

  /**
   * What this device would publish, if it were volunteering.
   *
   * `uplinkBps` of 0 means "not measured", and `assistDecision` reads it as a
   * hard block for exactly that reason. Nothing here ever substitutes a
   * plausible number for a missing one.
   */
  capacity(nowMs: number = Date.now()): CapacityEstimate {
    let uplinkBps = 0
    let sendBps = 0
    let receiveBps = 0
    let peers = 0

    for (const [key, reading] of this.#readings) {
      if (nowMs - reading.atMs > this.#staleAfterMs) {
        this.#readings.delete(key)
        this.#last.delete(key)
        continue
      }
      uplinkBps += reading.availableOutgoingBitrate
      if (!reading.active) continue
      peers += 1
      sendBps += reading.sendBps
      receiveBps += reading.receiveBps
    }

    // What one person's media costs, from whichever direction saw more of it.
    // Rounded, because a fractional bit per second is noise that would differ
    // between two clients reading the same link.
    const perPeer = peers > 0 ? Math.max(sendBps, receiveBps) / peers : 0

    return {
      uplinkBps: Math.round(uplinkBps),
      peers,
      perPeerBps: Math.round(perPeer),
    }
  }
}
