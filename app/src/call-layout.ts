// Where every picture in a call goes, as arithmetic.
//
// The owner's word for the old call stage was "disconcerting": a camera was
// a 4:3 box sized by a CSS grid, a shared screen was whatever shape its
// picture happened to be, a camera that was off was a pill, and a share
// that decoded a moment late moved everything around it. This module is the
// replacement's rule, with no document in sight: given the space and who is
// in it, one answer for where each tile goes. `call-stage.ts` measures the
// room, asks, and writes the answer onto the page.
//
// Three promises it keeps, and the tests hold it to:
//
//  - Every person's tile in a view is the same box as every other person's
//    tile in that view. Camera on, camera off, speaking or not.
//  - The answer depends on the space and the list of who is there, never on
//    what a picture turned out to be once it decoded. A late frame cannot
//    move anybody.
//  - The screen share, when there is one, gets the stage; people keep a
//    strip beside it at one size.

/** The shape of every person's tile. Wide, because webcams are. */
export const TILE_ASPECT = 16 / 9
/** Between tiles, and around the edge of the room, in CSS pixels. Leaves
 *  room for the speaking ring, which is drawn outside the tile. */
export const TILE_GAP = 10
/** Below this a face stops being readable, so the gallery scrolls rather
 *  than shrinking further. */
export const MIN_TILE_WIDTH = 160
/** A strip tile beside a stage: never smaller than the gallery's floor. */
export const STRIP_MIN_WIDTH = 160
export const STRIP_MAX_WIDTH = 256
/** How long the big picture in Speaker view holds before it follows a new
 *  voice. Short enough to feel like it follows the conversation, long
 *  enough that a cough across the room does not swap the whole screen. */
export const SPEAKER_HOLD_MS = 1500

export type CallView = 'gallery' | 'speaker' | 'share'
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left']

export interface Rect { x: number; y: number; width: number; height: number }

export interface Grid {
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
}

interface GridOptions {
  aspect?: number
  gap?: number
  minWidth?: number
}

/**
 * The column count that makes `count` equal tiles of one aspect as big as
 * they can be in `width` by `height`, and the one tile size that goes with
 * it. Whole pixels, so every tile is exactly the same box.
 *
 * Past the point where the best answer is narrower than `minWidth`, the
 * tiles stay at the floor and the rows run past the bottom: the room
 * scrolls rather than turning people into thumbnails.
 */
export function bestGrid(width: number, height: number, count: number, options: GridOptions = {}): Grid {
  const aspect = options.aspect ?? TILE_ASPECT
  const gap = options.gap ?? TILE_GAP
  const minWidth = options.minWidth ?? 0
  const n = Math.max(1, Math.floor(count))
  const w = Math.max(0, width)
  const h = Math.max(0, height)

  let best: Grid = { columns: 1, rows: n, tileWidth: 0, tileHeight: 0 }
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns)
    const byWidth = (w - (columns - 1) * gap) / columns
    const byHeight = ((h - (rows - 1) * gap) / rows) * aspect
    const tileWidth = Math.floor(Math.max(0, Math.min(byWidth, byHeight)))
    // Strictly larger only: on a tie the fewer columns win, which keeps two
    // people side by side rather than stacked in a square room.
    if (tileWidth > best.tileWidth) best = { columns, rows, tileWidth, tileHeight: Math.floor(tileWidth / aspect) }
  }
  if (best.tileWidth >= minWidth || minWidth <= 0) return best

  const columns = Math.max(1, Math.min(n, Math.floor((w + gap) / (minWidth + gap))))
  const tileWidth = Math.max(Math.min(minWidth, Math.floor(w)), Math.floor((w - (columns - 1) * gap) / columns))
  return { columns, rows: Math.ceil(n / columns), tileWidth, tileHeight: Math.floor(tileWidth / aspect) }
}

/**
 * `count` equal tiles in `area`, row by row, centred: the block in the
 * middle of the area, and a short last row in the middle of its line
 * rather than hanging off the left.
 */
export function gridRects(area: Rect, count: number, options: GridOptions = {}): Rect[] {
  if (count <= 0) return []
  const gap = options.gap ?? TILE_GAP
  const grid = bestGrid(area.width, area.height, count, options)
  const blockHeight = grid.rows * grid.tileHeight + (grid.rows - 1) * gap
  const top = area.y + Math.max(0, Math.floor((area.height - blockHeight) / 2))
  const rects: Rect[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / grid.columns)
    const inRow = Math.min(grid.columns, count - row * grid.columns)
    const rowWidth = inRow * grid.tileWidth + (inRow - 1) * gap
    const left = area.x + Math.max(0, Math.floor((area.width - rowWidth) / 2))
    const column = i - row * grid.columns
    rects.push({
      x: left + column * (grid.tileWidth + gap),
      y: top + row * (grid.tileHeight + gap),
      width: grid.tileWidth,
      height: grid.tileHeight,
    })
  }
  return rects
}

