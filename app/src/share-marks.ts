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
 * fresh on every paint - a person's name changing mid-fade is not worth the
 * coupling to a live roster this module otherwise has no need of. Colour is
 * deliberately not part of this: see `colourForParticipant` for why it has
 * to depend on who else is drawing on the same share right now, and so is
 * resolved fresh, on `LiveMark`, every time marks are read rather than
 * stored with the stroke.
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
}

/**
 * Every stroke's colour, whoever drew it and wherever it is seen: "the blue
 * arrow" has to mean the same arrow to everybody in the room, including the
 * person who drew it, so there is no separate "this device's own" colour
 * any more - one hash of the pubkey, used everywhere. Picked to stay
 * legible over arbitrary screen content - a slide, a terminal, a video tile
 * - the way `paintStroke` always draws them: a dark halo under a fairly
 * light, saturated line.
 */
export const MARK_COLOURS = ['#ffd447', '#5ec8ff', '#ff6b9d', '#7ee787', '#c792ea', '#ff9f5b', '#8fa6ff']

function hashIndex(participant: string): number {
  let hash = 0
  for (let i = 0; i < participant.length; i++) hash = (Math.imul(hash, 31) + participant.charCodeAt(i)) >>> 0
  return hash % MARK_COLOURS.length
}

/**
 * A participant's colour on its own, with no regard to who else is drawing.
 *
 * Deterministic and needing no coordination: every device in the room hashes
 * the same pubkey to the same index, so the same person is the same colour
 * everywhere - their own screen, the sharer's, a third viewer's - with
 * nothing exchanged to agree on it. Two different people can still hash to
 * the same colour; `coloursForShare` is what a painter actually wants,
 * because it tells two people apart when they are both drawing on the same
 * share right now.
 */
export function colourForParticipant(participant: string): string {
  return MARK_COLOURS[hashIndex(participant)]!
}

/**
 * Colours for everyone currently drawing on one share, clash-free while the
 * palette allows it.
 *
 * Each participant starts at their `colourForParticipant` index. Sorted by
 * pubkey - an order every device can compute alone - a clash moves to the
 * next free index, wrapping around, so two devices that agree on who is
 * currently drawing on a share agree on this too, with nothing exchanged
 * beyond the strokes themselves. With more concurrent drawers on one share
 * than `MARK_COLOURS` has entries, the palette runs out and repeats - a
 * known limit, not a bug, and one this many people drawing at once on a
 * single screen is unlikely to reach.
 *
 * The one thing this cannot promise: two devices that do not yet agree on
 * who is currently drawing - one has heard of a stroke the other has not,
 * or has already let one fade - can resolve a clash differently until they
 * catch up. Once they agree on the set, they agree on the colours. A
 * corollary worth knowing: because this is recomputed fresh from whoever is
 * live each time (see `ShareMarks.alive`), an already-shown mark's colour
 * can shift if a clashing colour's owner starts, or stops, drawing on the
 * same share while it is still fading - the price of actually telling two
 * concurrent drawers apart rather than a colour fixed for life the moment a
 * stroke lands.
 */
export function coloursForShare(participants: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(participants)].sort()
  const used = new Set<number>()
  const colours = new Map<string, string>()
  for (const participant of sorted) {
    let index = hashIndex(participant)
    if (used.size < MARK_COLOURS.length) while (used.has(index)) index = (index + 1) % MARK_COLOURS.length
    used.add(index)
    colours.set(participant, MARK_COLOURS[index]!)
  }
  return colours
}

export interface LiveMark { annotation: ScreenAnnotation; alpha: number; author: MarkAuthor; color: string }

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
   *  it and a colour resolved against everybody else currently on it.
   *  Strokes past their lifetime are forgotten on the way out. */
  alive(shareId: string): LiveMark[] {
    const strokes = this.#kept.get(shareId)
    if (!strokes) return []
    const now = this.#now()
    const live = strokes.filter(kept => now - kept.at < MARK_LIFETIME_MS)
    if (live.length === 0) this.#kept.delete(shareId)
    else if (live.length !== strokes.length) this.#kept.set(shareId, live)
    const colours = coloursForShare(live.map(kept => kept.author.key))
    return live.map(kept => ({ annotation: kept.annotation, alpha: markAlpha(now - kept.at), author: kept.author, color: colours.get(kept.author.key)! }))
  }

  /** The colour a participant would get on a share right now, alongside
   *  whoever is already live on it - for a stroke still being drawn, which
   *  is not yet one of `alive`'s marks and so would otherwise be left out
   *  of the same clash resolution. */
  colourFor(shareId: string, participant: string): string {
    const now = this.#now()
    const keys = (this.#kept.get(shareId) ?? [])
      .filter(kept => now - kept.at < MARK_LIFETIME_MS)
      .map(kept => kept.author.key)
    keys.push(participant)
    return coloursForShare(keys).get(participant)!
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
