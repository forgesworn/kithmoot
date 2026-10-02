/**
 * Test support: a canonical encoder for the seven-key unsigned
 * `leaf-binding/1` body, the inverse of `src/vmls/binding.ts`. It builds the
 * requests the MLS device vault tests sign. The engine makes these in
 * production; nothing outside tests encodes them.
 */
import { hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js'
import type { Event } from 'nostr-tools/pure'

function head(major: number, value: number | bigint): Uint8Array {
  const v = BigInt(value)
  const m = major << 5
  if (v < 24n) return Uint8Array.of(m | Number(v))
  for (const [info, width] of [[24, 1], [25, 2], [26, 4], [27, 8]] as const) {
    if (v < 1n << BigInt(8 * width)) {
      const out = new Uint8Array(1 + width)
      out[0] = m | info
      for (let i = 0; i < width; i++) out[width - i] = Number((v >> BigInt(8 * i)) & 0xffn)
      return out
    }
  }
  throw new Error('too large')
}
const uint = (v: number | bigint): Uint8Array => head(0, v)
const bytes = (b: Uint8Array): Uint8Array => concatBytes(head(2, b.length), b)
const text = (s: string): Uint8Array => { const b = utf8ToBytes(s); return concatBytes(head(3, b.length), b) }

export interface UnsignedFields {
  leafId: Uint8Array
  signatureKey: Uint8Array
  credential: Pick<Event, 'pubkey' | 'created_at' | 'tags' | 'content' | 'sig'>
  device: string
  expiresAt: number
  homeBox: Uint8Array
  version?: number
}

export function encodeUnsignedBinding(f: UnsignedFields): Uint8Array {
  const c = f.credential
  const tags = concatBytes(head(4, c.tags.length), ...c.tags.map(tag => concatBytes(head(4, tag.length), ...tag.map(text))))
  const credential = concatBytes(
    head(5, 5),
    uint(1), bytes(hexToBytes(c.pubkey)),
    uint(2), uint(c.created_at),
    uint(3), tags,
    uint(4), text(c.content),
    uint(5), bytes(hexToBytes(c.sig)),
  )
  return concatBytes(
    head(5, 7),
    uint(1), uint(f.version ?? 1),
    uint(2), bytes(concatBytes(utf8ToBytes('vmls1'), f.leafId)),
    uint(3), bytes(f.signatureKey),
    uint(4), credential,
    uint(5), bytes(hexToBytes(f.device)),
    uint(6), uint(f.expiresAt),
    uint(7), bytes(f.homeBox),
  )
}
