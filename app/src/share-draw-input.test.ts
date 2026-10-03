import { describe, expect, it } from 'vitest'
import { clampToPicture, insidePicture, mayBeginStroke } from './share-draw-input.js'

// A 16:9 band in a 360 x 740 phone viewport, as in portrait.
const band = { left: 0, top: 269, width: 360, height: 202 }

describe('drawing input rules', () => {
  it('knows the letterbox is not the picture', () => {
    expect(insidePicture(band, 180, 370)).toBe(true)
    expect(insidePicture(band, 180, 100)).toBe(false)
    expect(insidePicture(band, 180, 600)).toBe(false)
    expect(insidePicture({ ...band, height: 0 }, 180, 269)).toBe(false)
  })

  it('does not begin a stroke from a press in the letterbox', () => {
    expect(mayBeginStroke(band, 180, 100, 1, undefined)).toBe(false)
    expect(mayBeginStroke(band, 180, 370, 1, undefined)).toBe(true)
  })

  it('ignores a second pointer while another owns the stroke', () => {
    expect(mayBeginStroke(band, 180, 370, 2, 1)).toBe(false)
    expect(mayBeginStroke(band, 180, 370, 1, 1)).toBe(true)
  })

  it('still clamps a move that slides off the picture once a stroke is under way', () => {
    expect(clampToPicture(band, 180, 100)).toEqual({ x: 0.5, y: 0 })
    expect(clampToPicture(band, 500, 900)).toEqual({ x: 1, y: 1 })
  })
})
