/**
 * How long a signalling event stays acceptable, in seconds.
 *
 * Signalling is live state. An offer that is half a minute old describes a
 * connection attempt that has already been superseded, and applying it forces
 * a renegotiation nobody asked for - which is exactly what a hostile or buggy
 * relay re-delivering a captured wrap achieves. Reused from NIP-AC, as §3 of
 * the design says.
 *
 * The window is symmetric, so a sender cannot mint a wrap that stays
 * acceptable for ever by stamping it years ahead. It is also the tolerance
 * two devices' clocks are allowed to differ by: a device whose clock is a
 * minute out will not connect to anybody, which is a real deployment hazard
 * and the reason this is a constant rather than a hard-coded number.
 */
export const SIGNAL_MAX_AGE_SECONDS = 20

/** The rate-limit window, in seconds. */
export const RATE_WINDOW_SECONDS = 20

/**
 * How many signals one sending device may deliver per window.
 *
 * Generous by design: one negotiation is an offer, an answer and a few dozen
 * trickled candidates, and a track toggle starts another. This is a bound on
 * abuse, not a traffic shaper - a peer that trips it is flooding.
 */
export const MAX_SIGNALS_PER_WINDOW = 120

/**
 * How many event ids and senders are remembered.
 *
 * Both tables have to be bounded: a room left open all day would otherwise
 * accumulate an entry per signal until the tab ran out of memory, which is
 * the same free memory sink an unbounded candidate buffer gives away.
 */
export const MAX_REMEMBERED_SIGNALS = 4096

/**
 * The three rules the design says signalling reuses from NIP-AC: staleness,
 * deduplication and rate limiting. Staleness lives in `unwrapSignal`, where
 * the timestamp is; the other two live here, because they are about the
 * history of what this device has already been handed.
 *
 * Deliberately not a transport concern. Publishing to every relay means the
 * same wrap arrives from every relay, and a relay that means harm can send it
 * again later - so the room, not the socket, is what has to hear each signal
 * exactly once.
 */
export class SignalGuard {
  /** Insertion-ordered, which is what makes the oldest evictable. */
  readonly #seen = new Set<string>()
  readonly #senders = new Map<string, { windowStart: number; count: number }>()

  /** True the first time an event id is offered, false every time after. */
  admitEvent(id: string): boolean {
    if (this.#seen.has(id)) return false
    this.#seen.add(id)
    while (this.#seen.size > MAX_REMEMBERED_SIGNALS) {
      const oldest = this.#seen.values().next().value
      if (oldest === undefined) break
      this.#seen.delete(oldest)
    }
    return true
  }

  /**
   * True while `sender` is within its budget for the current window.
   *
   * A fixed window rather than a sliding one: a burst straddling a boundary
   * can pass twice the budget, which is a rounding error against a flood and
   * costs one number per sender instead of a list of timestamps.
   */
  admitSender(sender: string, now: number): boolean {
    const entry = this.#senders.get(sender)
    if (!entry || now - entry.windowStart >= RATE_WINDOW_SECONDS) {
      this.#senders.set(sender, { windowStart: now, count: 1 })
      this.#evictSenders()
      return true
    }
    if (entry.count >= MAX_SIGNALS_PER_WINDOW) return false
    entry.count++
    return true
  }

  /** Remembered event ids. Exposed so a test can prove the bound bites. */
  get size(): number {
    return this.#seen.size
  }

  /** Tracked senders. Exposed for the same reason. */
  get senderCount(): number {
    return this.#senders.size
  }

  #evictSenders(): void {
    while (this.#senders.size > MAX_REMEMBERED_SIGNALS) {
      const oldest = this.#senders.keys().next().value
      if (oldest === undefined) break
      this.#senders.delete(oldest)
    }
  }
}
