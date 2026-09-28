import { describe, expect, test } from 'vitest'
import { AutoFramer, HOLD_FRAMES, MAX_ZOOM, WHOLE_FRAME, cropFor, personBox, type FrameBox } from './auto-frame.js'

/** A mask with the person filling this box, in mask pixels. */
function maskWith(width: number, height: number, person?: { x: number; y: number; width: number; height: number }) {
  const data = new Float32Array(width * height)
  if (person) {
    for (let y = person.y; y < person.y + person.height; y++) {
      for (let x = person.x; x < person.x + person.width; x++) data[y * width + x] = 0.9
    }
  }
  return { width, height, data }
}

function settle(framer: AutoFramer, person: FrameBox | null, frames = 400): FrameBox {
  let crop = WHOLE_FRAME
  for (let i = 0; i < frames; i++) crop = framer.next(person)
  return crop
}

describe('personBox', () => {
  test('finds a person sitting off to the left', () => {
    const box = personBox(maskWith(640, 480, { x: 0, y: 120, width: 200, height: 360 }))!
    expect(box.x).toBeCloseTo(0, 1)
    expect(box.width).toBeCloseTo(200 / 640, 1)
    expect(box.y).toBeCloseTo(120 / 480, 1)
  })

  test('nobody, or a speck, is nobody', () => {
    expect(personBox(null)).toBeNull()
    expect(personBox(maskWith(640, 480))).toBeNull()
    expect(personBox(maskWith(640, 480, { x: 300, y: 200, width: 20, height: 20 }))).toBeNull()
  })

  test('a stray blob at the edge does not stretch the box across the room', () => {
    const mask = maskWith(640, 480, { x: 240, y: 100, width: 160, height: 380 })
    for (let y = 0; y < 8; y++) for (let x = 630; x < 634; x++) mask.data[y * 640 + x] = 0.9
    const box = personBox(mask)!
    expect(box.x + box.width).toBeLessThan(420 / 640)
  })
})

describe('cropFor', () => {
  test('centres the person and keeps the picture its own shape', () => {
    const crop = cropFor({ x: 0.3, y: 0.3, width: 0.2, height: 0.7 })
    expect(crop.width).toBe(crop.height)
    expect(crop.x + crop.width / 2).toBeCloseTo(0.4, 5)
    expect(crop.y).toBeLessThan(0.3)
  })

  test('never zooms past the limit and never leaves the frame', () => {
    const crop = cropFor({ x: 0, y: 0.2, width: 0.05, height: 0.3 })
    expect(crop.width).toBeCloseTo(1 / MAX_ZOOM, 5)
    expect(crop.x).toBe(0)
    const wide = cropFor({ x: 0, y: 0, width: 1, height: 1 })
    expect(wide).toEqual(WHOLE_FRAME)
  })
})

describe('AutoFramer', () => {
  test('drifts towards the person rather than jumping', () => {
    const framer = new AutoFramer()
    const person = { x: 0.1, y: 0.3, width: 0.25, height: 0.7 }
    const first = framer.next(person)
    expect(first.width).toBeGreaterThan(0.95)
    const settled = settle(framer, person)
    expect(settled).toEqual(cropFor(person))
  })

  test('ignores small movements, so the picture does not twitch', () => {
    const framer = new AutoFramer()
    const person = { x: 0.3, y: 0.3, width: 0.3, height: 0.7 }
    const settled = settle(framer, person)
    expect(settle(framer, { ...person, x: 0.31 }, 50)).toEqual(settled)
  })

  test('holds through a short gap in the mask, then eases back to the whole frame', () => {
    const framer = new AutoFramer()
    const settled = settle(framer, { x: 0.3, y: 0.3, width: 0.2, height: 0.7 })
    expect(settle(framer, null, HOLD_FRAMES)).toEqual(settled)
    expect(settle(framer, null)).toEqual(WHOLE_FRAME)
  })
})
