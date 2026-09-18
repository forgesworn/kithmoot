/**
 * Per-slot pair health: the measuring half of §3.4 of the call reliability
 * design.
 *
 * The one thing a client can be sure of about a call is whether packets are
 * arriving. Everything else it might ask is a lie in at least one browser:
 * `connectionState` stays `connected` through a stream that stopped an hour
 * ago, a receiver's `muted` never becomes true when the far end calls
 * `replaceTrack(null)` (measured, both engines, `test/rtc-probe.spec.ts`), a
 * receiver's track id never matches the sender's inside a slot, and the
 * roster's advert is up to twenty seconds stale and describes intent rather
 * than delivery. So this module counts packets and frames per slot, every two
 * seconds, and says three words about each one: `ok`, `dead`, or `idle`.
 *
 * The other direction is RTCP. `remote-inbound-rtp` is the far end's own
 * receiver report coming back to us, so it tells a sender whether its RTP is
 * being received without a single new byte of metadata on the wire and
 * without the far end having to speak this profile at all - which is what
 * makes it the backstop for the current Android build and for every client
 * from before today (amendment A3).
 *
 * Deliberately no actions here. This module measures; `PairLadder` below
 * decides, and the controller acts. Keeping them apart is what lets the
 * awkward timing (a slot that goes quiet inside its grace, an RTCP report
 * that stops advancing while inbound is fine) be tested against a fake clock
 * in milliseconds instead of inferred from a call.
 */

import { SLOT_KINDS, SLOT_ORDER } from './peer-slots.js'
import type { ChannelClock } from './signal-channel.js'
import type { RTCPeerConnectionLike, RtpTransceiverLike, StatsReportLike } from './peer.js'
import type { TrackRole } from './types.js'

/**
 * How often the connection is sampled.
 *
 * Two seconds is the existing poll shape in the app (`collectDiagnostics`'s
 * stats pass), and it is the right order: a `getStats()` on a four-slot
 * connection is cheap, and the thresholds below are all multiples of it, so
 * a verdict is never decided by a single reading.
 */
export const HEALTH_SAMPLE_MS = 2_000

/** How long a slot the far end says is live may deliver nothing before it is
 *  called dead. §3.4, row 1. */
export const SLOT_DEAD_MS = 6_000

/**
 * How long a slot is given before the clock above starts at all.
 *
 * A slot that has just been advertised, or a connection that has just
 * reached `connected`, has not had time to carry anything: DTLS, SRTP keying
 * and the first keyframe all happen inside this window. Judging it earlier
 * would mean calling every healthy pair dead once, at the start of every
 * call.
 */
export const SLOT_GRACE_MS = 6_000

/**
 * How long our own outbound may go unacknowledged by RTCP before the sender
 * acts. Deliberately the receiver's own threshold doubled: the side that is
 * missing media acts first and the sending side acts only if the far end
 * plainly did not, which is what stops both ends rebuilding the same pair
 * for the same reason.
 */
export const RTCP_DEAD_MS = 14_000

/** What one slot is doing, in one word. */
export type SlotVerdict =
  /** Counters moved in the last window. */
  | 'ok'
  /** Nothing has moved for long enough that something is wrong. */
  | 'dead'
  /** Nothing is expected: the far end is not sending in this slot, or this
   *  side is not, or it is still inside its grace. */
  | 'idle'

export interface SlotHealth {
  role: TrackRole
  /** The m-line this slot is, once the generation has assigned one. */
  mid: string | null
  /** Whether the far end's roster advert says this slot is live. */
  advertised: boolean
  /** What is arriving from the far end in this slot. */
  inbound: SlotVerdict
  /** What RTCP says the far end is receiving from us in this slot. */
  rtcp: SlotVerdict
  /**
   * Whether this slot's inbound counter moved in this sample window.
   *
   * Not the same as `inbound === 'ok'`, and the difference matters: `ok`
   * means "not silent for long enough to be called dead yet", which a slot
   * that has never delivered anything also satisfies for the whole of its
   * first dead window. Only this says something actually arrived.
   */
  progressed: boolean
  /** The inbound counter this verdict was reached on - `packetsReceived` for
   *  audio, `framesDecoded` for video. Diagnostics only. */
  counter?: number
}

