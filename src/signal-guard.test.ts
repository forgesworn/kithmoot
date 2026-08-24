import { describe, it, expect } from 'vitest'
import {
  SignalGuard,
  MAX_REMEMBERED_SIGNALS,
  MAX_SIGNALS_PER_WINDOW,
  RATE_WINDOW_SECONDS,
} from './signal-guard.js'

const SENDER = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

describe('SignalGuard', () => {
  it('admits an event id once and refuses every repeat', () => {
    const guard = new SignalGuard()
    expect(guard.admitEvent('id-1')).toBe(true)
    expect(guard.admitEvent('id-1')).toBe(false)
    expect(guard.admitEvent('id-2')).toBe(true)
  })

  it('forgets the oldest ids rather than growing without limit', () => {
    const guard = new SignalGuard()
    for (let i = 0; i < MAX_REMEMBERED_SIGNALS; i++) expect(guard.admitEvent(`id-${i}`)).toBe(true)
    expect(guard.size).toBe(MAX_REMEMBERED_SIGNALS)

    // One more evicts the oldest, so the id at the front is admitted again.
    expect(guard.admitEvent('id-new')).toBe(true)
    expect(guard.size).toBe(MAX_REMEMBERED_SIGNALS)
    expect(guard.admitEvent('id-0')).toBe(true)
    // The most recent are still remembered.
    expect(guard.admitEvent('id-new')).toBe(false)
  })

  it('rate-limits one sender without touching another', () => {
    const guard = new SignalGuard()
    const now = 1_000_000

    for (let i = 0; i < MAX_SIGNALS_PER_WINDOW; i++) {
      expect(guard.admitSender(SENDER, now)).toBe(true)
    }
    expect(guard.admitSender(SENDER, now)).toBe(false)
    // A flood from one device must not deafen the room to everybody else.
    expect(guard.admitSender(OTHER, now)).toBe(true)
  })

  it('gives a sender its budget back once the window has passed', () => {
    const guard = new SignalGuard()
    const now = 1_000_000
    for (let i = 0; i < MAX_SIGNALS_PER_WINDOW; i++) guard.admitSender(SENDER, now)
    expect(guard.admitSender(SENDER, now)).toBe(false)

    expect(guard.admitSender(SENDER, now + RATE_WINDOW_SECONDS)).toBe(true)
  })

  it('does not grow a sender table without limit either', () => {
    const guard = new SignalGuard()
    const now = 1_000_000
    for (let i = 0; i < 5_000; i++) guard.admitSender(`sender-${i}`, now)
    expect(guard.senderCount).toBeLessThanOrEqual(MAX_REMEMBERED_SIGNALS)
  })
})