/** The biggest box of an aspect inside `area`, centred in it. */
export function fitRect(area: Rect, aspect: number): Rect {
  const width = Math.floor(Math.min(area.width, area.height * aspect))
  const height = Math.floor(width / aspect)
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  }
}

/** One screen being shared. `aspect` is only a hint for how to divide the
 *  stage between two or more shares; a single share always gets the whole
 *  stage, so its picture decoding can never move anything. */
export interface ShareInput { id: string; aspect?: number }

export interface LayoutInput {
  width: number
  height: number
  view: CallView
  /** Everybody to draw a tile for, in the room's order. */
  people: readonly string[]
  /** This device's own person, when they are among `people`. */
  self?: string
  shares: readonly ShareInput[]
  /** Who the big picture is in Speaker view: a pin, else the voice. */
  featured?: string
  /** Where your own picture floats in a call of two. */
  selfCorner?: Corner
}

export type LayoutMode = 'gallery' | 'speaker' | 'share' | 'solo'

export interface LayoutResult {
  mode: LayoutMode
  /** Every person's tile, by id. */
  people: Map<string, Rect>
  /** Every share's place, by id. The picture sits inside it with
   *  `object-fit: contain`. */
  shares: Map<string, Rect>
  /** The person whose tile floats over the others: yourself, in a call of two. */
  floating?: string
  /** The featured person in Speaker view, or the other person in a call of two. */
  featured?: string
  /** How tall the content is, which can be taller than the room when a
   *  gallery has more people than fit at the minimum size. */
  contentHeight: number
}

/** The effective view: Share needs a share, and a call of two is a
 *  FaceTime-style call whatever was picked, unless a share is on the stage. */
export function effectiveMode(input: Pick<LayoutInput, 'view' | 'people' | 'self' | 'shares'>): LayoutMode {
  const view = input.view === 'share' && input.shares.length === 0 ? 'gallery' : input.view
  if (view === 'share') return 'share'
  if (input.shares.length === 0 && input.people.length === 2 && input.self !== undefined && input.people.includes(input.self)) return 'solo'
  return view
}

/**
 * Where everything goes.
 *
 * Ids are opaque: people and shares share nothing but the room.
 */
export function layoutCall(input: LayoutInput): LayoutResult {
  const gap = TILE_GAP
  const area: Rect = { x: gap, y: gap, width: Math.max(0, input.width - 2 * gap), height: Math.max(0, input.height - 2 * gap) }
  const mode = effectiveMode(input)
  const people = new Map<string, Rect>()
  const shares = new Map<string, Rect>()
  const result: LayoutResult = { mode, people, shares, contentHeight: input.height }

  if (mode === 'solo') {
    const other = input.people.find(id => id !== input.self)!
    // The other person is the call. Wider than 16:9 is cropped less than
    // a letterbox would waste, and narrower than 4:3 would crop a face,
    // so the stage takes the room's own shape inside those two.
    const roomAspect = area.height > 0 ? area.width / area.height : TILE_ASPECT
    const main = fitRect(area, Math.min(TILE_ASPECT, Math.max(4 / 3, roomAspect)))
    people.set(other, main)
    const width = Math.max(STRIP_MIN_WIDTH, Math.min(280, Math.round(main.width * 0.22)))
    const height = Math.round(width / TILE_ASPECT)
    people.set(input.self!, cornerRect(main, input.selfCorner ?? 'bottom-right', width, height, 16))
    result.floating = input.self
    result.featured = other
    return result
  }

  if (mode === 'gallery') {
    const items = [...input.people.map(id => ({ id, share: false })), ...input.shares.map(s => ({ id: s.id, share: true }))]
    const rects = gridRects(area, items.length, { minWidth: MIN_TILE_WIDTH })
    for (const [i, item] of items.entries()) (item.share ? shares : people).set(item.id, rects[i])
    result.contentHeight = Math.max(input.height, bottomOf(rects) + gap)
    return result
  }

  // Speaker and Share: a stage and a strip.
  const onStage = mode === 'share'
    ? input.shares.map(share => share.id)
    : [pickFeatured(input)].filter((id): id is string => id !== undefined)
  const inStrip = mode === 'share'
    ? [...input.people]
    : [...input.people.filter(id => !onStage.includes(id)), ...input.shares.map(share => share.id)]
  const { stage, strip } = splitStage(area, inStrip.length)
  if (mode === 'speaker') {
    result.featured = onStage[0]
    if (onStage[0] !== undefined) people.set(onStage[0], fitRect(stage, TILE_ASPECT))
  } else {
    const aspect = input.shares.length === 1 ? undefined : input.shares[0]?.aspect
    // One share: the whole stage, whatever its shape. More: equal slots.
    const slots = input.shares.length === 1 ? [stage] : gridRects(stage, input.shares.length, { aspect: aspect ?? TILE_ASPECT, gap })
    for (const [i, share] of input.shares.entries()) shares.set(share.id, slots[i])
  }
  const shareIds = new Set(input.shares.map(share => share.id))
  for (const [i, id] of inStrip.entries()) (shareIds.has(id) ? shares : people).set(id, strip[i])
  result.contentHeight = Math.max(input.height, bottomOf([stage, ...strip]) + gap)
  return result
}

