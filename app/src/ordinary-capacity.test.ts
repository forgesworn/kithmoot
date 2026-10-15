import { describe, it, expect } from 'vitest'
import { largeContextJournal } from '../../test/ordinary-capacity-fixture.js'
import { encodeOrdinaryImage, decodeOrdinaryImage, ordinaryUtf8Length, ORDINARY_VALUE_BYTES } from './ordinary-state-codec.js'

describe('actual encrypted writer capacity', () => {
  it('retains a real >2 MiB context journal and its duplicate sealed source byte-exactly', async () => {
    const fixture = await largeContextJournal()
    expect(ordinaryUtf8Length(fixture.raw)).toBeGreaterThan(2 * 1024 * 1024)
    expect(ordinaryUtf8Length(fixture.raw)).toBeLessThan(ORDINARY_VALUE_BYTES)
    expect(JSON.parse(fixture.raw).collections).toHaveLength(25)
    expect(fixture.raw).not.toContain('Private collection')
    const image = { purpose: 'browser' as const, keyId: '1'.repeat(64), generation: '2'.repeat(64), revision: 0,
      expiresAt: 0, records: fixture.records, fences: new Map<string, number>(),
      migration: { phase: 'sealed' as const, sources: fixture.records, names: [...fixture.records.keys()] } }
    const encoded = encodeOrdinaryImage(image)
    try {
      const restored = decodeOrdinaryImage(encoded)
      expect(restored.records).toEqual(fixture.records)
      expect(restored.migration!.sources).toEqual(fixture.records)
    } finally { encoded.fill(0) }
  }, 30_000)
})
