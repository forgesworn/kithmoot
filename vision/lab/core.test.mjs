import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameGate, contain, nchw, grey, rectangle, checkedWeights } from './core.mjs'

test('old camera/model/reference results cannot replace a newer frame or release its busy slot', () => {
  const gate = new FrameGate(), old = gate.begin({ frame: 'old' })
  gate.invalidate()
  assert.equal(gate.begin({ frame: 'new' }), null)
  assert.equal(gate.finish({ ...old, id: 999 }), null)
  assert.equal(gate.begin({ frame: 'new' }), null)
  assert.equal(gate.finish(old), null)
  const next = gate.begin({ frame: 'new' })
  assert.deepEqual(gate.finish(next), { frame: 'new' })
  const aba = gate.begin({ frame: 'before-away-and-back' })
  gate.invalidate(); gate.invalidate()
  assert.equal(gate.finish(aba), null)
  gate.cancel(); assert.ok(gate.begin({ frame: 'fresh worker' }))
})

test('portrait and ultrawide sources retain all edges; annotations share that coordinate system', () => {
  assert.deepEqual(contain(1080, 1920), { x: 106, y: 0, width: 108, height: 192 })
  assert.deepEqual(contain(3840, 1080), { x: 0, y: 51, width: 320, height: 90 })
  const actual = rectangle({ x: 288, y: 173 }, { x: 32, y: 19.2 })
  const expected = [0.1, 0.1, 0.8, (173 - 19.2) / 192]
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12))
  assert.equal(rectangle({ x: 0, y: 0 }, { x: 1, y: 1 }), null)
})

test('camera channels and matte opacity are distinct from grey training labels', () => {
  assert.deepEqual([...nchw(Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255), 2, 1)], [1, 0, 0, 1, 0, 0])
  assert.deepEqual([...grey(Float32Array.of(0, 1), 2, 1)], [0, 0, 0, 255, 255, 255, 255, 255])
  assert.deepEqual([...grey(Float32Array.of(0, 1), 2, 1, true)], [255, 255, 255, 0, 255, 255, 255, 255])
  assert.throws(() => grey(Float32Array.of(NaN), 1, 1))
})

test('local model upload rejects swapped metadata or weights before starting the worker', async () => {
  const weights = new ArrayBuffer(79_904)
  new Uint8Array(weights).set(new TextEncoder().encode('KVM2'))
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', weights))].map(n => n.toString(16).padStart(2, '0')).join('')
  assert.equal(await checkedWeights(weights, { format: 'KVM2', portable_weights_sha256: hash }), hash)
  await assert.rejects(checkedWeights(weights, { format: 'KVM2', portable_weights_sha256: '0'.repeat(64) }), /checksum/)
  await assert.rejects(checkedWeights(weights, { format: 'KVM1', portable_weights_sha256: hash }), /format/)
})
