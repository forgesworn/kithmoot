/**
 * Where redaction boxes fall in an outgoing screen or area share, and when
 * the only safe answer is to cover the whole picture. Pure, so every rule is
 * tested.
 *
 * The rule the whole module serves: pixels inside an active box are never
 * encoded or sent. Whenever the page cannot be sure where a box lands in the
 * picture, the plan covers all of it, never the raw frame. What a cover
 * looks like is `share-cover.ts`.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface RedactionBox { id: string; on: boolean; bounds: Rect }
export interface RedactionDisplay { id: string; bounds: Rect; scaleFactor?: number }
/** What the main process answered the capture request with. `null` is unknown. */
export type CaptureSource = { kind: 'screen'; displayId: string } | { kind: 'window' } | null
/**
 * Boxes and displays in DIP, as the main process reports them.
 * `settleUntil` (epoch milliseconds) is set after a display change, while
 * the OS may still be moving and rescaling windows.
 */
export interface RedactionState { boxes: RedactionBox[]; displays: RedactionDisplay[]; source: CaptureSource; settleUntil?: number }

/** `hidden` is the sharer's own choice; the rest are the page not being sure. */
export type CoverReason = 'unknown' | 'window' | 'geometry' | 'settling' | 'crossing' | 'hidden' | 'moving'
export type RedactionPlan =
  | { mode: 'pass' }
  | { mode: 'cover'; reason: CoverReason }
  | { mode: 'boxes'; rects: Rect[] }

/** Extra margin round every box, in DIP, so rounding and scaling cannot leave a sliver. */
export const PAD_DIP = 3
/** How long a box's old place stays covered after it moves, resizes or turns off. */
export const HOLD_MS = 400
/** A picture whose shape differs from its display by more than this is not trusted. */
const ASPECT_TOLERANCE = 0.02

export const EMPTY_STATE: RedactionState = { boxes: [], displays: [], source: null }

const finite = (rect: Rect | undefined): rect is Rect =>
  !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)

