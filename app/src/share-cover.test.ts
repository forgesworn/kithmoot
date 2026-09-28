import { describe, expect, it } from 'vitest'
import { COVER_BASE, COVER_LINE, COVER_TILE, coverAll, coverFill, drawCoverTile } from './share-cover.js'

/** A canvas context that records what is asked of it. */
function recorder() {
  const calls: unknown[][] = []
  const context = {
    fillStyle: '' as unknown, strokeStyle: '' as unknown, lineWidth: 0, lineCap: 'butt',
    fillRect: (...args: number[]) => calls.push(['fillRect', context.fillStyle, ...args]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...args: number[]) => calls.push(['moveTo', ...args]),
    lineTo: (...args: number[]) => calls.push(['lineTo', ...args]),
    stroke: () => calls.push(['stroke', context.strokeStyle]),
  }
  return { context, calls }
}

/** A canvas whose document makes tiles, with `createPattern` as given. */
function canvasWith(createPattern: () => unknown, getContext: () => unknown = () => recorder().context) {
  const { context, calls } = recorder()
  const made: unknown[] = []
  const ownerDocument = { createElement: () => { const tile = { width: 0, height: 0, getContext }; made.push(tile); return tile } }
  return { context: Object.assign(context, { canvas: { ownerDocument }, createPattern }) as unknown as CanvasRenderingContext2D, calls, made }
}

describe('the cover painted over what must not be shared', () => {
  it('draws a tile that joins itself: the base, then one diagonal and its neighbour either side', () => {
    const { context, calls } = recorder()
    drawCoverTile(context as never)
    expect(calls[0]).toEqual(['fillRect', COVER_BASE, 0, 0, COVER_TILE, COVER_TILE])
    expect(calls.filter(call => call[0] === 'moveTo')).toEqual([['moveTo', -COVER_TILE, COVER_TILE], ['moveTo', 0, COVER_TILE], ['moveTo', COVER_TILE, COVER_TILE]])
    expect(calls.filter(call => call[0] === 'lineTo')).toEqual([['lineTo', 0, 0], ['lineTo', COVER_TILE, 0], ['lineTo', 2 * COVER_TILE, 0]])
    expect(calls.filter(call => call[0] === 'stroke')).toEqual([['stroke', COVER_LINE], ['stroke', COVER_LINE], ['stroke', COVER_LINE]])
  })

  it('fills with the pattern, made once for each canvas', () => {
    const pattern = { pattern: true }
    const { context, made } = canvasWith(() => pattern)
    expect(coverFill(context)).toBe(pattern)
    expect(coverFill(context)).toBe(pattern)
    expect(made).toHaveLength(1)
  })

  it('falls back to a solid colour, never to nothing, when a pattern cannot be made', () => {
    for (const broken of [
      canvasWith(() => null),
      canvasWith(() => { throw new Error('no pattern') }),
      canvasWith(() => ({ pattern: true }), () => null),
      canvasWith(() => ({ pattern: true }), () => { throw new Error('no canvas') }),
    ]) {
      expect(coverFill(broken.context)).toBe(COVER_BASE)
      coverAll(broken.context, 640, 360)
      expect(broken.calls.at(-1)).toEqual(['fillRect', COVER_BASE, 0, 0, 640, 360])
    }
  })
})
