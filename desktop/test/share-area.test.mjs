import { test } from 'node:test'
import assert from 'node:assert/strict'
import { areaRect } from '../share-area-geometry.mjs'

test('sharing area excludes frame and toolbar on displays with negative origins', () => {
  assert.deepEqual(areaRect({ x: -1806, y: 58, width: 652, height: 528 }, { x: -1920, y: 0, width: 1920, height: 1080 }), {
    x: 120 / 1920, y: 100 / 1080, width: 640 / 1920, height: 480 / 1080,
  })
})
test('invalid and cross-monitor crops cannot expose the whole desktop', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }
  for (const bounds of [
    { x: -20, y: 0, width: 640, height: 480 },
    { x: 1800, y: 0, width: 640, height: 480 },
    { x: 0, y: -50, width: 640, height: 480 },
    { x: 0, y: 900, width: 640, height: 480 },
    { x: 0, y: 0, width: 12, height: 48 },
  ]) assert.equal(areaRect(bounds, display), null)
})
