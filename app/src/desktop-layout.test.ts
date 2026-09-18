// The arithmetic behind "person beside their screen", with no document in
// sight. `desktop-layout.ts` itself is DOM wiring that runs the moment it is
// imported and pulls a stylesheet in with it, so what is worth testing here
// was split out into `desktop-layout-fit.ts` and is imported from there; the
// DOM half is proven in the browser by test/desktop-room-layout.spec.ts.
//
// Two failures are being guarded against, and both of them shipped once. A
// share letterboxed inside black bands, because the box was 16:9 and the
// picture was not. And a second sharer pushed off the bottom of the window,
// because each row was allowed to be as tall as its own picture wanted.
import { expect, test } from 'vitest'
import { CAMERA_ASPECT, CAMERA_MIN_PX, CAMERA_TILE_PX, MIN_SHARE_HEIGHT, cameraWidthFor, fitShare, shareRowBudget } from './desktop-layout-fit.js'

test('a share fills the width it is given when the height allows it', () => {
  const box = fitShare({ aspect: 16 / 9, maxWidth: 800, maxHeight: 600 })
  expect(box.width).toBe(800)
  expect(box.height).toBe(450)
})

test('a share gives width back rather than being letterboxed', () => {
  // 800 wide at 16:9 wants 450 high and may only have 300. A box that stayed
  // 800 wide would show the picture 533x300 with 133px of black each side -
  // the exact bug this exists to stop.
  const box = fitShare({ aspect: 16 / 9, maxWidth: 800, maxHeight: 300 })
  expect(box.height).toBe(300)
  expect(box.width).toBe(533)
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.01)
})

test('a tall screen keeps its own shape rather than being forced to 16:9', () => {
  const portrait = fitShare({ aspect: 3 / 4, maxWidth: 800, maxHeight: 600 })
  expect(portrait.height).toBe(600)
  expect(portrait.width).toBe(450)
  const ultrawide = fitShare({ aspect: 21 / 9, maxWidth: 800, maxHeight: 600 })
  expect(ultrawide.width).toBe(800)
  expect(ultrawide.height).toBe(343)
})

test('every box that comes back is the shape of its picture', () => {
  for (const aspect of [4 / 3, 16 / 9, 16 / 10, 21 / 9, 3 / 4, 1]) {
    for (const maxWidth of [320, 640, 900, 1440]) {
      for (const maxHeight of [160, 300, 480, 900]) {
        const box = fitShare({ aspect, maxWidth, maxHeight })
        // Within a pixel of the picture's own shape: whole-pixel boxes are
        // what the browser can actually draw, and half a pixel of band is
        // not a band.
        const drawn = Math.min(box.width, box.height * aspect)
        const drawnHeight = drawn / aspect
        expect(drawn * drawnHeight).toBeGreaterThan(box.width * box.height * 0.99)
      }
    }
  }
})

test('a share never fills more than it was given', () => {
  const box = fitShare({ aspect: 16 / 9, maxWidth: 400, maxHeight: 1000 })
  expect(box.width).toBeLessThanOrEqual(400)
  const tall = fitShare({ aspect: 1, maxWidth: 1000, maxHeight: 220 })
  expect(tall.height).toBeLessThanOrEqual(220)
})

test('a broken or missing aspect falls back to a sensible one', () => {
  for (const aspect of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const box = fitShare({ aspect, maxWidth: 800, maxHeight: 600 })
    expect(box.width).toBe(800)
    expect(box.height).toBe(450)
  }
})

test('two sharers split the height between them, both on screen', () => {
  const budget = shareRowBudget(700, 2, 10)
  expect(budget).toBe(345)
  // The point of the division: two rows plus the gap between them fit in
  // what there was, rather than the second one starting below the fold.
  expect(budget * 2 + 10).toBeLessThanOrEqual(700)
})

test('one sharer takes the lot', () => {
  expect(shareRowBudget(700, 1, 10)).toBe(700)
})

test('a crowd of sharers is allowed to scroll rather than be unreadable', () => {
  // Six shares in 700px would be 108 each. Below the floor the room scrolls
  // instead: a sliver of somebody's screen helps nobody.
  const budget = shareRowBudget(700, 6, 10)
  expect(budget).toBe(MIN_SHARE_HEIGHT)
})

test('no sharers asks for no height', () => {
  expect(shareRowBudget(700, 0, 10)).toBe(0)
})

test('the camera tile is the size the owner asked for', () => {
  // 240-320px was the brief; anything outside it is either a portrait strip
  // or half the window.
  for (const width of [CAMERA_MIN_PX, CAMERA_TILE_PX]) {
    expect(width).toBeGreaterThanOrEqual(240)
    expect(width).toBeLessThanOrEqual(320)
  }
})

test('a roomy window gets the full-size camera', () => {
  expect(cameraWidthFor(400, 60)).toBe(CAMERA_TILE_PX)
})

test('a short window brings the camera down rather than clipping a row', () => {
  // 257 of row, 65 of it spent on the name and the buttons: a 216px-tall
  // camera would not fit, so it comes down to fit the 192 that is left.
  const width = cameraWidthFor(257, 65)
  expect(width).toBe(256)
  expect(width / CAMERA_ASPECT).toBeLessThanOrEqual(257 - 65)
})

test('the camera never shrinks past being a face', () => {
  expect(cameraWidthFor(100, 65)).toBe(CAMERA_MIN_PX)
  expect(cameraWidthFor(0, 0)).toBe(CAMERA_MIN_PX)
})
