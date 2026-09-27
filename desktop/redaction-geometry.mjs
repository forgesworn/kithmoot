// Redaction boxes on the real screen, in DIP. Kept free of Electron imports
// so every decision can be tested without a window.

// The box's own controls: a bar across the top and a grip in each corner.
// Everything else is see-through and lets clicks reach whatever is beneath.
export const BOX_BAR = 30
export const BOX_GRIP = 18
export const BOX_MIN = { width: 120, height: 64 }
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
