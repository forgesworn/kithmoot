import { readFile } from 'node:fs/promises'
import { CameraVisionRuntime } from '../web/runtime.mjs'

const [wasmPath, weightsPath, count = '20'] = process.argv.slice(2)
if (!wasmPath || !weightsPath) throw new Error('bench-wasm.mjs <runtime.wasm> <weights.kvm> [frames]')
const frames = Number(count)
if (!Number.isSafeInteger(frames) || frames < 1) throw new Error('Invalid frame count')
const wasm = await readFile(wasmPath)
const runtime = await CameraVisionRuntime.create(wasm, await readFile(weightsPath))
const rgb = Float32Array.from({ length: 3 * 160 * 96 }, (_, index) => (index % 251) / 250)
try {
  for (const tasks of ['faces', 'matte', 'both']) {
    const input = { rgb, width: 160, height: 96, tasks }
    for (let i = 0; i < 3; i++) runtime.run(input)
    const timings = []
    for (let i = 0; i < frames; i++) {
      const started = performance.now()
      runtime.run(input)
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    console.log(JSON.stringify({ engine: 'Node WASM SIMD', tasks, frames, width: 160, height: 96,
      mean_ms: timings.reduce((a, b) => a + b, 0) / frames, p50_ms: timings[Math.floor(frames / 2)],
      p95_ms: timings[Math.min(frames - 1, Math.floor(frames * .95))], workspace_bytes: runtime.workspaceBytes,
      wasm_bytes: wasm.length, qualified: false }))
  }
} finally { runtime.close() }
