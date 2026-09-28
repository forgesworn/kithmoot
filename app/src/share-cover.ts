/**
 * What is painted over anything that must not leave this computer: a
 * redaction box, a share hidden on purpose, and every case where the page
 * cannot be sure where a box falls.
 *
 * A pattern rather than plain black, which reads as a fault. It is drawn in
 * code, so there is nothing to load and nothing that can fail to arrive;
 * and it is never made from the captured picture (no blur, no pixelation),
 * so nothing of what it covers can be worked back out of it.
 */

export const COVER_BASE = '#101114'
export const COVER_LINE = '#1f2a36'
export const COVER_TILE = 24

type Context2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineCap' | 'fillRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke'>

/** One tile: a diagonal and its two neighbours, so the tile joins itself on every side. */
export function drawCoverTile(context: Context2D, size = COVER_TILE): void {
  context.fillStyle = COVER_BASE
  context.fillRect(0, 0, size, size)
  context.strokeStyle = COVER_LINE
  context.lineWidth = size / 6
  context.lineCap = 'square'
  for (const shift of [-size, 0, size]) {
    context.beginPath()
    context.moveTo(shift, size)
    context.lineTo(shift + size, 0)
    context.stroke()
  }
}

const fills = new WeakMap<object, CanvasPattern | string>()

/**
 * The fill for a cover on this canvas: the pattern, or its base colour when
 * a pattern cannot be made. Never nothing: whatever is covered stays covered.
 */
export function coverFill(context: CanvasRenderingContext2D): CanvasPattern | string {
  const known = fills.get(context)
  if (known !== undefined) return known
  let fill: CanvasPattern | string = COVER_BASE
  try {
    const tile = context.canvas.ownerDocument.createElement('canvas')
    tile.width = tile.height = COVER_TILE
    const drawing = tile.getContext('2d')
    if (drawing) {
      drawCoverTile(drawing)
      fill = context.createPattern(tile, 'repeat') ?? COVER_BASE
    }
  } catch { fill = COVER_BASE }
  fills.set(context, fill)
  return fill
}

/** Covers the whole of a canvas. */
export function coverAll(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = coverFill(context)
  context.fillRect(0, 0, width, height)
}
