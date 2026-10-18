/** MIT camera-lab geometry and frame ownership. No network or camera access. */
export const WIDTH = 320, HEIGHT = 192, MODEL_WIDTH = 160, MODEL_HEIGHT = 96

export function contain(width, height, targetWidth = WIDTH, targetHeight = HEIGHT) {
  if (!(width > 0 && height > 0)) throw new Error('Input has no picture')
  const scale = Math.min(targetWidth / width, targetHeight / height)
  return { x: (targetWidth - width * scale) / 2, y: (targetHeight - height * scale) / 2,
    width: width * scale, height: height * scale }
}

export function nchw(rgba, width, height) {
  const pixels = width * height
  if (rgba.length !== pixels * 4) throw new Error('Invalid RGBA frame')
  const result = new Float32Array(pixels * 3)
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) result[c * pixels + i] = rgba[i * 4 + c] / 255
  return result
}

export function grey(alpha, width, height, opacity = false) {
  if (alpha.length !== width * height) throw new Error('Invalid matte dimensions')
  const rgba = new Uint8ClampedArray(alpha.length * 4)
  for (let i = 0; i < alpha.length; i++) {
    if (!Number.isFinite(alpha[i])) throw new Error('Non-finite matte')
    const value = Math.round(Math.max(0, Math.min(1, alpha[i])) * 255)
    rgba.set(opacity ? [255, 255, 255, value] : [value, value, value, 255], i * 4)
  }
  return rgba
}

export function rectangle(a, b, width = WIDTH, height = HEIGHT) {
  const x = Math.max(0, Math.min(width, Math.min(a.x, b.x)))
  const y = Math.max(0, Math.min(height, Math.min(a.y, b.y)))
  const right = Math.max(0, Math.min(width, Math.max(a.x, b.x)))
  const bottom = Math.max(0, Math.min(height, Math.max(a.y, b.y)))
  return right - x < 2 || bottom - y < 2 ? null : [x / width, y / height, (right - x) / width, (bottom - y) / height]
}

/** Retain one captured frame until its own result arrives. Invalidating an
 * epoch never releases the busy slot early or queues more inference work. */
export class FrameGate {
  epoch = 0
  pending = null
  #serial = 0
  invalidate() { return ++this.epoch }
  begin(frame) {
    if (this.pending) return null
    this.pending = { epoch: this.epoch, id: ++this.#serial, frame }
    return { epoch: this.epoch, id: this.#serial }
  }
  finish(message) {
    if (!this.pending || this.pending.id !== message.id) return null
    const pending = this.pending
    this.pending = null
    return pending.epoch === this.epoch && message.epoch === this.epoch ? pending.frame : null
  }
  cancel() { this.invalidate(); this.pending = null }
}

export async function checkedWeights(bytes, card) {
  if (!(bytes instanceof ArrayBuffer) || ![79_904, 120_352].includes(bytes.byteLength)) throw new Error('Choose an owned KVM1/KVM2 export')
  const magic = new TextDecoder().decode(new Uint8Array(bytes, 0, 4))
  if (!['KVM1', 'KVM2'].includes(magic) || magic !== card.format) throw new Error('Model format and card differ')
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
  if (hash !== card.portable_weights_sha256) throw new Error('Model checksum does not match its export card')
  return hash
}
