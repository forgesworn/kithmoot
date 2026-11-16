import { sniffKind } from '../../src/attachment-safety.js'

const MAX_BYTES = 64 * 1024 * 1024
const prepared = new WeakMap<File, Promise<File>>()
const refused = () => new Error('This file could not be cleaned safely. Nothing was uploaded. Export a fresh PNG/JPEG, MP4/WebM, MP3/WAV, PDF or plain-text copy and try again.')
const text = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
const join = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

/** Preserve APNG frames and timing, dropping text, EXIF, timestamps and
 * unknown ancillary chunks. Still pictures take the fresh pixel path. */
export function cleanAnimatedPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT', 'sRGB', 'gAMA', 'cHRM'])
  const parts = [bytes.subarray(0, 8)]
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), end = offset + 12 + length, kind = text(bytes, offset + 4, offset + 8)
    if (end > bytes.length) throw refused()
    if (keep.has(kind)) parts.push(bytes.subarray(offset, end))
    else if (kind[0] === kind[0]?.toUpperCase()) throw refused()
    offset = end
    if (kind === 'IEND') return join(parts)
  }
  throw refused()
}

export function cleanGif(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length < 14) throw refused()
  let offset = 13 + ((bytes[10]! & 0x80) ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0)
  const parts = [bytes.subarray(0, offset)]
  const blocks = () => {
    for (;;) {
      if (offset >= bytes.length) throw refused()
      const size = bytes[offset++]!
      offset += size
      if (offset > bytes.length) throw refused()
      if (!size) return
    }
  }
  while (offset < bytes.length) {
    const start = offset, marker = bytes[offset++]
    if (marker === 0x3b) { parts.push(bytes.subarray(start, offset)); return join(parts) }
    if (marker === 0x2c) {
      if (offset + 9 > bytes.length) throw refused()
      const packed = bytes[offset + 8]!
      offset += 9 + ((packed & 0x80) ? 3 * (2 ** ((packed & 7) + 1)) : 0)
      offset++ // LZW minimum code size
      blocks(); parts.push(bytes.subarray(start, offset))
    } else if (marker === 0x21) {
      const label = bytes[offset++]
      const application = label === 0xff ? text(bytes, offset + 1, Math.min(offset + 12, bytes.length)) : ''
      blocks()
      if (label === 0xf9 && offset - start === 8 && bytes[start + 2] === 4 || ((application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') && offset - start === 19 && bytes[start + 2] === 11 && bytes[start + 14] === 3 && bytes[start + 15] === 1)) parts.push(bytes.subarray(start, offset))
      else if (label !== 0xfe && label !== 0xff) throw refused()
    } else throw refused()
  }
  throw refused()
}

export function cleanWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunks = (start: number, end: number, frame = false): Uint8Array<ArrayBuffer> => {
    const parts: Uint8Array[] = []
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) throw refused()
      const kind = text(bytes, offset, offset + 4), size = view.getUint32(offset + 4, true), next = offset + 8 + size + (size & 1)
      if (next > end) throw refused()
      if ((frame ? ['VP8 ', 'VP8L', 'ALPH'] : ['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'VP8X']).includes(kind)) {
        const chunk = bytes.slice(offset, next)
        if (kind === 'VP8X') { if (size !== 10) throw refused(); chunk[8] = chunk[8]! & ~0x2c }
        parts.push(chunk)
      } else if (kind === 'ANMF' && !frame) {
        if (size < 16) throw refused()
        const content = join([bytes.subarray(offset + 8, offset + 24), chunks(offset + 24, offset + 8 + size, true)])
        const header = bytes.slice(offset, offset + 8)
        new DataView(header.buffer).setUint32(4, content.length, true)
        parts.push(header, content, ...(content.length & 1 ? [new Uint8Array(1)] : []))
      }
      offset = next
    }
    return join(parts)
  }
  if (bytes.length < 20) throw refused()
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8
  if (declared > bytes.length) throw refused()
  const result = join([bytes.subarray(0, 12), chunks(12, declared)])
  new DataView(result.buffer).setUint32(4, result.length - 8, true)
  return result
}

async function pixels(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000 || bitmap.width > 16384 || bitmap.height > 16384) throw refused()
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw refused()
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.96))
    if (!blob) throw refused()
    return blob
  } finally { bitmap.close() }
}

/** One cached cleaned copy, reused on retries. Never return the original as
 * an error fallback. The original remains on the sender's device. */
export function cleanAttachment(file: File, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted()
  let work = prepared.get(file)
  if (!work) {
    work = clean(file)
    prepared.set(file, work)
    void work.then(result => prepared.set(result, Promise.resolve(result)), () => prepared.delete(file))
  }
  return work.then(result => { signal?.throwIfAborted(); return result })
}

async function clean(file: File): Promise<File> {
  if (file.size > MAX_BYTES) throw new Error('Metadata cleaning currently supports files up to 64 MiB. Nothing was uploaded. Export a smaller copy and try again.')
  if (!file.size) throw refused()
  const bytes = new Uint8Array(await file.arrayBuffer()), kind = sniffKind(bytes)
  let blob: Blob
  if (kind === 'gif') blob = new Blob([cleanGif(bytes)], { type: 'image/gif' })
  else if (kind === 'webp') blob = new Blob([cleanWebp(bytes)], { type: 'image/webp' })
  else if (kind === 'png') {
    const cleaned = cleanAnimatedPng(bytes)
    let animated = false
    for (let offset = 8; offset + 12 <= cleaned.length;) {
      if (text(cleaned, offset + 4, offset + 8) === 'acTL') animated = true
      offset += 12 + new DataView(cleaned.buffer).getUint32(offset)
    }
    blob = animated
      ? new Blob([cleaned], { type: 'image/png' }) : await pixels(new File([bytes], file.name, { type: 'image/png' }))
  } else if (['jpeg', 'avif', 'heic', 'bmp', 'ico', 'svg'].includes(kind)) {
    if (kind === 'avif' && text(bytes, 8, 12) === 'avis') throw refused()
    blob = await pixels(new File([bytes], file.name, { type: kind === 'jpeg' ? 'image/jpeg' : file.type }))
  } else if (['mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac'].includes(kind)) {
    const { cleanMedia } = await import('./attachment-metadata-media.js')
    blob = await cleanMedia(file, kind)
  } else if (kind === 'pdf' || kind === 'zip') {
    const { cleanDocument } = await import('./attachment-metadata-document.js')
    blob = await cleanDocument(file, bytes, kind)
  } else if (kind === 'text' && /\.(txt|md|csv|tsv|log|json|ya?ml|srt|vtt)$/i.test(file.name)) {
    // Text has no separate metadata container. Keep its visible content.
    blob = new Blob([bytes], { type: file.type || 'text/plain' })
  } else throw refused()
  if (!blob.size || blob.size > MAX_BYTES) throw refused()
  const oldExt = /\.[^.]+$/.exec(file.name)?.[0] ?? ''
  const ext = blob.type === 'image/png' ? (/^\.png$/i.test(oldExt) ? oldExt : '.png') : blob.type === 'image/jpeg' ? (/^\.jpe?g$/i.test(oldExt) ? oldExt : '.jpg') : oldExt
  const name = ext !== oldExt ? file.name.slice(0, file.name.length - oldExt.length) + ext : file.name
  return new File([blob], name, { type: blob.type, lastModified: 0 })
}