export interface PairHealthSample {
  /** The sampler's clock, in milliseconds. */
  at: number
  slots: SlotHealth[]
  /** Slots the far end advertises and which are delivering nothing, while at
   *  least one other slot on the pair is. §3.4's "transport is fine, one
   *  slot is dead" row, and the only thing the `health` signal reports. */
  deadSlots: TrackRole[]
  /** Whether anything at all is actually arriving on this connection - a
   *  counter that moved, not a clock that has not run out. */
  transportOk: boolean
  /** Every slot the far end advertises is dead - there is at least one, and
   *  none of them is delivering. The transport, not a slot. */
  allDead: boolean
  /** Slots we are sending on whose RTCP has stopped coming back. The
   *  backstop for a far end that cannot heal itself. */
  unreceivedSlots: TrackRole[]
}

export interface PairHealthOptions {
  /** The connection to sample, read fresh each time: a rebuild replaces it
   *  and the sampler must follow rather than hold the old one. */
  connection: () => RTCPeerConnectionLike | undefined
  /** The generation's slot map, mid to role. Absent before a generation is
   *  open, which is simply a sample with nothing in it. */
  slots: () => Record<string, TrackRole> | undefined
  /**
   * Which slots the far end's roster advert says are live.
   *
   * The advert is what makes "nothing is arriving" mean something: a camera
   * that is off is not a dead slot, it is an idle one, and a pair judged
   * without this would report three dead slots for every person on a call
   * with only their microphone on.
   */
  advertised: () => readonly TrackRole[]
  /** Every completed sample. */
  onSample?: (sample: PairHealthSample) => void
  /** Defaults to the constants above; tests shorten them. */
  timing?: { sampleMs?: number; deadMs?: number; graceMs?: number; rtcpDeadMs?: number }
  clock?: ChannelClock
}

