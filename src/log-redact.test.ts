import { describe, it, expect } from 'vitest'
import { shortId } from './log-redact.js'

describe('shortId', () => {
  it('keeps the first 8 hex characters of a 64-hex identifier', () => {
    const roomId = 'a62a46044cacdb62f2b77e9457d550'.padEnd(64, '0')
    expect(shortId(roomId)).toBe(roomId.slice(0, 8))
    expect(shortId(roomId)).toHaveLength(8)
  })

  it('never returns more than it was given', () => {
    expect(shortId('abcd')).toBe('abcd')
    expect(shortId('')).toBe('')
  })
})
