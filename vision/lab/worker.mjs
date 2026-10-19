import { CameraVisionRuntime } from './runtime.mjs'

let runtime, epoch = 0, reference, previous, temporal = false, generation = 0
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const ownGeneration = ++generation
      runtime?.close(); runtime = undefined
      const response = await fetch('./runtime.wasm')
      if (!response.ok) throw new Error('Build the local Rust/WASM runtime first')
      const next = await CameraVisionRuntime.create(await response.arrayBuffer(), data.weights, 160, 96)
      if (ownGeneration !== generation) { next.close(); return }
      runtime = next
      self.postMessage({ type: 'ready', workspaceBytes: runtime.workspaceBytes })
    } else if (data.type === 'reset') {
      epoch = data.epoch; reference = data.reference; previous = undefined; temporal = data.temporal
    } else if (data.type === 'frame') {
      if (!runtime || data.epoch !== epoch) throw new Error('Superseded frame or missing model')
      const start = performance.now()
      const result = runtime.run({ rgb: data.rgb, reference, previousAlpha: temporal ? previous : undefined,
        width: 160, height: 96, tasks: data.tasks })
      // Borrowed WASM views must be copied before the next prepare/run.
      const alpha = result.alpha?.slice() ?? null
      previous = temporal ? alpha?.slice() : undefined
      const boxes = result.faceBoxes?.slice() ?? null
      const message = { type: 'result', epoch: data.epoch, id: data.id, alpha, boxes,
        facesUsable: result.facesUsable, inferenceMs: performance.now() - start }
      self.postMessage(message, [alpha?.buffer, boxes?.buffer].filter(Boolean))
    }
  } catch (error) {
    previous = undefined
    self.postMessage({ type: 'error', epoch: data.epoch ?? epoch, id: data.id, message: String(error.message ?? error) })
  }
}
