/** Original MIT host for the Rust WASM engine. No fetch, SDK or telemetry.
 * Run in a Worker. The host supplies bundled, hash-verified model bytes.
 * Returned views last only until the next prepare/run/close; copy to retain.
 */
export class CameraVisionRuntime {
  #wasm
  #handle

  static async create(wasmBytes, weightBytes, width = 160, height = 96) {
    const module = await WebAssembly.compile(wasmBytes)
    if (WebAssembly.Module.imports(module).length) throw new Error('Vision WASM must have no host imports')
    const instance = await WebAssembly.instantiate(module, {})
    const runtime = new CameraVisionRuntime(instance.exports)
    runtime.#load(weightBytes, width, height)
    return runtime
  }

  constructor(exports) { this.#wasm = exports }

  #load(weights, width, height) {
    const bytes = weights instanceof Uint8Array ? weights : new Uint8Array(weights)
    if (bytes.length < 8 || bytes.length > this.#wasm.kv_weight_bytes()) throw new Error('Invalid vision weights')
    const pointer = this.#wasm.kv_alloc_weights()
    if (!pointer) throw new Error('Vision allocation failed')
    try {
      new Uint8Array(this.#wasm.memory.buffer, pointer, bytes.length).set(bytes)
      this.#handle = this.#wasm.kv_create(pointer, bytes.length, width, height)
      if (!this.#handle) throw new Error('Vision model or dimensions rejected')
    } finally { this.#wasm.kv_free_weights(pointer) }
  }

  #input(kind, data) {
    const size = this.#wasm.kv_input_len(this.#handle, kind)
    if (!(data instanceof Float32Array) || data.length !== size) throw new Error('Invalid vision input shape')
    const pointer = this.#wasm.kv_input_ptr(this.#handle, kind)
    if (!pointer) throw new Error('Vision input unavailable')
    new Float32Array(this.#wasm.memory.buffer, pointer, size).set(data)
  }

  #output(kind) {
    const size = this.#wasm.kv_output_len(this.#handle, kind)
    const pointer = this.#wasm.kv_output_ptr(this.#handle, kind)
    if (!pointer) throw new Error('Vision output unavailable')
    return new Float32Array(this.#wasm.memory.buffer, pointer, size)
  }

  run({ rgb, reference, previousAlpha, width, height, tasks = 'both' }) {
    if (!this.#handle) throw new Error('Vision runtime closed')
    if (!['both', 'faces', 'matte'].includes(tasks)) throw new Error('Unknown vision task')
    if (!this.#wasm.kv_prepare(this.#handle, width, height)) throw new Error('Invalid vision dimensions')
    this.#input(0, rgb)
    if (reference) this.#input(1, reference)
    if (previousAlpha) this.#input(2, previousAlpha)
    const taskFlags = tasks === 'faces' ? 4 : tasks === 'matte' ? 8 : 0
    if (!this.#wasm.kv_run(this.#handle, (reference ? 1 : 0) | (previousAlpha ? 2 : 0) | taskFlags)) {
      throw new Error('Vision inference failed')
    }
    return { alpha: tasks === 'faces' ? null : this.#output(0),
      faceLogits: tasks === 'matte' ? null : this.#output(1), faceGeometry: tasks === 'matte' ? null : this.#output(2),
      faceBoxes: tasks === 'matte' ? null : this.#output(3), facesUsable: this.#wasm.kv_faces_usable(this.#handle) === 1 }
  }

  get workspaceBytes() { return this.#handle ? this.#wasm.kv_workspace_bytes(this.#handle) : 0 }

  close() {
    if (this.#handle) this.#wasm.kv_free(this.#handle)
    this.#handle = 0
  }
}
