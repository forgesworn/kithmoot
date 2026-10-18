import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CameraVisionRuntime } from '../web/runtime.mjs'

const [wasmPath, vectorPath] = process.argv.slice(2)
if (!wasmPath || !vectorPath) throw new Error('check-wasm.mjs <runtime.wasm> <parity.json>')
const wasm = await readFile(wasmPath)
const vector = JSON.parse(await readFile(vectorPath, 'utf8'))
const weights = await readFile(vectorPath.replace(/\.json$/, '.kvm'))
const runtime = await CameraVisionRuntime.create(wasm, weights, vector.width, vector.height)
const results = []
try {
  for (const item of vector.cases) {
    const actual = runtime.run({ rgb: Float32Array.from(vector.rgb), width: vector.width, height: vector.height,
      ...(item.flags & 1 ? { reference: Float32Array.from(vector.reference) } : {}),
      ...(item.flags & 2 ? { previousAlpha: Float32Array.from(vector.previousAlpha) } : {}) })
    const errors = [actual.alpha, actual.faceLogits, actual.faceGeometry].map((values, kind) => {
      assert.equal(values.length, item.expected[kind].length)
      let max = 0
      for (let index = 0; index < values.length; index++) {
        const wanted = item.expected[kind][index]
        const error = Math.abs(values[index] - wanted)
        assert.ok(error <= 0.0003 + Math.abs(wanted) * 0.0003, `WASM output ${kind} differs at ${index}: ${error}`)
        max = Math.max(max, error)
      }
      return max
    })
    results.push({ flags: item.flags, max_errors: errors })
    assert.equal(actual.facesUsable, item.faces_usable)
    const decoded = item.faces.flat()
    assert.equal(actual.faceBoxes.length, decoded.length)
    actual.faceBoxes.forEach((value, index) => assert.ok(Math.abs(value - decoded[index]) < 0.0003))
  }
  const faces = runtime.run({ rgb: Float32Array.from(vector.rgb), width: vector.width, height: vector.height, tasks: 'faces' })
  assert.equal(faces.alpha, null)
  assert.ok(faces.faceLogits instanceof Float32Array)
  const matte = runtime.run({ rgb: Float32Array.from(vector.rgb), width: vector.width, height: vector.height, tasks: 'matte' })
  assert.equal(matte.faceLogits, null)
  assert.equal(matte.faceBoxes, null)
  assert.ok(matte.alpha instanceof Float32Array)
  assert.throws(() => runtime.run({ rgb: new Float32Array(3), width: vector.width, height: vector.height }))
  const invalid = Float32Array.from(vector.rgb)
  invalid[0] = Number.NaN
  assert.throws(() => runtime.run({ rgb: invalid, width: vector.width, height: vector.height }))
  console.log(JSON.stringify({ wasm_parity: 'passed', bytes: wasm.length, cases: results }))
} finally { runtime.close() }
assert.throws(() => runtime.run({ rgb: Float32Array.from(vector.rgb), width: vector.width, height: vector.height }))
