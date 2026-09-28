import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AREA_INSET, areaRect, areaShape, insideArea } from '../share-area-geometry.mjs'

test('sharing area excludes frame and toolbar on displays with negative origins', () => {
  assert.deepEqual(areaRect({ x: -1808, y: 48, width: 656, height: 572 }, { x: -1920, y: 0, width: 1920, height: 1080 }), {
    x: 120 / 1920, y: 100 / 1080, width: 640 / 1920, height: 480 / 1080,
  })
})
test('invalid and cross-monitor crops cannot expose the whole desktop', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  for (const bounds of [
    { x: -20, y: 0, width: 640, height: 480 },
    { x: 1800, y: 0, width: 640, height: 480 },
    { x: 0, y: -60, width: 640, height: 480 },
    { x: 0, y: 900, width: 640, height: 480 },
    { x: 0, y: 0, width: 12, height: 48 },
  ]) assert.equal(areaRect(bounds, display), null)
})
test('only the drawing hole lets clicks through', () => {
  const bounds = { x: -1808, y: 48, width: 656, height: 572 }
  assert.equal(insideArea({ x: -1500, y: 300 }, bounds), true)
  for (const point of [{ x: -1500, y: 60 }, { x: -1802, y: 300 }, { x: -1158, y: 300 }, { x: -1500, y: 600 }, { x: 0, y: 0 }]) assert.equal(insideArea(point, bounds), false)
})

test('the shape of the frame is everything but the hole', () => {
  const within = (point, rects) => rects.some(rect => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height)
  for (const size of [{ width: 900, height: 600 }, { width: 460, height: 200 }, { width: 3000, height: 1700 }]) {
    const shape = areaShape(size)
    for (const rect of shape) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= size.width && rect.y + rect.height <= size.height, JSON.stringify(rect))
    // One answer for every point: in the shape, or in the hole the crop is taken from.
    for (let x = 0; x < size.width; x += 11) for (let y = 0; y < size.height; y += 7) {
      assert.equal(within({ x, y }, shape), !insideArea({ x, y }, { x: 0, y: 0, ...size }), `${x},${y}`)
    }
  }
})
test('a frame too small to have a hole is all control', () => {
  assert.deepEqual(areaShape({ width: 400, height: AREA_INSET.top + AREA_INSET.bottom }), [{ x: 0, y: 0, width: 400, height: AREA_INSET.top + AREA_INSET.bottom }])
})
