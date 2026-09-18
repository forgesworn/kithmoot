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
  /** Whether anything at all is arriving on this connection. */
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

      const inbound = this.#verdict(live, now, memory.progressAt, memory.liveSince, this.#deadMs)

      // ---- the other direction ------------------------------------------
      const sending = transceiver?.sender.track != null
      if (!sending) memory.sendingSince = undefined
      else if (memory.sendingSince === undefined) memory.sendingSince = Math.max(now, this.#connectedAt ?? now)

      const outbound = mid === null ? undefined : outboundByMid.get(mid)
      const ssrc = typeof outbound?.ssrc === 'number' ? outbound.ssrc : undefined
      const remote = ssrc === undefined ? undefined : remoteInboundBySsrc.get(ssrc)
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

      const rtcp = this.#verdict(sending, now, memory.rtcpAt, memory.sendingSince, this.#rtcpDeadMs)

      const slot: SlotHealth = { role, mid, advertised: live, inbound, rtcp }
      if (counter !== undefined) slot.counter = counter
      health.push(slot)
    }

    const deadSlots = health.filter((s) => s.inbound === 'dead').map((s) => s.role)
    const transportOk = health.some((s) => s.inbound === 'ok')
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

function readRemoteInbound(stat: Record<string, unknown> | undefined): { measurements: number; timestamp: number; lost: number } | undefined {
  if (!stat) return undefined
  return {
    measurements: typeof stat.roundTripTimeMeasurements === 'number' ? stat.roundTripTimeMeasurements : 0,
    timestamp: typeof stat.timestamp === 'number' ? stat.timestamp : 0,
    lost: typeof stat.packetsLost === 'number' ? stat.packetsLost : 0,
  }
}