const REAL_CLOCK: ChannelClock = {
  now: () => Date.now(),
  setTimer: (ms, run) => {
    const timer = setTimeout(run, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** What the previous sample saw for one slot, so this one can say whether
 *  anything moved. */
interface SlotMemory {
  /** Inbound packets (audio) or decoded frames (video). */
  counter?: number
  /** When the counter last increased. */
  progressAt?: number
  /** When this slot most recently became something that ought to be
   *  delivering: the advert turning live, or the connection connecting. */
  liveSince?: number
  /** The RTCP figures the far end last reported for our outbound. */
  rtcp?: { measurements: number; timestamp: number; lost: number }
  rtcpAt?: number
  sendingSince?: number
}

/**
 * One connection's health, sampled on a timer.
 *
 * Holds no policy: it reports, and the same report is what the ladder and
 * the bug report both read.
 */
export class PairHealth {
  readonly #opts: PairHealthOptions
  readonly #clock: ChannelClock
  readonly #sampleMs: number
  readonly #deadMs: number
  readonly #graceMs: number
  readonly #rtcpDeadMs: number

  readonly #memory = new Map<TrackRole, SlotMemory>()
  #timer: unknown
  #running = false
  #sampling = false
  #connectedAt: number | undefined
  #last: PairHealthSample | undefined

  constructor(opts: PairHealthOptions) {
    this.#opts = opts
    this.#clock = opts.clock ?? REAL_CLOCK
    this.#sampleMs = opts.timing?.sampleMs ?? HEALTH_SAMPLE_MS
    this.#deadMs = opts.timing?.deadMs ?? SLOT_DEAD_MS
    this.#graceMs = opts.timing?.graceMs ?? SLOT_GRACE_MS
    this.#rtcpDeadMs = opts.timing?.rtcpDeadMs ?? RTCP_DEAD_MS
  }

  /** The most recent completed sample, for a bug report. */
  get last(): PairHealthSample | undefined {
    return this.#last
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#arm()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) this.#clock.clearTimer(this.#timer)
    this.#timer = undefined
  }

  /**
   * The connection reached `connected`, or was replaced by one that has not.
   *
   * Every slot's grace starts again from here: a rebuilt connection has to
   * key and start delivering all over, and carrying the old connection's
   * silence across would declare the new one dead the moment it appeared.
   */
  reset(connectedAt?: number): void {
    this.#memory.clear()
    this.#last = undefined
    this.#connectedAt = connectedAt
  }

  /** Sample once, now. Returns undefined when there is nothing to sample -
   *  no connection, no generation, or a connection with no `getStats`. */
  async sample(): Promise<PairHealthSample | undefined> {
    if (this.#sampling) return undefined
    this.#sampling = true
    try {
      return await this.#sample()
    } catch {
      // A `getStats` that rejects is a connection on its way out, which the
      // connection state will say far more clearly than a thrown sampler.
      return undefined
    } finally {
      this.#sampling = false
    }
  }

  async #sample(): Promise<PairHealthSample | undefined> {
    const pc = this.#opts.connection()
    const slots = this.#opts.slots()
    if (!pc || !slots || typeof pc.getStats !== 'function') return undefined

    const now = this.#clock.now()
    const advertised = new Set(this.#opts.advertised())
    const byRole = new Map<TrackRole, string>()
    for (const [mid, role] of Object.entries(slots)) byRole.set(role, mid)

    const transceivers = pc.getTransceivers?.() ?? []
    const byMid = new Map<string, RtpTransceiverLike>()
    for (const transceiver of transceivers) {
      if (transceiver.mid !== null) byMid.set(transceiver.mid, transceiver)
    }

    const inboundByMid = new Map<string, Record<string, unknown>>()
    const remoteInboundBySsrc = new Map<number, Record<string, unknown>>()
    const outboundByMid = new Map<string, Record<string, unknown>>()
    const report = await pc.getStats()
    report.forEach((raw) => {
      const stat = raw as Record<string, unknown>
      const mid = typeof stat.mid === 'string' ? stat.mid : undefined
      if (stat.type === 'inbound-rtp' && mid !== undefined) inboundByMid.set(mid, stat)
      else if (stat.type === 'outbound-rtp' && mid !== undefined) outboundByMid.set(mid, stat)
      else if (stat.type === 'remote-inbound-rtp' && typeof stat.ssrc === 'number') remoteInboundBySsrc.set(stat.ssrc, stat)
    })

    const health: SlotHealth[] = []
    for (const role of SLOT_ORDER) {
      const mid = byRole.get(role) ?? null
      const memory = this.#memoryFor(role)
      const live = advertised.has(role)
      const transceiver = mid === null ? undefined : byMid.get(mid)

      // Since the advert turned live, or since the connection came up -
      // whichever is later, because either one restarts the clock.
      if (!live) memory.liveSince = undefined
      else if (memory.liveSince === undefined) memory.liveSince = Math.max(now, this.#connectedAt ?? now)

      let stat = mid === null ? undefined : inboundByMid.get(mid)
      // §3.4: "where a browser omits `mid`, fall back to
      // `transceiver.receiver.getStats()`". That report is scoped to one
      // receiver, so the m-line it belongs to is known without the field.
      if (stat === undefined && transceiver?.receiver?.getStats) {
        try {
          const scoped = await transceiver.receiver.getStats()
          scoped.forEach((raw) => {
            const candidate = raw as Record<string, unknown>
            if (candidate.type === 'inbound-rtp') stat = candidate
          })
        } catch {
          // A receiver that will not report is one with nothing to report.
        }
      }

      const counter = readCounter(stat, SLOT_KINDS[role])
      if (counter !== undefined) {
        // On the first sighting there is nothing to compare against, so a
        // counter that is already above zero is read as progress: something
        // has arrived, even if this sampler cannot say when. A counter that
        // is still zero is not - that is precisely the slot that was
        // advertised and never delivered.
        if (memory.counter === undefined ? counter > 0 : counter > memory.counter) memory.progressAt = now
        memory.counter = counter
      }
      const progressed = memory.progressAt === now

      const inbound = this.#verdict(live, now, memory.progressAt, memory.liveSince, this.#deadMs)

      // ---- the other direction ------------------------------------------
      const sending = transceiver?.sender.track != null
      if (!sending) memory.sendingSince = undefined
      else if (memory.sendingSince === undefined) memory.sendingSince = Math.max(now, this.#connectedAt ?? now)

      let outbound = mid === null ? undefined : outboundByMid.get(mid)
      let remote = pickRemoteInbound(outbound, remoteInboundBySsrc)
      // The sender's own report, for the engines that leave `mid` off
      // `outbound-rtp` exactly as Firefox leaves it off `inbound-rtp`. Without
      // this the slot's ssrc is unknown, its `remote-inbound-rtp` is never
      // found, and a call where every packet is arriving in both directions
      // reads as "the far end is receiving nothing from us".
      if (remote === undefined && sending && transceiver?.sender.getStats) {
        try {
          const scoped = await transceiver.sender.getStats()
          const bySsrc = new Map<number, Record<string, unknown>>()
          scoped.forEach((raw) => {
            const candidate = raw as Record<string, unknown>
            if (candidate.type === 'outbound-rtp') outbound = candidate
            else if (candidate.type === 'remote-inbound-rtp' && typeof candidate.ssrc === 'number') {
              bySsrc.set(candidate.ssrc, candidate)
            }
          })
          remote = pickRemoteInbound(outbound, bySsrc) ?? pickRemoteInbound(outbound, remoteInboundBySsrc)
        } catch {
          // A sender that will not report is one with nothing to report.
        }
      }
      const figures = readRemoteInbound(remote)
      if (figures) {
        const before = memory.rtcp
        // §3.4's order: a round-trip measurement is the strongest evidence
        // the far end answered at all, the report's own timestamp is the
        // next, and a moving loss count at least proves the report is new.
        const advanced =
          before === undefined
            ? figures.measurements > 0 || figures.timestamp > 0 || figures.lost > 0
            : figures.measurements > before.measurements ||
              figures.timestamp > before.timestamp ||
              figures.lost !== before.lost
        if (advanced) memory.rtcpAt = now
        memory.rtcp = figures
      }

      // `sending` alone is not enough to judge this direction. A slot whose
      // RTCP has never been readable at all - no `mid` on `outbound-rtp`, no
      // sender-scoped report, an engine that reports neither - would
      // otherwise read `dead` on a perfectly healthy call, and the ladder
      // would restart and then rebuild it. Never observed is `idle`: this
      // side cannot say, and cannot say is not the same as bad news.
      const rtcp = this.#verdict(sending && memory.rtcp !== undefined, now, memory.rtcpAt, memory.sendingSince, this.#rtcpDeadMs)

      const slot: SlotHealth = { role, mid, advertised: live, inbound, rtcp, progressed }
      if (counter !== undefined) slot.counter = counter
      health.push(slot)
    }

    const deadSlots = health.filter((s) => s.inbound === 'dead').map((s) => s.role)
    const transportOk = health.some((s) => s.progressed)
    const advertisedSlots = health.filter((s) => s.advertised)
    const sample: PairHealthSample = {
      at: now,
      slots: health,
      deadSlots,
      transportOk,
      allDead: advertisedSlots.length > 0 && advertisedSlots.every((s) => s.inbound === 'dead'),
      unreceivedSlots: health.filter((s) => s.rtcp === 'dead').map((s) => s.role),
    }
    this.#last = sample
    try {
      this.#opts.onSample?.(sample)
    } catch {
      // A caller's reaction is not allowed to stop the next sample.
    }
    return sample
  }

  /**
   * One slot's verdict: idle if nothing is expected, ok if something moved
   * recently, dead once it has been silent for the threshold - and never
   * before its grace is up.
   */
  #verdict(expected: boolean, now: number, lastAt: number | undefined, since: number | undefined, deadMs: number): SlotVerdict {
    if (!expected) return 'idle'
    const graceOver = (since ?? now) + this.#graceMs
    if (now < graceOver) return 'idle'
    const last = Math.max(lastAt ?? 0, graceOver)
    return now - last >= deadMs ? 'dead' : 'ok'
  }

  #memoryFor(role: TrackRole): SlotMemory {
    let memory = this.#memory.get(role)
    if (!memory) {
      memory = {}
      this.#memory.set(role, memory)
    }
    return memory
  }

  #arm(): void {
    if (!this.#running || this.#timer !== undefined) return
    this.#timer = this.#clock.setTimer(this.#sampleMs, () => {
      this.#timer = undefined
      if (!this.#running) return
      void this.sample().finally(() => this.#arm())
    })
  }
}

/** Audio is judged on packets and video on decoded frames, because a video
 *  stream can keep receiving packets it cannot decode - which looks exactly
 *  like the frozen picture H5 reproduced. */
function readCounter(stat: Record<string, unknown> | undefined, kind: 'audio' | 'video'): number | undefined {
  if (!stat) return undefined
  if (kind === 'video') {
    const frames = stat.framesDecoded
    if (typeof frames === 'number') return frames
  }
  const packets = stat.packetsReceived
  return typeof packets === 'number' ? packets : undefined
}

/** The `remote-inbound-rtp` that belongs to this outbound stream, matched
 *  the only way the two are linked: the ssrc they share. */
function pickRemoteInbound(
  outbound: Record<string, unknown> | undefined,
  bySsrc: Map<number, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const ssrc = typeof outbound?.ssrc === 'number' ? outbound.ssrc : undefined
  return ssrc === undefined ? undefined : bySsrc.get(ssrc)
}

function readRemoteInbound(stat: Record<string, unknown> | undefined): { measurements: number; timestamp: number; lost: number } | undefined {
  if (!stat) return undefined
  return {
    measurements: typeof stat.roundTripTimeMeasurements === 'number' ? stat.roundTripTimeMeasurements : 0,
    timestamp: typeof stat.timestamp === 'number' ? stat.timestamp : 0,
    lost: typeof stat.packetsLost === 'number' ? stat.packetsLost : 0,
  }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * How long a restarted connection is given to deliver before the pair is
 * rebuilt at the next generation. §3.4, step 2.
 *
 * TURN gets longer because a restart there needs a fresh allocation from the
 * server before ICE can begin, on top of the offer and answer each crossing
 * a public relay.
 */
export const REBUILD_AFTER_RESTART_MS = { direct: 8_000, turn: 12_000 } as const

/** How long a rebuilt connection is given before the pair changes rung.
 *  §3.4, step 3. */
export const NEXT_TIER_AFTER_REBUILD_MS = { direct: 12_000, turn: 20_000 } as const

/** How often the same set of dead slots is reported to the far end. One per
 *  ten seconds is the cost §9 budgets for the `health` signal. */
export const HEALTH_REPORT_MS = 10_000

/** No more than this many rebuilds in `REBUILD_WINDOW_MS`, after which the
 *  rest ladder takes over. The mitigation §9 names for rebuild storms on a
 *  network that is simply bad. */
export const MAX_REBUILDS_PER_WINDOW = 3
export const REBUILD_WINDOW_MS = 60_000

/** What the ladder asks the pair to do. Nothing here acts; the controller
 *  does, and the mesh owns the rung. */
export type LadderAction =
  /** One slot is dead on a transport that is otherwise fine. Tell the far
   *  end, and do nothing else - RTCP cannot express this, and a rebuild
   *  would cost the whole pair for one slot. */
  | { do: 'health'; dead: TrackRole[] }
  /** Step 1: gather again on the connection that exists. */
  | { do: 'restart-ice' }
  /** Step 2: a new connection at `gen + 1`, same rung. */
  | { do: 'rebuild' }
  /** Step 3: a new connection at `gen + 1`, next rung down. */
  | { do: 'next-tier' }
  /** Out of rungs: rest, then start again from the top. */
  | { do: 'rest' }

export type LadderStep = 'healthy' | 'restarting' | 'rebuilding' | 'changing-tier' | 'resting'

export interface PairLadderOptions {
  /** Which rung the pair is on, which is what sets the two deadlines. */
  tier: () => 'direct' | 'turn'
  onAction: (action: LadderAction) => void
  timing?: {
    restartMs?: { direct: number; turn: number }
    rebuildMs?: { direct: number; turn: number }
    healthMs?: number
    rebuildWindowMs?: number
    maxRebuilds?: number
  }
}

/**
 * §3.4's rungs, as a state machine over health samples.
 *
 * Asymmetry is the design, not an accident: the side that is missing media
 * acts at six seconds and the side whose media is not arriving acts at
 * fourteen, so the two ends of a broken pair do not both rebuild it at once -
 * and because a generation always wins over a lower one, a double rebuild
 * costs a round trip rather than a wedge when they do.
 *
 * There is no terminal state. A pair whose two devices are both still in the
 * roster is a pair that should be on a call; what used to end the attempt was
 * a retry counter, and a retry counter is what left people looking at a tile
 * that never came back.
 */
export class PairLadder {
  readonly #opts: PairLadderOptions
  readonly #restartMs: { direct: number; turn: number }
  readonly #rebuildMs: { direct: number; turn: number }
  readonly #healthMs: number
  readonly #rebuildWindowMs: number
  readonly #maxRebuilds: number

  #state: LadderStep = 'healthy'
  #steppedAt = 0
  #rebuildsAt: number[] = []
  #reported: { at: number; dead: string } | undefined

  constructor(opts: PairLadderOptions) {
    this.#opts = opts
    this.#restartMs = opts.timing?.restartMs ?? REBUILD_AFTER_RESTART_MS
    this.#rebuildMs = opts.timing?.rebuildMs ?? NEXT_TIER_AFTER_REBUILD_MS
    this.#healthMs = opts.timing?.healthMs ?? HEALTH_REPORT_MS
    this.#rebuildWindowMs = opts.timing?.rebuildWindowMs ?? REBUILD_WINDOW_MS
    this.#maxRebuilds = opts.timing?.maxRebuilds ?? MAX_REBUILDS_PER_WINDOW
  }

  get state(): LadderStep {
    return this.#state
  }

  /**
   * Back to the top, with no action taken.
   *
   * Two callers: the pair connected, and a higher generation arrived from the
   * far end. The second matters as much as the first - the far end has just
   * rebuilt, so whatever this side was walking the ladder about is a fault on
   * a connection neither of them has any more, and carrying the position
   * across would rebuild the one that has just arrived.
   */
  reset(): void {
    this.#state = 'healthy'
    this.#steppedAt = 0
    this.#reported = undefined
  }

  /**
   * The pair has run out of rungs, as judged by somebody who can see the
   * route table - which this cannot.
   *
   * The ladder reaches `changing-tier` by asking for the next rung; when the
   * answer is "there is no next rung" it has not moved anywhere, and leaving
   * it believing it had would spend the TURN deadline waiting to take a step
   * it has already been refused. No action comes out of this: the controller
   * is already resting, and it says when the pair starts again.
   */
  rest(): void {
    this.#state = 'resting'
  }

  /** One sample. At most one action comes out of it. */
  observe(sample: PairHealthSample): void {
    const now = sample.at
    const broken = sample.allDead || this.#outboundLost(sample)

    if (!broken) {
      // "Not broken" is not the same as "better", and the difference is the
      // whole of step 2. A connection this side has just rebuilt spends its
      // grace with every slot `idle`, which is not `allDead` - so a ladder
      // that went healthy here would forget it was mid-rebuild, and when the
      // grace ended it would start again at step 1. That is a pair that
      // restarts and rebuilds for the length of a call and never changes
      // rung. So the way back to healthy is positive evidence: something is
      // actually arriving.
      if (sample.transportOk && this.#state !== 'healthy') {
        this.#state = 'healthy'
        this.#steppedAt = 0
      }
      this.#reportDeadSlots(sample)
      return
    }

    // From here the transport is the problem rather than a slot, so the
    // `health` signal has nothing useful to say: the far end would not
    // receive it either.
    switch (this.#state) {
      case 'healthy':
        this.#step('restarting', now, { do: 'restart-ice' })
        return
      case 'restarting':
        if (now - this.#steppedAt < this.#restartMs[this.#opts.tier()]) return
        this.#rebuild(now)
        return
      case 'rebuilding':
        if (now - this.#steppedAt < this.#rebuildMs[this.#opts.tier()]) return
        this.#step('changing-tier', now, { do: 'next-tier' })
        return
      case 'changing-tier':
        if (now - this.#steppedAt < this.#rebuildMs[this.#opts.tier()]) return
        this.#step('resting', now, { do: 'rest' })
        return
      case 'resting':
        // The controller owns the rest and will say when the pair starts
        // again. Nothing here should keep asking.
        return
    }
  }

  /** The RTCP backstop: we are sending, and nothing we send is getting
   *  through, on every slot we send on. The far end plainly did not act - it
   *  is profile 1, or the current Android build - so this side does. */
  #outboundLost(sample: PairHealthSample): boolean {
    if (sample.unreceivedSlots.length === 0) return false
    return !sample.slots.some((slot) => slot.rtcp === 'ok')
  }

  #reportDeadSlots(sample: PairHealthSample): void {
    if (sample.deadSlots.length === 0 || !sample.transportOk) {
      this.#reported = undefined
      return
    }
    const dead = sample.deadSlots.join(',')
    // Immediately when the set changes, and otherwise once per window: a far
    // end whose encoder is stuck keeps being told, but not every two seconds.
    if (this.#reported?.dead === dead && sample.at - this.#reported.at < this.#healthMs) return
    this.#reported = { at: sample.at, dead }
    this.#emit({ do: 'health', dead: [...sample.deadSlots] })
  }

  /** Step 2, unless this pair has been rebuilt too often lately - in which
   *  case the honest answer is to stop churning and rest. */
  #rebuild(now: number): void {
    this.#rebuildsAt = this.#rebuildsAt.filter((at) => now - at < this.#rebuildWindowMs)
    if (this.#rebuildsAt.length >= this.#maxRebuilds) {
      this.#step('resting', now, { do: 'rest' })
      return
    }
    this.#rebuildsAt.push(now)
    this.#step('rebuilding', now, { do: 'rebuild' })
  }

  #step(state: LadderStep, now: number, action: LadderAction): void {
    this.#state = state
    this.#steppedAt = now
    this.#emit(action)
  }

  #emit(action: LadderAction): void {
    try {
      this.#opts.onAction(action)
    } catch {
      // A caller that throws must not stop the next sample being judged.
    }
  }
}
