import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOX_BAR, BOX_GRIP, BOX_MIN, DisplaySettle, SETTLE_MS, captureOf, clampBox, insideHole, moveTo, onOneDisplay, placeBox, resizeFrom } from '../redaction-geometry.mjs'

test('a moved box slides back wholly onto one display', () => {
  const left = { x: 0, y: 0, width: 1440, height: 900 }
  const right = { x: 1440, y: 0, width: 1920, height: 1080 }
  // Mostly on the left display: pulled back inside it.
  assert.deepEqual(onOneDisplay({ x: 1300, y: 100, width: 300, height: 200 }, left), { x: 1140, y: 100, width: 300, height: 200 })
  // Mostly on the right: pushed wholly onto it.
  assert.deepEqual(onOneDisplay({ x: 1400, y: 100, width: 300, height: 200 }, right), { x: 1440, y: 100, width: 300, height: 200 })
  // Off the bottom and taller than the display.
  assert.deepEqual(onOneDisplay({ x: 10, y: 800, width: 300, height: 2000 }, left), { x: 10, y: 0, width: 300, height: 900 })
  // Already inside: unchanged.
  assert.deepEqual(onOneDisplay({ x: 10, y: 10, width: 300, height: 200 }, left), { x: 10, y: 10, width: 300, height: 200 })
})

test('a resized box stops at its display edge, keeping the corner held still', () => {
  const left = { x: 0, y: 0, width: 1440, height: 900 }
  assert.deepEqual(onOneDisplay({ x: 1200, y: 100, width: 400, height: 200 }, left, true), { x: 1200, y: 100, width: 240, height: 200 })
  assert.deepEqual(onOneDisplay({ x: -50, y: -20, width: 400, height: 200 }, left, true), { x: 0, y: 0, width: 350, height: 180 })
})

test('a display change sets a deadline and re-reads the state part way through and just after it', () => {
  let now = 10_000
  const timers = []
  let reports = 0
  const settle = new DisplaySettle({
    report: () => { reports++ }, now: () => now,
    setTimer: (run, delay) => { const timer = { run, delay, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
  })
  assert.equal(settle.deadline, 0)
  settle.changed()
  assert.equal(settle.deadline, 10_000 + SETTLE_MS)
  assert.equal(reports, 1)
  assert.deepEqual(timers.map(timer => timer.delay), [SETTLE_MS / 4, SETTLE_MS + 50])
  // A second change restarts the clock and drops the old re-reads.
  now = 10_500
  settle.changed()
  assert.equal(settle.deadline, 10_500 + SETTLE_MS)
  assert.deepEqual(timers.slice(0, 2).map(timer => timer.cleared), [true, true])
  for (const timer of timers.slice(2)) timer.run()
  assert.equal(reports, 4)
  settle.dispose()
  assert.ok(timers.slice(2).every(timer => timer.cleared))
})

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
