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

/**
 * Who drew a mark, resolved once when it arrives rather than looked up
 * fresh on every paint - a person's name or colour changing mid-fade is not
 * worth the coupling to a live roster this module otherwise has no need of.
 */
export interface MarkAuthor {
  /** The participant pubkey. Every device of theirs, and every stroke of
   *  theirs however it arrived, carries the same key - so a colour and a
   *  chip stay one person's, not one wire event's. */
  key: string
  /** What the name chip says: the roster display name with the short key
   *  the app shows beside names everywhere (see `personLabel` in main.ts),
   *  or just the short key when there is no name yet. */
  label: string
  color: string
}

/** This device's own strokes keep the one colour the drawing tool always
 *  had, from before other people's strokes needed telling apart. */
export const OWN_MARK_COLOUR = '#ffd447'

/** Everybody else's strokes, in a small set of colours picked to stay
 *  legible over arbitrary screen content - a slide, a terminal, a video
 *  tile - the way `paintStroke` always draws them: a dark halo under a
 *  fairly light, saturated line. Deliberately without `OWN_MARK_COLOUR`,
 *  so nobody else's stroke is ever mistaken for this device's own. */
const OTHER_MARK_COLOURS = ['#5ec8ff', '#ff6b9d', '#7ee787', '#c792ea', '#ff9f5b', '#8fa6ff']

/**
 * Which of `OTHER_MARK_COLOURS` a participant's strokes get.
 *
 * Deterministic and needing no coordination: every device in the room hashes
 * the same pubkey to the same index, so two people's marks never need to
 * negotiate who is which colour, and the same person is the same colour
 * again after a reload or on somebody else's screen entirely.
 */
export function colourForParticipant(participant: string): string {
  let hash = 0
  for (let i = 0; i < participant.length; i++) hash = (Math.imul(hash, 31) + participant.charCodeAt(i)) >>> 0
  return OTHER_MARK_COLOURS[hash % OTHER_MARK_COLOURS.length]!
}

export interface LiveMark { annotation: ScreenAnnotation; alpha: number; author: MarkAuthor }

const MAX_STROKES_PER_SHARE = 100
const MAX_SHARES = 16
const TICK_MS = 50

export class ShareMarks {
  readonly #kept = new Map<string, { annotation: ScreenAnnotation; at: number; author: MarkAuthor }[]>()
  readonly #listeners = new Set<() => void>()
  readonly #now: () => number
  readonly #later: (fn: () => void, ms: number) => void
  #ticking = false

  constructor(now: () => number = () => Date.now(), later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) }) {
    this.#now = now
    this.#later = later
  }

  /** Keep a stroke under the author who drew it, or drop every stroke on a
   *  share for a clear - `author` is only ever painted, never needed to
   *  decide what a clear removes, so a clear's author is not looked at.
   *  Duplicates by stroke id are ignored, so a stroke that arrives twice is
   *  one mark. */
  remember(annotation: ScreenAnnotation, author: MarkAuthor): void {
    if (annotation.op === 'clear') {
      this.#kept.delete(annotation.shareId)
      this.#notify()
      return
    }
    const strokes = this.#kept.get(annotation.shareId) ?? []
    if (strokes.some(kept => kept.annotation.strokeId === annotation.strokeId)) return
    strokes.push({ annotation, at: this.#now(), author })
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
    return live.map(kept => ({ annotation: kept.annotation, alpha: markAlpha(now - kept.at), author: kept.author }))
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
