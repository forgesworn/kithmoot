/**
 * Who is talking, decided from audio energy alone.
 *
 * A speaking indicator has one job and two ways to get it wrong. Too eager
 * and every tile flickers on a cough, a keyboard and the fan; too slow and
 * the light arrives after the sentence. Both failures are worse than no
 * indicator at all, because a wrong one teaches people to stop believing it.
 *
 * Energy-based and deliberately so, matching `node/utterances.ts`: a real
 * voice-activity model would be better in a noisy room and worse at being
 * something a unit test can exercise with numbers, and nothing downstream of
 * this makes a decision that matters - it lights a border.
 *
 * Runtime-agnostic. The AudioContext, the AnalyserNode and the tile all live
 * in the app; this takes a level and a clock and answers yes or no.
 */

export interface SpeakingThresholds {
  /** RMS at or above which somebody starts speaking. */
  on: number
  /** RMS below which they are heading towards stopping. */
  off: number
  /** How long the level has to stay under `off` before they have stopped. */
  hangoverMs: number
}

/**
 * Two thresholds, not one, and a hangover.
 *
 * `on` above `off` is hysteresis: with a single threshold a voice sitting
 * right at it chatters on and off several times a second, which is the most
 * annoying possible failure and the easiest to miss in testing, because a
 * test with a clean sine wave never sits at the boundary.
 *
 * `off` is the utterance splitter's silence threshold, so "not speaking"
 * means the same thing to the indicator and to the scribe.
 *
 * `on` is twice that, so ordinary room noise - a fan, traffic, a laptop -
 * does not light a tile up. Somebody actually talking clears it easily.
 *
 * 400ms of hangover covers the gaps inside speech. Between words is 50-200ms
 * and a comma is longer; without it the indicator strobes through a normal
 * sentence. It is short enough that a tile does not keep claiming somebody
 * is talking well after they stopped.
 */
export const SPEAKING: SpeakingThresholds = {
  on: 0.02,
  off: 0.01,
  hangoverMs: 400,
}

/**
 * Turns a stream of levels into a stable yes or no.
 *
 * One per audio source. The clock is passed in rather than read, so a test
 * can drive a whole sentence in a millisecond and so two detectors judged in
 * the same pass agree about what "now" is.
 */
export class SpeakingDetector {
  #speaking = false
  /** When the level first went under `off` while speaking. Undefined while
   *  the level is up, or while not speaking at all. */
  #quietSince: number | undefined

  readonly #thresholds: SpeakingThresholds

  constructor(thresholds: SpeakingThresholds = SPEAKING) {
    this.#thresholds = thresholds
  }

  /** Whether this source is currently speaking, without advancing anything. */
  get speaking(): boolean {
    return this.#speaking
  }

  /**
   * Feeds in one measurement and returns the current answer.
   *
   * `now` is milliseconds from any origin, as long as it is the same origin
   * every time for this detector.
   */
  update(level: number, now: number): boolean {
    const { on, off, hangoverMs } = this.#thresholds

    if (!this.#speaking) {
      // Starting is immediate. A delay here is a delay before the room can
      // see who is talking, which is the whole feature.
      if (level >= on) {
        this.#speaking = true
        this.#quietSince = undefined
      }
      return this.#speaking
    }

    if (level >= off) {
      // Still going, or back inside a gap. Either way the hangover restarts.
      this.#quietSince = undefined
      return true
    }

    // Under `off` while speaking: run the hangover.
    if (this.#quietSince === undefined) {
      this.#quietSince = now
      return true
    }
    if (now - this.#quietSince >= hangoverMs) {
      this.#speaking = false
      this.#quietSince = undefined
    }
    return this.#speaking
  }

  /**
   * Forgets everything, for a source that has gone away.
   *
   * A detector kept across a track being replaced would otherwise report the
   * old track's last state until the new one produced enough audio to move
   * it - a tile still lit for somebody who has just muted.
   */
  reset(): void {
    this.#speaking = false
    this.#quietSince = undefined
  }
}

/**
 * Keeps one detector per source and answers for all of them.
 *
 * Sources are keyed by whatever the caller finds convenient - a device id, a
 * track id. `forget` is not optional housekeeping: a room that ran for an
 * afternoon accumulates a detector per device that ever joined, and a stale
 * one that still reads `speaking` keeps a departed person's tile lit if the
 * key is ever reused.
 */
export class SpeakingSet {
  readonly #detectors = new Map<string, SpeakingDetector>()
  readonly #thresholds: SpeakingThresholds

  constructor(thresholds: SpeakingThresholds = SPEAKING) {
    this.#thresholds = thresholds
  }

  update(key: string, level: number, now: number): boolean {
    let detector = this.#detectors.get(key)
    if (!detector) {
      detector = new SpeakingDetector(this.#thresholds)
      this.#detectors.set(key, detector)
    }
    return detector.update(level, now)
  }

  speaking(key: string): boolean {
    return this.#detectors.get(key)?.speaking ?? false
  }

  /** Every key currently speaking. */
  active(): string[] {
    const out: string[] = []
    for (const [key, detector] of this.#detectors) if (detector.speaking) out.push(key)
    return out
  }

  forget(key: string): void {
    this.#detectors.delete(key)
  }

  /** Drops every detector whose key is not in `keys`, so the map tracks the
   *  room rather than growing with it. */
  retain(keys: Iterable<string>): void {
    const keep = new Set(keys)
    for (const key of this.#detectors.keys()) if (!keep.has(key)) this.#detectors.delete(key)
  }
}
