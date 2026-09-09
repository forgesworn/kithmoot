import type { ScreenAnnotation } from '../../src/signal.js'

/**
 * Marks drawn on a screen share, kept only for as long as they are useful.
 *
 * A stroke is a pointer, not a record: "there, that button". It is drawn to
 * be seen in the moment by the person sharing, so it holds for a couple of
 * seconds and then fades, and nothing about it is kept once it has gone.
 * Every device in the room gets the same stroke over signalling (see
 * docs/protocol.md), and this store is the one place a page keeps them,
 * whether it paints them in the expanded viewer or over a preview tile.
 */
export const HOLD_MS = 2000
export const FADE_MS = 1000
export const MARK_LIFETIME_MS = HOLD_MS + FADE_MS

/** How strongly a stroke of this age should be painted: solid, then gone. */
export function markAlpha(ageMs: number): number {
  if (ageMs < HOLD_MS) return 1
  return Math.max(0, 1 - (ageMs - HOLD_MS) / FADE_MS)
}

export interface LiveMark { annotation: ScreenAnnotation; alpha: number }

const MAX_STROKES_PER_SHARE = 100
const MAX_SHARES = 16
const TICK_MS = 50

export class ShareMarks {
  readonly #kept = new Map<string, { annotation: ScreenAnnotation; at: number }[]>()
  readonly #listeners = new Set<() => void>()
  readonly #now: () => number
  readonly #later: (fn: () => void, ms: number) => void
  #ticking = false

  constructor(now: () => number = () => Date.now(), later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) }) {
    this.#now = now
    this.#later = later
  }

  /** Keep a stroke, or drop every stroke on a share for a clear. Duplicates
   *  by stroke id are ignored, so a stroke that arrives twice is one mark. */
  remember(annotation: ScreenAnnotation): void {
    if (annotation.op === 'clear') {
      this.#kept.delete(annotation.shareId)
      this.#notify()
      return
    }
    const strokes = this.#kept.get(annotation.shareId) ?? []
    if (strokes.some(kept => kept.annotation.strokeId === annotation.strokeId)) return
    strokes.push({ annotation, at: this.#now() })
    while (strokes.length > MAX_STROKES_PER_SHARE) strokes.shift()
    this.#kept.delete(annotation.shareId)
    this.#kept.set(annotation.shareId, strokes)
    while (this.#kept.size > MAX_SHARES) {
      const oldest = this.#kept.keys().next().value
      if (oldest === undefined) break
      this.#kept.delete(oldest)
    }
    this.#notify()
    this.#tick()
  }

  /** The strokes still showing on a share, each with how strongly to paint
   *  it. Strokes past their lifetime are forgotten on the way out. */
  alive(shareId: string): LiveMark[] {
    const strokes = this.#kept.get(shareId)
    if (!strokes) return []
    const now = this.#now()
    const live = strokes.filter(kept => now - kept.at < MARK_LIFETIME_MS)
    if (live.length === 0) this.#kept.delete(shareId)
    else if (live.length !== strokes.length) this.#kept.set(shareId, live)
    return live.map(kept => ({ annotation: kept.annotation, alpha: markAlpha(now - kept.at) }))
  }

  /** True while any share has a stroke still showing. */
  get any(): boolean {
    for (const shareId of [...this.#kept.keys()]) if (this.alive(shareId).length > 0) return true
    return false
  }

  /** Called whenever what should be painted has changed, including on every
   *  step of a fade, so a painter needs no timer of its own. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener()
  }

  #tick(): void {
    if (this.#ticking) return
    this.#ticking = true
    this.#later(() => {
      this.#ticking = false
      this.#notify()
      if (this.any) this.#tick()
    }, TICK_MS)
  }
}
