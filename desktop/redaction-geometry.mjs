// Redaction boxes on the real screen, in DIP. Kept free of Electron imports
// so every decision can be tested without a window.

// The box's own controls: a bar across the top and a grip in each corner.
// Everything else is see-through and lets clicks reach whatever is beneath.
export const BOX_BAR = 30
export const BOX_GRIP = 18
// Wide enough that the bar keeps a place to take hold of beside its buttons.
export const BOX_MIN = { width: 160, height: 64 }
// The dashed edge and its dark outline.
export const BOX_EDGE = 5
export const BOX_MAX = 8000
const LIMIT = 32000

const finite = rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

export function clampBox(bounds) {
  return {
    x: clamp(Math.round(bounds.x), -LIMIT, LIMIT), y: clamp(Math.round(bounds.y), -LIMIT, LIMIT),
    width: clamp(Math.round(bounds.width), BOX_MIN.width, BOX_MAX), height: clamp(Math.round(bounds.height), BOX_MIN.height, BOX_MAX),
  }
}

/** A new box in the middle of the work area, stepped so boxes never stack exactly. */
export function placeBox(workArea, count = 0) {
  const width = Math.min(360, Math.max(BOX_MIN.width, workArea.width - 40))
  const height = Math.min(220, Math.max(BOX_MIN.height, workArea.height - 40))
  const step = (count % 6) * 24
  return clampBox({ x: workArea.x + (workArea.width - width) / 2 + step, y: workArea.y + (workArea.height - height) / 2 + step, width, height })
}

/** Whether a screen point is over the see-through middle, where clicks pass through. */
export function insideHole(point, bounds) {
  if (point.x < bounds.x || point.x >= bounds.x + bounds.width || point.y < bounds.y + BOX_BAR || point.y >= bounds.y + bounds.height) return false
  const bottom = point.y >= bounds.y + bounds.height - BOX_GRIP
  const side = point.x < bounds.x + BOX_GRIP || point.x >= bounds.x + bounds.width - BOX_GRIP
  return !(bottom && side)
}

/**
 * The box's own controls, as a window shape in DIP from the window's top
 * left: the bar, the edge and the two lower grips. On X11 the server then
 * sends clicks in the middle to whatever is beneath, with nothing here
 * watching the cursor.
 */
export function boxShape(size) {
  const width = Math.round(size.width), height = Math.round(size.height)
  const middle = height - BOX_BAR - BOX_EDGE
  if (!(width > 2 * BOX_GRIP) || !(middle > 0)) return [{ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }]
  return [
    { x: 0, y: 0, width, height: BOX_BAR },
    { x: 0, y: height - BOX_EDGE, width, height: BOX_EDGE },
    { x: 0, y: BOX_BAR, width: BOX_EDGE, height: middle },
    { x: width - BOX_EDGE, y: BOX_BAR, width: BOX_EDGE, height: middle },
    { x: 0, y: height - BOX_GRIP, width: BOX_GRIP, height: BOX_GRIP },
    { x: width - BOX_GRIP, y: height - BOX_GRIP, width: BOX_GRIP, height: BOX_GRIP },
  ]
}

/** Follows the cursor from where a drag began, so the box stays under the pointer. */
export function moveTo(cursor, offset, bounds) {
  return clampBox({ ...bounds, x: cursor.x - offset.x, y: cursor.y - offset.y })
}

/** Resizes from one corner, keeping the opposite corner where it was. */
export function resizeFrom(corner, from, dx, dy) {
  if (!['nw', 'ne', 'sw', 'se'].includes(corner) || !finite(from) || !Number.isFinite(dx) || !Number.isFinite(dy)) return undefined
  const west = corner.includes('w'), north = corner.includes('n')
  const width = clamp(Math.round(from.width + (west ? -dx : dx)), BOX_MIN.width, BOX_MAX)
  const height = clamp(Math.round(from.height + (north ? -dy : dy)), BOX_MIN.height, BOX_MAX)
  return clampBox({ x: from.x + (west ? from.width - width : 0), y: from.y + (north ? from.height - height : 0), width, height })
}

/**
 * What the page needs to know about a chosen capture source. A window share
 * says only that it is a window: nothing here can tell where another app's
 * window sits. A screen without a display id is matched only when there is
 * no other display it could be; anything else is unknown, and the page
 * treats unknown as black while any box is on.
 */
export function captureOf(source, displays) {
  const id = typeof source?.id === 'string' ? source.id : ''
  if (id.startsWith('window:')) return { kind: 'window' }
  if (!id.startsWith('screen:')) return null
  const exact = displays.find(display => source.display_id && String(display.id) === String(source.display_id))
  if (exact) return { kind: 'screen', displayId: String(exact.id) }
  if (!source.display_id && displays.length === 1) return { kind: 'screen', displayId: String(displays[0].id) }
  return null
}

/**
 * Keeps a box wholly on one display. On Windows a window straddling two
 * displays at different scales has its DIP bounds converted by the display
 * holding most of it, so the part on the other display is misplaced and
 * could be under-covered. A box that never crosses cannot hit that. A move
 * slides the box back inside; a resize stops at the display's edge, so the
 * corner held still stays where it was.
 */
export function onOneDisplay(bounds, display, resizing = false) {
  if (!finite(bounds) || !finite(display)) return bounds
  if (resizing) {
    const x = Math.max(bounds.x, display.x), y = Math.max(bounds.y, display.y)
    const right = Math.min(bounds.x + bounds.width, display.x + display.width), bottom = Math.min(bounds.y + bounds.height, display.y + display.height)
    if (right > x && bottom > y) return { x, y, width: right - x, height: bottom - y }
  }
  const width = Math.min(bounds.width, display.width), height = Math.min(bounds.height, display.height)
  return {
    x: clamp(bounds.x, display.x, display.x + display.width - width),
    y: clamp(bounds.y, display.y, display.y + display.height - height),
    width, height,
  }
}

/** How long after a display change every box's place is distrusted. */
export const SETTLE_MS = 1000

/**
 * After a display is added, removed or rescaled, the OS may still be moving
 * and rescaling windows (a DPI change, relocation off a removed display)
 * without Electron saying so, and frames in flight are the old size. So a
 * change sets a deadline the page treats as black, and the state is read
 * again part way through and just after it, in case no window event follows.
 */
export class DisplaySettle {
  deadline = 0
  timers = []
  constructor({ report, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, ms = SETTLE_MS }) {
    Object.assign(this, { report, now, setTimer, clearTimer, ms })
  }
  changed() {
    this.dispose()
    this.deadline = this.now() + this.ms
    this.timers = [this.ms / 4, this.ms + 50].map(delay => this.setTimer(() => this.report(), delay))
    this.report()
  }
  dispose() { for (const timer of this.timers) this.clearTimer(timer); this.timers = [] }
}
