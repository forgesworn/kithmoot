/**
 * Whether a notice telling the sharer "somebody is drawing on your screen"
 * is worth showing right now, or would just be noise.
 *
 * A person pointing at something draws several strokes in a row, and
 * without this every one of them would pop the same notice again. So one
 * drawer earns one notice, and then nothing more from them until the rate
 * limit has passed - a different drawer is never held back by that, because
 * two people pointing at two different things are two different things to
 * know about.
 */
export const DEFAULT_NOTICE_RATE_LIMIT_MS = 10_000

export interface DrawingNoticeGateOptions {
  rateLimitMs?: number
  now?: () => number
}

export class DrawingNoticeGate {
  readonly #rateLimitMs: number
  readonly #now: () => number
  readonly #lastShown = new Map<string, number>()

  constructor(opts: DrawingNoticeGateOptions = {}) {
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_NOTICE_RATE_LIMIT_MS
    this.#now = opts.now ?? (() => Date.now())
  }

  /** True the first time this drawer is asked about, and again once the
   *  rate limit has passed since the last time this answered true - which
   *  it also records, so asking is itself what starts the next window. */
  shouldShow(drawer: string): boolean {
    const now = this.#now()
    const last = this.#lastShown.get(drawer)
    if (last !== undefined && now - last < this.#rateLimitMs) return false
    this.#lastShown.set(drawer, now)
    return true
  }
}
