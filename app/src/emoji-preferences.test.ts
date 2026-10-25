import { afterEach, describe, expect, it, vi } from 'vitest'
import { preferredReaction, preferredSkinTone, setPreferredSkinTone } from './emoji-preferences.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('emoji preferences', () => {
  it('retains the selected hand colour and applies it to quick reactions', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
    expect(preferredSkinTone()).toBe(0)
    setPreferredSkinTone(3)
    expect(preferredSkinTone()).toBe(3)
    expect(preferredReaction('👍')).toBe('👍🏽')
    expect(preferredReaction('❤️')).toBe('❤️')
  })

  it('rejects invalid choices and tolerates unavailable or malformed storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'not-a-tone', setItem: () => { throw new Error('denied') } })
    expect(preferredSkinTone()).toBe(0)
    expect(() => setPreferredSkinTone(3)).not.toThrow()
    expect(() => setPreferredSkinTone(-1)).toThrow(RangeError)
    expect(() => setPreferredSkinTone(1.5)).toThrow(RangeError)
  })
})
