// Keep the toolbar and frame outside the pixels sent to the call.
export const AREA_INSET = { left: 8, top: 52, right: 8, bottom: 40 }

export function areaRect(bounds, display) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, display.x, display.y, display.width, display.height].every(Number.isFinite) || display.width <= 0 || display.height <= 0) return null
  const x = bounds.x + AREA_INSET.left - display.x
  const y = bounds.y + AREA_INSET.top - display.y
  const width = bounds.width - AREA_INSET.left - AREA_INSET.right
  const height = bounds.height - AREA_INSET.top - AREA_INSET.bottom
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > display.width || y + height > display.height) return null
  return { x: x / display.width, y: y / display.height, width: width / display.width, height: height / display.height }
}

// Whether a screen point is over the drawing hole, where clicks pass through.
export function insideArea(point, bounds) {
  return point.x >= bounds.x + AREA_INSET.left && point.x < bounds.x + bounds.width - AREA_INSET.right &&
    point.y >= bounds.y + AREA_INSET.top && point.y < bounds.y + bounds.height - AREA_INSET.bottom
}

/**
 * The frame's own controls, as a window shape in DIP from the window's top
 * left: everything but the hole. On X11 the server then sends clicks in the
 * hole to whatever is beneath, with nothing here watching the cursor.
 */
export function areaShape(size) {
  const width = Math.round(size.width), height = Math.round(size.height)
  const middle = height - AREA_INSET.top - AREA_INSET.bottom
  if (!(width > AREA_INSET.left + AREA_INSET.right) || !(middle > 0)) return [{ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }]
  return [
    { x: 0, y: 0, width, height: AREA_INSET.top },
    { x: 0, y: height - AREA_INSET.bottom, width, height: AREA_INSET.bottom },
    { x: 0, y: AREA_INSET.top, width: AREA_INSET.left, height: middle },
    { x: width - AREA_INSET.right, y: AREA_INSET.top, width: AREA_INSET.right, height: middle },
  ]
}
