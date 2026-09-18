/**
 * The per-pair controller of the call reliability design, §3.4.
 *
 * On a profile-1 pair the mesh's route ladder is the only watchdog there is:
 * a timer per rung, a rest after the last one, and nothing at all once the
 * pair has connected. That is the shape H1 exploits - a renegotiation that
 * fails on a connected pair has no clock on it - and the shape H2 exploits,
 * because the two sides' rests drift apart with no shared input and a pair
 * can chase itself round the ladder for the rest of a call.
 *
 * A profile-2 pair does not need the rung timers, because it has something
 * far better to go on: it can see whether media is actually arriving, per
 * slot, every two seconds, and it can say so to the far end. So for these
 * pairs this controller replaces `#armRouteTimerIfNeeded`,
 * `#armRouteTimerForOffer` and the exhausted retry timer on the `direct` and
 * `turn` rungs. Assist and forwarder rungs keep today's behaviour exactly,
 * and the controller suspends itself while a forwarder is carrying the room -
 * a pair that is not being negotiated must not be measured, let alone rebuilt.
 *
 * S6 is the skeleton: lifecycle, suspension and the rest ladder that stands
 * in for the exhausted retry timer. The health sampler (S7) and the rungs
 * above the rest - ICE restart, rebuild, tier - are S8, and they arrive as
 * `ladder` below without moving anything here.
 */

import type { ChannelClock } from './signal-channel.js'
import type { SlotPeer } from './slot-peer.js'
import type { TrackRole } from './types.js'

