import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'

export interface CompressedFrame {
  kind: 'video' | 'audio'
  type: 'key' | 'delta'
  timestampUs: number
  durationUs: number
  data: Uint8Array
}

// Independently generated opaque publication IDs reveal neither a room name
// nor its key. The room's authenticated control path supplies these bindings.
export interface Publication { id: string; sender: string }
export const MAX_FRAME_BYTES = 512 * 1024
export const DATAGRAM_BYTES = 12 * 1024
export const HEADER_BYTES = 54
const CHUNK_BYTES = DATAGRAM_BYTES - HEADER_BYTES
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const MAGIC = [75, 82, 70, 49]
const LIMIT = 0xffff_ffff

function hex(bytes: Uint8Array): string { return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('') }
function unhex(text: string): Uint8Array { return Uint8Array.from(text.match(/../g)!, n => parseInt(n, 16)) }
export function newPublication(sender: string): Publication {
  if (!HEX64.test(sender)) throw new Error('Invalid publication sender')
  return { id: hex(crypto.getRandomValues(new Uint8Array(16))), sender }
}

export function publicationKey(roomKey: Uint8Array, publication: Publication): Uint8Array {
  if (roomKey.length !== 32 || !HEX32.test(publication.id) || !HEX64.test(publication.sender)) throw new Error('Invalid publication binding')
  return hkdf(sha256, roomKey, undefined, `kithmoot/realtime/v1/${publication.sender}/${publication.id}`, 32)
}

export interface DatagramHeader {
  publication: string; sequence: number; kind: 'video' | 'audio'; key: boolean
  timestampUs: number; durationUs: number; totalBytes: number; index: number; count: number
}

/** Only bounded public metadata is inspected by a forwarder. */
export function inspectDatagram(bytes: Uint8Array): DatagramHeader | null {
  if (bytes.length <= HEADER_BYTES || bytes.length > DATAGRAM_BYTES || MAGIC.some((v, i) => bytes[i] !== v)) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sequence = v.getUint32(28), kind = bytes[32], flag = bytes[33]
  const index = v.getUint16(34), count = v.getUint16(36), timestampUs = v.getFloat64(38)
  const durationUs = v.getUint32(46), totalBytes = v.getUint32(50)
  if (![1, 2].includes(kind!) || flag! > 1 || !Number.isSafeInteger(timestampUs) || timestampUs < 0
    || totalBytes < 17 || totalBytes > MAX_FRAME_BYTES + 16 || count !== Math.ceil(totalBytes / CHUNK_BYTES)
    || index >= count || bytes.length - HEADER_BYTES !== Math.min(CHUNK_BYTES, totalBytes - index * CHUNK_BYTES)) return null
  return { publication: hex(bytes.subarray(4, 20)), sequence, kind: kind === 1 ? 'video' : 'audio', key: flag === 1,
    timestampUs, durationUs, totalBytes, index, count }
}