function pickFeatured(input: LayoutInput): string | undefined {
  if (input.featured !== undefined && input.people.includes(input.featured)) return input.featured
  return input.people.find(id => id !== input.self) ?? input.people[0]
}

function bottomOf(rects: readonly Rect[]): number {
  return rects.reduce((bottom, rect) => Math.max(bottom, rect.y + rect.height), 0)
}

/**
 * A stage and a strip of `count` equal tiles: beside the stage or under it,
 * whichever leaves the bigger 16:9 picture on the stage. The strip grows a
 * second or third column (or row) before its tiles shrink below the floor,
 * and runs past the bottom of the room only after that.
 */
export function splitStage(area: Rect, count: number, gap = TILE_GAP): { stage: Rect; strip: Rect[] } {
  if (count === 0) return { stage: area, strip: [] }
  const side = sideStrip(area, count, gap)
  const under = underStrip(area, count, gap)
  const size = (option: { stage: Rect }) => {
    const box = fitRect(option.stage, TILE_ASPECT)
    return box.width * box.height
  }
  return size(under) > size(side) ? under : side
}

export function sideStrip(area: Rect, count: number, gap: number): { stage: Rect; strip: Rect[] } {
  const tileWidth = Math.max(STRIP_MIN_WIDTH, Math.min(STRIP_MAX_WIDTH, Math.round(area.width * 0.2)))
  const tileHeight = Math.floor(tileWidth / TILE_ASPECT)
  const perColumn = Math.max(1, Math.floor((area.height + gap) / (tileHeight + gap)))
  const columns = Math.min(3, Math.ceil(count / perColumn))
  const rows = Math.ceil(count / columns)
  const stripWidth = columns * tileWidth + (columns - 1) * gap
  const stage: Rect = { x: area.x, y: area.y, width: Math.max(0, area.width - stripWidth - gap), height: area.height }
  const blockHeight = rows * tileHeight + (rows - 1) * gap
  const top = area.y + Math.max(0, Math.floor((area.height - blockHeight) / 2))
  const left = area.x + area.width - stripWidth
  const strip: Rect[] = []
  for (let i = 0; i < count; i++) {
    const row = i % rows
    const column = Math.floor(i / rows)
    strip.push({ x: left + column * (tileWidth + gap), y: top + row * (tileHeight + gap), width: tileWidth, height: tileHeight })
  }
  return { stage, strip }
}

export function underStrip(area: Rect, count: number, gap: number): { stage: Rect; strip: Rect[] } {
  const tileHeight = Math.max(Math.floor(STRIP_MIN_WIDTH / TILE_ASPECT), Math.min(Math.floor(STRIP_MAX_WIDTH / TILE_ASPECT), Math.round(area.height * 0.2)))
  const tileWidth = Math.floor(tileHeight * TILE_ASPECT)
  const perRow = Math.max(1, Math.floor((area.width + gap) / (tileWidth + gap)))
  const rows = Math.min(2, Math.ceil(count / perRow))
  const stripHeight = rows * tileHeight + (rows - 1) * gap
  const stage: Rect = { x: area.x, y: area.y, width: area.width, height: Math.max(0, area.height - stripHeight - gap) }
  const strip: Rect[] = []
  const top = area.y + stage.height + gap
  for (let i = 0; i < count; i++) {
    // Rows past the second run below the room, which then scrolls.
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, count - row * perRow)
    const rowWidth = inRow * tileWidth + (inRow - 1) * gap
    const left = area.x + Math.max(0, Math.floor((area.width - rowWidth) / 2))
    strip.push({ x: left + (i % perRow) * (tileWidth + gap), y: top + row * (tileHeight + gap), width: tileWidth, height: tileHeight })
  }
  return { stage, strip }
}

/** A `width` by `height` box in one corner of `area`, `margin` in from its edges. */
export function cornerRect(area: Rect, corner: Corner, width: number, height: number, margin: number): Rect {
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  return {
    x: left ? area.x + margin : area.x + area.width - width - margin,
    y: top ? area.y + margin : area.y + area.height - height - margin,
    width,
    height,
  }
}