const REAL_CLOCK: ChannelClock = {
  now: () => Date.now(),
  setTimer: (ms, run) => {
    const timer = setTimeout(run, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The rest between one walk of the ladder and the next, per §3.4's last row:
 * 5s, 10s, 20s, 40s, capped at 60s, jittered +/-25%.
 *
 * There is deliberately no terminal state. A profile-2 pair whose two devices
 * are both still in the roster is a pair that should be on a call, and the
 * only honest thing a client can do is keep trying and say "reconnecting"
 * while it does. What used to end the attempt was a retry counter, and a
 * retry counter is what left people staring at a tile that would never come
 * back.
 */
export const PAIR_REST_MS = 5_000
export const MAX_PAIR_REST_MS = 60_000
export const PAIR_REST_JITTER = 0.25

/** Where a pair is in §3.4's ladder. Diagnostics, and the one word a bug
 *  report needs for "why is this direction dead". */
export type LadderState =
  /** Nothing is wrong, or nothing has been measured yet. */
  | 'healthy'
  /** A forwarder is carrying the room, so this pair is not being negotiated
   *  and is not being judged either. */
  | 'suspended'
  /** Step 1: ICE restarted inside the current generation. */
  | 'restarting'
  /** Step 2: rebuilt at `gen + 1` on the same rung. */
  | 'rebuilding'
  /** Step 3: rebuilt at `gen + 1` on the next rung. */
  | 'changing-tier'
  /** Out of rungs, waiting out a rest before starting again from the top. */
  | 'resting'

/** What a bug report says about one profile-2 pair. See §8, step S12. */
export interface PairDiagnostics {
  /** The remote device, as the caller gave it. Shortened by the reporter,
   *  never here: this module has no opinion about what is safe to paste. */
  device: string
  /** The pair generation this side is on. Zero before the first offer. */
  generation: number
  ladder: LadderState
  /** Signals sent and not yet acknowledged by the far end. */
  unacked: number
  /** Per slot, whether inbound has progressed in the last sample window.
   *  Absent until the sampler has two samples to compare. */
  inbound?: Partial<Record<TrackRole, 'ok' | 'dead' | 'idle'>>
  /** Per slot, what RTCP says about what the far end is receiving from us. */
  rtcp?: Partial<Record<TrackRole, 'ok' | 'dead' | 'idle'>>
  /** `negotiationneeded` on a slotted connection: always a bug, and always
   *  worth naming. See section 9 of the spec. */
  unexpectedNegotiations: number
}

export interface PairControllerOptions {
  /** The remote device this pair is with. */
  device: string
  /**
   * Start this pair's route ladder again from the top rung.
   *
   * Called when a rest is over. The mesh owns the route table, so it is the
   * mesh that decides what "from the top" means for this device - and the
   * controller deliberately does not reach into it.
   */
  onRestOver: () => void
  /** Free text for the bug report's timeline. Never anything secret. */
  onDiagnostic?: (detail: string) => void
  /** Defaults to the constants above; tests shorten them. */
  rest?: { baseMs?: number; maxMs?: number; jitter?: number }
  random?: () => number
  clock?: ChannelClock
}

/**
 * One profile-2 pair's lifecycle.
 *
 * Lives as long as the pair does, not as long as any one connection: a
 * rebuild replaces the `SlotPeer` and the controller is what carries the rest
 * ladder's position across it. That is the whole reason it is a separate
 * object from the peer.
 */
export class PairController {
  readonly device: string

  readonly #onRestOver: () => void
  readonly #onDiagnostic: ((detail: string) => void) | undefined
  readonly #clock: ChannelClock
  readonly #random: () => number
  readonly #restMs: number
  readonly #maxRestMs: number
  readonly #restJitter: number

  #peer: SlotPeer | undefined
  #ladder: LadderState = 'healthy'
  #suspended = false
  #closed = false
  #restAttempt = 0
  #restTimer: unknown

  constructor(opts: PairControllerOptions) {
    this.device = opts.device
    this.#onRestOver = opts.onRestOver
    this.#onDiagnostic = opts.onDiagnostic
    this.#clock = opts.clock ?? REAL_CLOCK
    this.#random = opts.random ?? Math.random
    this.#restMs = opts.rest?.baseMs ?? PAIR_REST_MS
    this.#maxRestMs = opts.rest?.maxMs ?? MAX_PAIR_REST_MS
    this.#restJitter = opts.rest?.jitter ?? PAIR_REST_JITTER
  }

  /** The connection this pair is currently on, if it has one. */
  get peer(): SlotPeer | undefined {
    return this.#peer
  }

  get ladder(): LadderState {
    return this.#suspended ? 'suspended' : this.#ladder
  }

  /** Whether this controller is currently the pair's watchdog. False while a
   *  forwarder is carrying the room, and the one question `Mesh` asks before
   *  it decides not to arm a route timer. */
  get active(): boolean {
    return !this.#closed && !this.#suspended
  }

  get resting(): boolean {
    return this.#restTimer !== undefined
  }

  /** A new connection for this pair: the first one, or a rebuild's. */
  attach(peer: SlotPeer): void {
    if (this.#closed) return
    this.#peer = peer
  }

  /** The connection is gone and no replacement has arrived yet. The rest
   *  ladder's position is deliberately kept: a pair that fails, is rebuilt
   *  and fails again has not started afresh. */
  detach(): void {
    this.#peer = undefined
  }

  /** The pair is carrying media again. Whatever was wrong is not wrong now. */
  connected(): void {
    if (this.#closed) return
    this.#restAttempt = 0
    this.#ladder = 'healthy'
    this.#clearRest()
  }

  /**
   * Every rung has been tried and none of them worked.
   *
   * This is the mesh's `#armRetryTimer` for a profile-2 pair, and the one
   * behavioural difference is that it never stops: `EXHAUSTED_RETRY_MS`
   * doubles without a cap on attempts either, but the route it retries has a
   * terminal `exhausted` flag that a UI shows as "could not connect". For a
   * profile-2 pair with both devices in the roster there is no such state -
   * the UI says "reconnecting" - so the rest simply comes round again.
   */
  exhausted(): void {
    if (this.#closed || this.#suspended) return
    if (this.#restTimer !== undefined) return
    this.#ladder = 'resting'
    const wait = this.#restDelay()
    this.#restAttempt += 1
    this.#diagnose(`resting ${Math.round(wait / 1000)}s before trying this pair again`)
    this.#restTimer = this.#clock.setTimer(wait, () => {
      this.#restTimer = undefined
      if (this.#closed || this.#suspended) return
      this.#ladder = 'healthy'
      this.#diagnose('rest over; trying this pair from the top rung')
      this.#onRestOver()
    })
  }

  /**
   * A forwarder is carrying the room.
   *
   * Nothing is measured and nothing is rebuilt while it is: the pair has no
   * direct connection to judge, and a rest that fired under a forwarder would
   * ask the mesh to reopen a peer the promotion had just closed.
   */
  suspend(): void {
    if (this.#closed || this.#suspended) return
    this.#suspended = true
    this.#clearRest()
    this.#peer = undefined
  }

  /** The room is a direct mesh again. */
  resume(): void {
    if (this.#closed || !this.#suspended) return
    this.#suspended = false
    this.#ladder = 'healthy'
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearRest()
    this.#peer = undefined
  }

  /** What the bug report says about this pair. */
  summary(): PairDiagnostics {
    return {
      device: this.device,
      generation: this.#peer?.generation ?? 0,
      ladder: this.ladder,
      unacked: this.#peer?.queueDepth ?? 0,
      unexpectedNegotiations: this.#peer?.unexpectedNegotiations ?? 0,
    }
  }

  /** 5s, 10s, 20s, 40s, capped, each spread by +/-`#restJitter`. Jittered
   *  because two sides that failed together must not retry together for
   *  ever - which is exactly the lockstep H2 describes. */
  #restDelay(): number {
    const doublings = Math.min(this.#restAttempt, 20)
    const step = Math.min(this.#restMs * 2 ** doublings, this.#maxRestMs)
    const spread = 1 + (this.#random() * 2 - 1) * this.#restJitter
    return Math.max(1, Math.round(step * spread))
  }

  #clearRest(): void {
    if (this.#restTimer !== undefined) this.#clock.clearTimer(this.#restTimer)
    this.#restTimer = undefined
  }

  #diagnose(detail: string): void {
    try {
      this.#onDiagnostic?.(detail)
    } catch {
      // A caller's logger is not allowed to be what breaks a call.
    }
  }
}
