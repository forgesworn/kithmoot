import { describe, it, expect } from 'vitest'
import { DrawingNoticeGate, DEFAULT_NOTICE_RATE_LIMIT_MS } from './drawing-notice.js'

describe('DrawingNoticeGate', () => {
  it('shows the first notice from a drawer, then holds back the next until the rate limit passes', () => {
    let now = 0
    const gate = new DrawingNoticeGate({ now: () => now })
    expect(gate.shouldShow('alice')).toBe(true)
    now += DEFAULT_NOTICE_RATE_LIMIT_MS - 1
    expect(gate.shouldShow('alice')).toBe(false)
    now += 1
    expect(gate.shouldShow('alice')).toBe(true)
  })

  it('never holds back a different drawer', () => {
    let now = 0
    const gate = new DrawingNoticeGate({ now: () => now })
    expect(gate.shouldShow('alice')).toBe(true)
    expect(gate.shouldShow('bob')).toBe(true)
  })

  it('uses its own rate limit when one is given', () => {
    let now = 0
    const gate = new DrawingNoticeGate({ now: () => now, rateLimitMs: 500 })
    expect(gate.shouldShow('alice')).toBe(true)
    now += 499
    expect(gate.shouldShow('alice')).toBe(false)
    now += 1
    expect(gate.shouldShow('alice')).toBe(true)
  })
})