export class FrameSealer {
  #key: Uint8Array
  #salt = crypto.getRandomValues(new Uint8Array(8))
  #sequence = 0
  #closed = false
  constructor(readonly publication: Publication, roomKey: Uint8Array) { this.#key = publicationKey(roomKey, publication) }
  seal(frame: CompressedFrame): { sequence: number; packet: Uint8Array } {
    if (this.#closed || this.#sequence > LIMIT || !['video', 'audio'].includes(frame.kind) || !['key', 'delta'].includes(frame.type)
      || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0 || !Number.isSafeInteger(frame.durationUs)
      || frame.durationUs < 0 || frame.durationUs > LIMIT || frame.data.length === 0 || frame.data.length > MAX_FRAME_BYTES) throw new Error('Invalid realtime frame')
    const header = new Uint8Array(HEADER_BYTES), view = new DataView(header.buffer)
    header.set(MAGIC); header.set(unhex(this.publication.id), 4); header.set(this.#salt, 20)
    const sequence = this.#sequence++
    view.setUint32(28, sequence); header[32] = frame.kind === 'video' ? 1 : 2; header[33] = frame.type === 'key' ? 1 : 0
    const length = frame.data.length + 16, count = Math.ceil(length / CHUNK_BYTES)
    view.setUint16(36, count); view.setFloat64(38, frame.timestampUs); view.setUint32(46, frame.durationUs); view.setUint32(50, length)
    const nonce = header.slice(20, 32)
    const ciphertext = chacha20poly1305(this.#key, nonce, header).encrypt(frame.data)
    const packet = new Uint8Array(HEADER_BYTES + ciphertext.length); packet.set(header); packet.set(ciphertext, HEADER_BYTES)
    return { sequence, packet }
  }
  close(): void { this.#closed = true; this.#key.fill(0); this.#salt.fill(0) }
}

export function fragmentPacket(packet: Uint8Array): Uint8Array[] {
  const length = packet.length - HEADER_BYTES
  if (length < 17 || length > MAX_FRAME_BYTES + 16) throw new Error('Invalid encrypted frame')
  return Array.from({ length: Math.ceil(length / CHUNK_BYTES) }, (_, i) => {
    const data = new Uint8Array(HEADER_BYTES + Math.min(CHUNK_BYTES, length - i * CHUNK_BYTES))
    data.set(packet.subarray(0, HEADER_BYTES)); new DataView(data.buffer).setUint16(34, i)
    data.set(packet.subarray(HEADER_BYTES + i * CHUNK_BYTES, HEADER_BYTES + (i + 1) * CHUNK_BYTES), HEADER_BYTES)
    return data
  })
}

interface Assembly { header: Uint8Array; meta: DatagramHeader; chunks: Map<number, Uint8Array>; expires: number }

/** Bounded reassembly and authenticated replay checks at a participant only. */
export class FrameOpener {
  #key: Uint8Array
  #assemblies = new Map<string, Assembly>()
  #bytes = 0
  #highest = -1
  #seen = new Set<number>()
  #salt: string | null = null
  #closed = false
  constructor(readonly publication: Publication, roomKey: Uint8Array, readonly now = () => performance.now()) {
    this.#key = publicationKey(roomKey, publication)
  }
  tick(): void {
    const now = this.now()
    for (const [id, a] of this.#assemblies) if (now >= a.expires) this.#forget(id, a)
  }
  #forget(id: string, a: Assembly): void { this.#assemblies.delete(id); this.#bytes -= a.meta.totalBytes }
  push(bytes: Uint8Array): (CompressedFrame & { sequence: number }) | null {
    this.tick()
    if (this.#closed) return null
    const meta = inspectDatagram(bytes)
    if (!meta || meta.publication !== this.publication.id || meta.sequence <= this.#highest - 64 || this.#seen.has(meta.sequence)) return null
    const salt = hex(bytes.subarray(20, 28))
    if (this.#salt !== null && this.#salt !== salt) return null
    const id = `${salt}/${meta.sequence}`
    let a = this.#assemblies.get(id)
    const canonical = bytes.slice(0, HEADER_BYTES); canonical[34] = 0; canonical[35] = 0
    if (!a) {
      if (this.#assemblies.size >= 8 || this.#bytes + meta.totalBytes > 2 * MAX_FRAME_BYTES) return null
      a = { header: canonical, meta, chunks: new Map(), expires: this.now() + (meta.kind === 'audio' ? 120 : 500) }
      this.#assemblies.set(id, a); this.#bytes += meta.totalBytes
    } else if (canonical.some((v, i) => a!.header[i] !== v)) return null
    if (a.chunks.has(meta.index)) return null
    a.chunks.set(meta.index, bytes.slice(HEADER_BYTES))
    if (a.chunks.size !== meta.count) return null
    const ciphertext = new Uint8Array(meta.totalBytes)
    for (let i = 0; i < meta.count; i++) ciphertext.set(a.chunks.get(i)!, i * CHUNK_BYTES)
    this.#forget(id, a)
    let data: Uint8Array
    try { data = chacha20poly1305(this.#key, canonical.slice(20, 32), canonical).decrypt(ciphertext) } catch { return null }
    this.#salt = salt; this.#highest = Math.max(this.#highest, meta.sequence); this.#seen.add(meta.sequence)
    for (const old of this.#seen) if (old <= this.#highest - 64) this.#seen.delete(old)
    return { kind: meta.kind, type: meta.key ? 'key' : 'delta', timestampUs: meta.timestampUs, durationUs: meta.durationUs, data, sequence: meta.sequence }
  }
  snapshot(): { assemblies: number; bytes: number } { return { assemblies: this.#assemblies.size, bytes: this.#bytes } }
  close(): void { this.#closed = true; this.#assemblies.clear(); this.#bytes = 0; this.#seen.clear(); this.#key.fill(0) }
}