/** The corner of `area` nearest to a point, for a dragged picture let go. */
export function nearestCorner(area: Rect, x: number, y: number): Corner {
  const vertical = y < area.y + area.height / 2 ? 'top' : 'bottom'
  const horizontal = x < area.x + area.width / 2 ? 'left' : 'right'
  return `${vertical}-${horizontal}`
}

export function nextCorner(corner: Corner): Corner {
  return CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length]
}

/**
 * Who has the big picture in Speaker view.
 *
 * The voice detector already has a hangover, so a tile's ring does not
 * strobe between words. The big picture needs more than that: it moves the
 * whole screen, so it holds for `holdMs` after each move, and while the
 * person on it is still talking nobody takes it from them.
 */
export class ActiveSpeaker {
  #current: string | undefined
  #changedAt = -Infinity
  readonly #holdMs: number
  readonly #since = new Map<string, number>()

  constructor(holdMs = SPEAKER_HOLD_MS) {
    this.#holdMs = holdMs
  }

  get current(): string | undefined {
    return this.#current
  }

  /**
   * Feed it who is speaking now and who could be featured. Returns who is
   * featured, and how long until it is worth asking again when a change is
   * waiting on the hold (undefined when nothing is waiting).
   */
  update(speaking: ReadonlySet<string>, candidates: readonly string[], now: number): { current: string | undefined; recheckIn?: number } {
    for (const id of [...this.#since.keys()]) if (!speaking.has(id)) this.#since.delete(id)
    for (const id of speaking) if (!this.#since.has(id)) this.#since.set(id, now)

    const talking = candidates
      .filter(id => speaking.has(id))
      .sort((a, b) => (this.#since.get(a) ?? now) - (this.#since.get(b) ?? now))

    if (this.#current === undefined || !candidates.includes(this.#current)) {
      this.#current = talking[0] ?? candidates[0]
      this.#changedAt = now
      return { current: this.#current }
    }
    if (speaking.has(this.#current) || talking.length === 0) return { current: this.#current }
    const wait = this.#changedAt + this.#holdMs - now
    if (wait > 0) return { current: this.#current, recheckIn: wait }
    this.#current = talking[0]
    this.#changedAt = now
    return { current: this.#current }
  }
}

/** At most one spoken announcement per `gapMs`, so a lively call does not
 *  talk over the person listening to it. */
export class Throttle {
  #last = -Infinity
  constructor(readonly gapMs: number) {}
  allow(now: number): boolean {
    if (now - this.#last < this.gapMs) return false
    this.#last = now
    return true
  }
}

/** Initials for a tile with no picture: the first letter of the first and
 *  last words of a name, or of its only word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? [[...words[0]][0]] : [[...words[0]][0], [...words[words.length - 1]][0]]
  return letters.join('').toUpperCase()
}

// ---------------------------------------------------------------------------
// What this device remembers about how it likes its calls laid out.

export const VIEW_KEY = 'kithmoot.call-view'
export const CORNER_KEY = 'kithmoot.call-self-corner'
export const HIDE_SELF_KEY = 'kithmoot.call-hide-self'
export const HIDE_NO_VIDEO_KEY = 'kithmoot.call-hide-no-video'
export const ANNOUNCE_KEY = 'kithmoot.call-announce-speaker'

export interface LayoutPrefs {
  /** Gallery or Speaker: Share is chosen for you when a share starts. */
  view: 'gallery' | 'speaker'
  corner: Corner
  hideSelf: boolean
  hideNoVideo: boolean
  announce: boolean
}

type Reader = Pick<Storage, 'getItem'>
type Writer = Pick<Storage, 'setItem'>

function read(storage: Reader, key: string): string | null {
  try { return storage.getItem(key) } catch { return null }
}

export function loadPrefs(storage: Reader): LayoutPrefs {
  const view = read(storage, VIEW_KEY)
  const corner = read(storage, CORNER_KEY) as Corner | null
  return {
    view: view === 'speaker' ? 'speaker' : 'gallery',
    corner: corner && CORNERS.includes(corner) ? corner : 'bottom-right',
    hideSelf: read(storage, HIDE_SELF_KEY) === 'true',
    hideNoVideo: read(storage, HIDE_NO_VIDEO_KEY) === 'true',
    // Off unless this device turned it on: a screen reader already has a
    // great deal to say during a call.
    announce: read(storage, ANNOUNCE_KEY) === 'true',
  }
}

export function savePref(storage: Writer, key: string, value: string | boolean): void {
  try { storage.setItem(key, String(value)) } catch { /* Remembered for this visit only. */ }
}