/** The smallest rectangle holding both. */
export function hull(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * Remembers where each box has been, so a lagging geometry update cannot
 * leak a sliver: while a box moves, the hull of its old and new places stays
 * covered for `HOLD_MS`, and a box turned off or closed keeps its last place
 * covered for as long again.
 */
export class RedactionTrail {
  #last = new Map<string, Rect>()
  #held: { rect: Rect; until: number }[] = []
  constructor(private readonly holdMs = HOLD_MS) {}

  /** Every DIP rectangle to cover now: the boxes that are on, and recent places. */
  next(boxes: readonly RedactionBox[], now: number): Rect[] {
    const current = new Map<string, Rect>()
    for (const box of boxes) if (box.on && finite(box.bounds)) current.set(box.id, box.bounds)
    for (const [id, rect] of this.#last) {
      const moved = current.get(id)
      if (!moved) this.#held.push({ rect, until: now + this.holdMs })
      else if (!same(moved, rect)) this.#held.push({ rect: hull(rect, moved), until: now + this.holdMs })
    }
    this.#last = current
    this.#held = this.#held.filter(held => held.until > now)
    return [...current.values(), ...this.#held.map(held => held.rect)]
  }
}

/**
 * Whether the main process's answer can be believed. The track's own
 * `displaySurface`, where Chromium gives one, must agree with it.
 */
export function effectiveSource(source: CaptureSource, surface: string | undefined): CaptureSource {
  if (!source) return null
  if (surface === 'window' && source.kind !== 'window') return null
  if (surface === 'monitor' && source.kind !== 'screen') return null
  if (surface === 'browser') return null
  return source
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/**
 * Whether a box straddles displays at different scales (or at a scale not
 * reported). Windows converts such a window's bounds using the display
 * holding most of it, so the DIP bounds misplace the part on the other one.
 */
export function crossesScales(box: Rect, displays: readonly RedactionDisplay[]): boolean {
  const touched = displays.filter(display => finite(display.bounds) && overlaps(box, display.bounds))
  if (touched.length < 2) return false
  const scale = touched[0]!.scaleFactor
  return touched.some(display => !Number.isFinite(display.scaleFactor) || display.scaleFactor !== scale)
}

/**
 * The plan for one frame of a whole-screen share, in that frame's pixels.
 * `held` is what `RedactionTrail#next` returned for this frame.
 */
export function planRedaction(state: RedactionState, frame: { width: number; height: number }, held: readonly Rect[], surface?: string, now = Date.now()): RedactionPlan {
  if (held.length === 0) return { mode: 'pass' }
  if (Number.isFinite(state.settleUntil) && now < state.settleUntil!) return { mode: 'cover', reason: 'settling' }
  if (held.some(box => finite(box) && crossesScales(box, state.displays))) return { mode: 'cover', reason: 'crossing' }
  const source = effectiveSource(state.source, surface)
  if (!source) return { mode: 'cover', reason: 'unknown' }
  if (source.kind === 'window') return { mode: 'cover', reason: 'window' }
  const display = state.displays.find(item => item.id === source.displayId)?.bounds
  if (!finite(display) || display.width <= 0 || display.height <= 0) return { mode: 'cover', reason: 'geometry' }
  if (!(frame.width > 0 && frame.height > 0)) return { mode: 'cover', reason: 'geometry' }
  const sx = frame.width / display.width, sy = frame.height / display.height
  if (Math.abs(sx - sy) / Math.max(sx, sy) > ASPECT_TOLERANCE) return { mode: 'cover', reason: 'geometry' }
  const rects: Rect[] = []
  for (const box of held) {
    if (!finite(box)) return { mode: 'cover', reason: 'geometry' }
    const left = Math.max(0, Math.floor((box.x - PAD_DIP - display.x) * sx))
    const top = Math.max(0, Math.floor((box.y - PAD_DIP - display.y) * sy))
    const right = Math.min(frame.width, Math.ceil((box.x + box.width + PAD_DIP - display.x) * sx))
    const bottom = Math.min(frame.height, Math.ceil((box.y + box.height + PAD_DIP - display.y) * sy))
    // A box on another display simply does not intersect this one.
    if (right > left && bottom > top) rects.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return rects.length ? { mode: 'boxes', rects } : { mode: 'pass' }
}

/**
 * The same plan carried into an area share's crop: `crop` is the part of
 * the frame, in frame pixels, drawn onto an `output`-sized canvas. Rounded
 * outwards, so a box edge never falls inside a half-covered pixel.
 */
export function cropPlan(plan: RedactionPlan, crop: Rect, output: { width: number; height: number }): RedactionPlan {
  if (plan.mode !== 'boxes') return plan
  if (!finite(crop) || crop.width <= 0 || crop.height <= 0 || !(output.width > 0 && output.height > 0)) return { mode: 'cover', reason: 'geometry' }
  const sx = output.width / crop.width, sy = output.height / crop.height
  const rects: Rect[] = []
  for (const rect of plan.rects) {
    const left = Math.max(0, Math.floor((rect.x - crop.x) * sx))
    const top = Math.max(0, Math.floor((rect.y - crop.y) * sy))
    const right = Math.min(output.width, Math.ceil((rect.x + rect.width - crop.x) * sx))
    const bottom = Math.min(output.height, Math.ceil((rect.y + rect.height - crop.y) * sy))
    if (right > left && bottom > top) rects.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return rects.length ? { mode: 'boxes', rects } : { mode: 'pass' }
}

/** Whether a new share may start: a single app cannot carry boxes yet. */
export function refuseShare(state: RedactionState, surface: string | undefined): string | undefined {
  if (!state.boxes.some(box => box.on)) return undefined
  const source = effectiveSource(state.source, surface)
  if (source?.kind === 'window' || surface === 'window') return WINDOW_SHARE_COPY
  return undefined
}

export const WINDOW_SHARE_COPY = 'Redaction boxes cannot follow a single app yet. Share your screen or an area instead, or turn the boxes off.'

/** A share hidden on purpose: all of it covered, whatever else is so. */
export const HIDDEN_PLAN: RedactionPlan = { mode: 'cover', reason: 'hidden' }

/** Plain words for a share that is wholly covered, for the line under the controls. */
export function coverCopy(reason: CoverReason): string {
  if (reason === 'hidden') return 'Your share is hidden. People see a cover, and hear nothing from it, until you show it again.'
  if (reason === 'settling') return 'Your share is covered for a moment while your displays change.'
  if (reason === 'moving') return 'Your share is covered for a moment while the whole screen changes, such as switching desktops.'
  if (reason === 'crossing') return 'Your share is covered while a redaction box spans two screens at different scales. Move it onto one screen.'
  if (reason === 'window') return 'Your app share is covered while a redaction box is on: boxes cannot follow a single app yet. Share your screen or an area instead.'
  if (reason === 'unknown') return 'Your share is covered while a redaction box is on, because KithMoot could not tell which screen is shared. Stop and share the screen again.'
  return 'Your share is covered while a redaction box is on, because the screen changed shape. Stop and share again.'
}

/**
 * A picture that changed almost everywhere at once.
 *
 * A redaction box is a window on every desktop, fixed where it was put. When
 * macOS slides from one desktop to another, everything under the boxes slides
 * sideways with it, and for a second or two text a box was hiding is readable
 * beside the box. Nothing from the system says so in time: the notification
 * that the desktop changed comes when the slide is over. The picture itself
 * says so first. Each frame is compared, at a few hundred cells, with the one
 * before it, before anything of it is drawn; when most cells changed, the
 * whole share is covered and stays covered until the picture has been still
 * for [holdMs]. A full-screen scroll or video under a box costs a cover too,
 * which is the right way round for a box someone put there.
 */
export const JUMP_SAMPLE = { width: 48, height: 27 } as const
/** The share of cells that must change for a frame to count as a jump. */
export const JUMP_CHANGED_SHARE = 0.4
/** How far a cell's brightness must move, out of 255, to count as changed. */
export const JUMP_CELL_DELTA = 16
export const JUMP_HOLD_MS = 1500

/** The share of cells whose brightness moved by at least [JUMP_CELL_DELTA]. */
export function changedShare(previous: ArrayLike<number>, next: ArrayLike<number>): number {
  if (previous.length !== next.length || next.length === 0) return 1
  let changed = 0
  for (let i = 0; i < next.length; i++) if (Math.abs(next[i]! - previous[i]!) >= JUMP_CELL_DELTA) changed++
  return changed / next.length
}

export class FrameJump {
  #previous: ArrayLike<number> | undefined
  #until = -Infinity
  constructor(private readonly holdMs = JUMP_HOLD_MS) {}

  /** Whether to cover this frame: it jumped, or one did within [holdMs]. */
  next(sample: ArrayLike<number>, now: number): boolean {
    const previous = this.#previous
    this.#previous = sample
    if (previous && changedShare(previous, sample) >= JUMP_CHANGED_SHARE) this.#until = now + this.holdMs
    return now < this.#until
  }

  /** Nothing to compare against: the next frame starts afresh. */
  reset(): void { this.#previous = undefined }
}

