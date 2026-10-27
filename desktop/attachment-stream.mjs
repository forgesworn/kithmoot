export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024
export const MAX_ATTACHMENT_CHUNK_BYTES = 1024 * 1024
export const MAX_ATTACHMENT_CHUNKS = 4096
export const MAX_ATTACHMENT_STREAMS = 8
export const MAX_OWNER_ATTACHMENT_BYTES = 512 * 1024 * 1024

const MIME_BY_KIND = new Map([
  ['image', new Set(['image/avif', 'image/bmp', 'image/gif', 'image/heic', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon'])],
  ['audio', new Set(['audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'])],
  ['video', new Set(['video/mp4', 'video/ogg', 'video/quicktime', 'video/webm'])],
])

export function validateAttachmentMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const { name, type, kind, size } = metadata
  if (typeof name !== 'string' || !name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) return undefined
  if (typeof type !== 'string' || !MIME_BY_KIND.get(kind)?.has(type)) return undefined
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) return undefined
  return { name, type, kind, size }
}

export function normaliseAttachmentChunk(chunk) {
  if (!(chunk instanceof Uint8Array) && !(chunk instanceof ArrayBuffer)) return undefined
  if (chunk.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) return undefined
  return chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(new Uint8Array(chunk))
}

export function parseAttachmentRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null
  if (header === undefined) return { start: 0, end: size - 1 }
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

export class AttachmentStream {
  #chunks = []
  #received = 0
  #active = true
  #complete = false
  #settled = false
  #ready
  #settle

  constructor(id, metadata) {
    this.id = id
    this.metadata = metadata
    this.#ready = new Promise(resolve => { this.#settle = resolve })
  }

  get active() { return this.#active }
  get complete() { return this.#complete }
  get received() { return this.#received }

  write(chunk, finish) {
    if (!this.#active || this.#complete) return false
    if (typeof finish !== 'boolean') { this.invalidate(); return false }
    const bytes = normaliseAttachmentChunk(chunk)
    if (!bytes || (!bytes.length && !finish) || (bytes.length > 0 && this.#chunks.length >= MAX_ATTACHMENT_CHUNKS) || this.#received + bytes.length > this.metadata.size) {
      this.invalidate()
      return false
    }
    if (bytes.length) {
      this.#chunks.push({ start: this.#received, bytes })
      this.#received += bytes.length
    }
    if (finish) {
      if (this.#received !== this.metadata.size) {
        this.invalidate()
        return false
      }
      this.#complete = true
      this.#resolve(true)
    }
    return true
  }

  ready() {
    if (!this.#active) return Promise.resolve(false)
    if (this.#complete) return Promise.resolve(true)
    return this.#ready
  }

  range(start, end) {
    if (!this.#active || !this.#complete || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= this.metadata.size) return undefined
    const parts = []
    for (const chunk of this.#chunks) {
      if (chunk.start > end) break
      if (chunk.start + chunk.bytes.length <= start) continue
      const from = Math.max(start, chunk.start)
      const to = Math.min(end + 1, chunk.start + chunk.bytes.length)
      parts.push(chunk.bytes.subarray(from - chunk.start, to - chunk.start))
    }
    return parts
  }

  invalidate() {
    if (!this.#active) return
    this.#active = false
    this.#complete = false
    this.#chunks = []
    this.#resolve(false)
  }

  #resolve(value) {
    if (this.#settled) return
    this.#settled = true
    this.#settle(value)
  }
}
