import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreBounds, readWindowState } from '../window-state.mjs'

const sizes = { width: 1320, height: 880, minWidth: 900, minHeight: 640 }
const displays = [{ workArea: { x: 0, y: 25, width: 1920, height: 1055 } }]
const defaults = { width: 1320, height: 880 }

test('a valid saved window returns as saved', () => {
  const saved = { x: 120, y: 120, width: 1000, height: 700, maximized: false }
  assert.deepEqual(restoreBounds(saved, displays, sizes), { x: 120, y: 120, width: 1000, height: 700 })
})

test('a window wholly off every screen opens at the default size', () => {
  assert.deepEqual(restoreBounds({ x: 5000, y: 5000, width: 1000, height: 700 }, displays, sizes), defaults)
  assert.deepEqual(restoreBounds({ x: -990, y: 100, width: 1000, height: 700 }, displays, sizes), defaults)
})

test('a window with a corner still on a screen is kept', () => {
  const kept = restoreBounds({ x: 1800, y: 900, width: 1000, height: 700 }, displays, sizes)
  assert.equal(kept.x, 1800)
})

test('a size below the minimum clamps up, and one above the screen clamps down', () => {
  assert.deepEqual(restoreBounds({ x: 10, y: 40, width: 300, height: 200 }, displays, sizes), { x: 10, y: 40, width: 900, height: 640 })
  assert.deepEqual(restoreBounds({ x: 0, y: 25, width: 4000, height: 3000 }, displays, sizes), { x: 0, y: 25, width: 1920, height: 1055 })
})

test('a second display counts', () => {
  const two = [...displays, { workArea: { x: 1920, y: 0, width: 1280, height: 800 } }]
  assert.equal(restoreBounds({ x: 2000, y: 50, width: 1000, height: 700 }, two, sizes).x, 2000)
})

test('anything but finite integers is ignored', () => {
  for (const bad of [null, undefined, 'x', 3, [], {}, { x: 1.5, y: 0, width: 1000, height: 700 }, { x: 0, y: 0, width: NaN, height: 700 }, { x: '0', y: 0, width: 1000, height: 700 }]) {
    assert.deepEqual(restoreBounds(bad, displays, sizes), defaults)
  }
  assert.equal(restoreBounds({ x: 0, y: 30, width: 1000, height: 700 }, 'nope', sizes).width, 1320)
})

test('maximised is true only when it says true', () => {
  assert.equal(readWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: true }).maximized, true)
  assert.equal(readWindowState({ x: 0, y: 0, width: 1000, height: 700, maximized: 'yes' }).maximized, false)
})
