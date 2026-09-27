import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOX_BAR, BOX_GRIP, BOX_MIN, captureOf, clampBox, insideHole, moveTo, placeBox, resizeFrom } from '../redaction-geometry.mjs'

test('a new box sits in the middle of the work area, stepped so boxes never stack', () => {
  const work = { x: -1920, y: 25, width: 1920, height: 1055 }
  const first = placeBox(work, 0)
  assert.deepEqual(first, { x: -1920 + 780, y: 25 + 418, width: 360, height: 220 })
  assert.deepEqual(placeBox(work, 1), { ...first, x: first.x + 24, y: first.y + 24 })
  // A tiny work area still gets a usable box.
  assert.deepEqual(placeBox({ x: 0, y: 0, width: 100, height: 50 }, 0), { x: -10, y: -7, width: BOX_MIN.width, height: BOX_MIN.height })
})

test('only the see-through middle lets clicks through', () => {
  const bounds = { x: 100, y: 100, width: 300, height: 200 }
  assert.equal(insideHole({ x: 250, y: 200 }, bounds), true)
  assert.equal(insideHole({ x: 250, y: 100 + BOX_BAR - 1 }, bounds), false, 'the bar')
  assert.equal(insideHole({ x: 105, y: 295 }, bounds), false, 'bottom left grip')
  assert.equal(insideHole({ x: 395, y: 295 }, bounds), false, 'bottom right grip')
  assert.equal(insideHole({ x: 100 + BOX_GRIP, y: 295 }, bounds), true, 'between the grips')
  assert.equal(insideHole({ x: 400, y: 200 }, bounds), false, 'outside')
})

test('moving follows the cursor from where the drag began', () => {
  assert.deepEqual(moveTo({ x: 540, y: 330 }, { x: 40, y: 10 }, { x: 100, y: 100, width: 300, height: 200 }), { x: 500, y: 320, width: 300, height: 200 })
  assert.deepEqual(moveTo({ x: 1e9, y: -1e9 }, { x: 0, y: 0 }, { x: 0, y: 0, width: 300, height: 200 }), { x: 32000, y: -32000, width: 300, height: 200 })
})

test('resizing keeps the opposite corner and a minimum size', () => {
  const from = { x: 100, y: 100, width: 300, height: 200 }
  assert.deepEqual(resizeFrom('se', from, 40, 20), { x: 100, y: 100, width: 340, height: 220 })
  assert.deepEqual(resizeFrom('nw', from, -40, -20), { x: 60, y: 80, width: 340, height: 220 })
  assert.deepEqual(resizeFrom('ne', from, 10, 500), { x: 100, y: 100 + 200 - BOX_MIN.height, width: 310, height: BOX_MIN.height })
  assert.equal(resizeFrom('middle', from, 1, 1), undefined)
  assert.equal(resizeFrom('se', from, NaN, 1), undefined)
  assert.deepEqual(clampBox({ x: 1.4, y: 2.6, width: 1, height: 1e9 }), { x: 1, y: 3, width: BOX_MIN.width, height: 8000 })
})

test('a capture source maps to a display only when it cannot be another', () => {
  const displays = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(captureOf({ id: 'screen:2:0', display_id: '2' }, displays), { kind: 'screen', displayId: '2' })
  assert.deepEqual(captureOf({ id: 'window:123:0', display_id: '' }, displays), { kind: 'window' })
  // Linux capturers may omit display_id: fine with one display, unknown with two.
  assert.equal(captureOf({ id: 'screen:0:0', display_id: '' }, displays), null)
  assert.deepEqual(captureOf({ id: 'screen:0:0', display_id: '' }, [{ id: 7 }]), { kind: 'screen', displayId: '7' })
  assert.equal(captureOf({ id: 'screen:9:0', display_id: '9' }, displays), null)
  assert.equal(captureOf({ id: 'web-contents-media-stream://1' }, displays), null)
  assert.equal(captureOf(undefined, displays), null)
})
