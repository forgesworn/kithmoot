import { base64 } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'

export const MAX_LOGO_BYTES = 16_384
export const MAX_LOGO_PIXELS = 256
export interface LogoImage {
  v: 1
  mime: 'image/png' | 'image/webp'
  width: number
  height: number
  data: string
  sha256: string
}
const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
const square = (width: number, height: number) => width > 0 && width === height && width <= MAX_LOGO_PIXELS

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** A restricted still-image container, not a full image decoder. Renderers
 * still decode it locally and fall back when the compressed pixels fail. */
function pngSize(bytes: Uint8Array): [number, number] | undefined {
  if (bytes.length < 45 || bytes.subarray(0, 8).some((byte, i) => byte !== [137, 80, 78, 71, 13, 10, 26, 10][i])) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8, size: [number, number] | undefined, image = false, imageEnded = false
  const seen = new Set<string>()
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), type = ascii(bytes, offset + 4, 4), end = offset + 12 + length
    if (end > bytes.length || !['IHDR', 'PLTE', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'IDAT', 'IEND'].includes(type)) return
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) return
    if (type !== 'IDAT' && seen.has(type)) return
    if (!size && type !== 'IHDR') return
    if (type === 'IHDR') {
      if (length !== 13 || offset !== 8) return
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12)
      if (!square(width, height) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return
      size = [width, height]
    } else if (type === 'IDAT') {
      if (!length || imageEnded) return
      image = true
    } else if (type === 'IEND') {
      return length === 0 && image && end === bytes.length ? size : undefined
    } else {
      if (image) imageEnded = true
      if (image || type === 'PLTE' && (!length || length > 768 || length % 3 !== 0) || type === 'sRGB' && length !== 1 ||
          type === 'gAMA' && length !== 4 || type === 'cHRM' && length !== 32 || type === 'tRNS' && length > 256) return
    }
    seen.add(type); offset = end
  }
}

function webpSize(bytes: Uint8Array): [number, number] | undefined {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.length) return
  const uint24 = (offset: number) => bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536
  let offset = 12, canvas: [number, number] | undefined, frame: [number, number] | undefined, alpha = false, alphaChunk = false
  const seen = new Set<string>()
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4), length = view.getUint32(offset + 4, true), data = offset + 8, end = data + length
    if (end + (length % 2) > bytes.length || length % 2 && bytes[end] !== 0 || seen.has(type) || frame ||
        !['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(type)) return
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[data]! & ~0x10) !== 0 || bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) return
      canvas = [uint24(data + 4) + 1, uint24(data + 7) + 1]
      if (!square(...canvas)) return
      alpha = !!(bytes[data]! & 0x10)
    } else if (type === 'ALPH') {
      if (!canvas || !alpha || length < 2) return
      alphaChunk = true
    } else if (type === 'VP8 ') {
      if (length < 10 || (bytes[data]! & 1) !== 0 || ascii(bytes, data + 3, 3) !== '\u009d\u0001\u002a' || alpha && !alphaChunk) return
      frame = [view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff]
    } else {
      if (length < 5 || bytes[data] !== 0x2f || alphaChunk) return
      const dimensions = view.getUint32(data + 1, true)
      if (dimensions >>> 29) return
      frame = [(dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1]
    }
    seen.add(type); offset = end + (length % 2)
  }
  if (offset !== bytes.length || !frame || !square(...frame) || canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1])) return
  return frame
}

/** Creates a bounded inline image. URLs, animation, EXIF/XMP and arbitrary
 * ancillary chunks have no representation in this logo format. */
export function createLogoImage(bytes: Uint8Array, mime: LogoImage['mime']): LogoImage {
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES) throw new Error('Logo image exceeds the 16 KiB limit')
  const size = mime === 'image/png' ? pngSize(bytes) : mime === 'image/webp' ? webpSize(bytes) : undefined
  if (!size) throw new Error('Use a small square PNG or WebP logo without animation or embedded metadata')
  return { v: 1, mime, width: size[0], height: size[1], data: base64.encode(bytes), sha256: bytesToHex(sha256(bytes)) }
}

export function readLogoImage(value: unknown): LogoImage | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const logo = value as Record<string, unknown>
    if (Object.keys(logo).some(key => !['v', 'mime', 'width', 'height', 'data', 'sha256'].includes(key)) || logo.v !== 1 ||
        logo.mime !== 'image/png' && logo.mime !== 'image/webp' || typeof logo.data !== 'string' || logo.data.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 ||
        typeof logo.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(logo.sha256)) return
    const bytes = base64.decode(logo.data)
    if (base64.encode(bytes) !== logo.data) return
    const checked = createLogoImage(bytes, logo.mime)
    return checked.sha256 === logo.sha256 && checked.width === logo.width && checked.height === logo.height ? checked : undefined
  } catch { return }
}

/** Only a validated inline source reaches the renderer; no remote URL is
 * accepted, even when a cache or signed sender supplied it. */
export function logoDataUrl(value: unknown): string | undefined {
  const logo = readLogoImage(value)
  return logo ? `data:${logo.mime};base64,${logo.data}` : undefined
}

/** Use only after decoding locally and drawing onto a fresh sRGB canvas.
 * Browser WebP encoders can add an ICC profile even to that fresh canvas.
 * Strip ancillary chunks before packaging; recipients never run this repair
 * on an untrusted signed image, which must already satisfy readLogoImage. */
export function logoFromCanvasEncoding(bytes: Uint8Array, mime: LogoImage['mime']): LogoImage {
  if (mime === 'image/png') return createLogoImage(bytes, mime)
  if (bytes.length > 512 * 1024 || bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new Error('Invalid canvas logo encoding')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Invalid canvas logo encoding')
  const chunks: Uint8Array[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4), length = view.getUint32(offset + 4, true), end = offset + 8 + length + length % 2
    if (end > bytes.length || type === 'ANIM' || type === 'ANMF') throw new Error('Use a still logo image')
    if (['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(type)) {
      const chunk = bytes.slice(offset, end)
      if (type === 'VP8X') {
        if (length !== 10 || chunk[8]! & 2) throw new Error('Use a still logo image')
        chunk[8] = chunk[8]! & 0x10
      }
      chunks.push(chunk)
    }
    offset = end
  }
  if (offset !== bytes.length) throw new Error('Invalid canvas logo encoding')
  const cleaned = new Uint8Array(12 + chunks.reduce((total, chunk) => total + chunk.length, 0))
  cleaned.set(bytes.subarray(0, 12))
  new DataView(cleaned.buffer).setUint32(4, cleaned.length - 8, true)
  offset = 12
  for (const chunk of chunks) { cleaned.set(chunk, offset); offset += chunk.length }
  return createLogoImage(cleaned, mime)
}
