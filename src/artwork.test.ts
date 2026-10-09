import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { artworkFallbackText, normaliseArtwork, normaliseOutgoingArtwork } from './artwork.js'
import { decodeChatEvent } from './chat.js'

const artwork = { pack: 'kithmoot-original-v1', id: 'coffee', kind: 'gif' as const, sha256: 'ab'.repeat(32), label: 'Coffee' }

describe('bundled artwork references', () => {
  it('uses the shared cross-client normalisation vectors', () => {
    const vectors = JSON.parse(readFileSync(new URL('../vectors/artwork-references.json', import.meta.url), 'utf8'))
    for (const vector of vectors.normalisation) expect(normaliseArtwork(vector.input), vector.name).toEqual(vector.expected)
  })
  it('decodes the shared signed encrypted message vector', () => {
    const { encryptedMessage: v } = JSON.parse(readFileSync(new URL('../vectors/artwork-references.json', import.meta.url), 'utf8'))
    const roomKey = new Uint8Array(Buffer.from(v.roomKey, 'hex'))
    expect(decodeChatEvent(v.event, { roomId: v.roomId, roomKey, now: v.now })).toEqual(v.message)
  })
  it('keeps unknown catalogues as references, without accepting a URL as an identifier', () => {
    expect(normaliseArtwork({ ...artwork, pack: 'future-pack-v2' })).toEqual({ ...artwork, pack: 'future-pack-v2' })
    expect(normaliseArtwork({ ...artwork, id: 'https://tracker.example/image' })).toBeNull()
  })
  it('refuses malformed or excessive outbound artwork rather than silently dropping it', () => {
    expect(normaliseOutgoingArtwork([])).toBeUndefined()
    expect(() => normaliseOutgoingArtwork({})).toThrow(/list/)
    expect(() => normaliseOutgoingArtwork([{ ...artwork, kind: 'image' }])).toThrow(/catalogue reference/)
    expect(() => normaliseOutgoingArtwork(Array(5).fill(artwork))).toThrow(/at most 4/)
  })
  it('provides readable fallback captions for clients with no matching artwork', () => {
    expect(artworkFallbackText([artwork, { ...artwork, kind: 'sticker', label: 'Donkey' }])).toBe('GIF: Coffee; Sticker: Donkey')
  })
})
