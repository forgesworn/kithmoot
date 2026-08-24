import { describe, it, expect } from 'vitest'
import { hexEquals } from './hex.js'

describe('hexEquals', () => {
  it('treats identical lower-case hex as equal', () => {
    expect(hexEquals('deadbeef', 'deadbeef')).toBe(true)
  })

  it('treats the same value in upper- and lower-case hex as equal', () => {
    expect(hexEquals('DEADBEEF', 'deadbeef')).toBe(true)
    expect(hexEquals('deadbeef', 'DEADBEEF')).toBe(true)
  })

  it('treats mixed-case hex as equal to either canonical case', () => {
    expect(hexEquals('DeAdBeEf', 'deadbeef')).toBe(true)
  })

  it('rejects genuinely different values regardless of case', () => {
    expect(hexEquals('deadbeef', 'deadbee0')).toBe(false)
    expect(hexEquals('DEADBEEF', 'deadbee0')).toBe(false)
  })
})
