import { describe, expect, it } from 'vitest'
import { minimumSelection, moveSelection, resizeSelection, videoBox, WHOLE_PICTURE } from './share-area-geometry.js'

describe('share area preview geometry', () => {
  it('letterboxes a wide picture in a tall window and a tall one in a wide window', () => {
    expect(videoBox(800, 800, 1920, 1080)).toEqual({ left: 0, top: 175, width: 800, height: 450 })
    expect(videoBox(1600, 450, 1920, 1080)).toEqual({ left: 400, top: 0, width: 800, height: 450 })
  })

  it('has no picture before the video has a size', () => {
    expect(videoBox(800, 600, 0, 0)).toBeNull()
    expect(videoBox(0, 600, 1920, 1080)).toBeNull()
  })

  it('moves inside the picture at every edge', () => {
    const quarter = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    expect(moveSelection(quarter, -1, 0)).toEqual({ ...quarter, x: 0 })
    expect(moveSelection(quarter, 1, 0)).toEqual({ ...quarter, x: 0.5 })
    expect(moveSelection(quarter, 0, -1)).toEqual({ ...quarter, y: 0 })
    expect(moveSelection(quarter, 0, 1)).toEqual({ ...quarter, y: 0.5 })
    expect(moveSelection(WHOLE_PICTURE, 0.1, 0.1)).toEqual(WHOLE_PICTURE)
  })

  it('resizes from each corner, clamped to the picture', () => {
    const min = minimumSelection(1920, 1080)
    expect(resizeSelection(WHOLE_PICTURE, 'se', -0.5, -0.5, min)).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 })
    expect(resizeSelection(WHOLE_PICTURE, 'nw', 0.5, 0.5, min)).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
    expect(resizeSelection(WHOLE_PICTURE, 'ne', 0.2, -0.2, min)).toEqual(WHOLE_PICTURE)
    const sw = resizeSelection({ x: 0.5, y: 0, width: 0.5, height: 0.5 }, 'sw', -2, 2, min)
    expect(sw).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('never shrinks below 64 source pixels', () => {
    const min = minimumSelection(1920, 1080)
    const tiny = resizeSelection(WHOLE_PICTURE, 'se', -2, -2, min)
    expect(tiny.width * 1920).toBeCloseTo(64)
    expect(tiny.height * 1080).toBeCloseTo(64)
    const fromTopLeft = resizeSelection(WHOLE_PICTURE, 'nw', 2, 2, min)
    expect(fromTopLeft.x + fromTopLeft.width).toBeCloseTo(1)
    expect(fromTopLeft.width * 1920).toBeCloseTo(64)
    expect(minimumSelection(32, 32)).toEqual({ width: 1, height: 1 })
  })

  it('keeps a selection on the same source pixels across a window resize', () => {
    const selection = { x: 0.25, y: 0.5, width: 0.25, height: 0.25 }
    for (const [w, h] of [[800, 600], [1400, 500], [500, 900]] as const) {
      const box = videoBox(w, h, 1920, 1080)!
      const left = box.left + selection.x * box.width
      const width = selection.width * box.width
      expect(((left - box.left) / box.width) * 1920).toBeCloseTo(480)
      expect((width / box.width) * 1920).toBeCloseTo(480)
    }
  })
})
