// Keep the toolbar and frame outside the pixels sent to the call.
export const AREA_INSET = { left: 6, top: 42, right: 6, bottom: 6 }

export function areaRect(bounds, display) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, display.x, display.y, display.width, display.height].every(Number.isFinite) || display.width <= 0 || display.height <= 0) return null
  const x = bounds.x + AREA_INSET.left - display.x
  const y = bounds.y + AREA_INSET.top - display.y
  const width = bounds.width - AREA_INSET.left - AREA_INSET.right
  const height = bounds.height - AREA_INSET.top - AREA_INSET.bottom
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > display.width || y + height > display.height) return null
  return { x: x / display.width, y: y / display.height, width: width / display.width, height: height / display.height }
}

