import { describe, expect, it } from 'vitest'
import { DIAL_LEASE_MS, RelayDialGate, type RelayDialLease } from './relay-dial-gate.js'

describe('owned relay dial reservations', () => {
  it('a healthy-URL receipt cannot release a later failing reservation', () => {
    let now = 0; const gate = new RelayDialGate(() => now), old = gate.reserve('relay')!
    gate.failed('relay'); now = 1000
    const current = gate.reserve('relay')!
    expect(gate.release(old)).toBe(false); expect(gate.open('relay')).toBe(false)
    expect(gate.release(current)).toBe(true); expect(gate.open('relay')).toBe(true)
  })
  it('expired and consumed receipts cannot release another pool’s later lease', () => {
    let now = 0; const gate = new RelayDialGate(() => now)
    gate.failed('relay'); now = 1000
    const first = gate.reserve('relay')!
    now += DIAL_LEASE_MS
    const second = gate.reserve('relay')!
    expect(gate.release(first)).toBe(false); expect(gate.open('relay')).toBe(false)
    expect(gate.release(second)).toBe(true)
    const third = gate.reserve('relay')!
    expect(gate.release(second)).toBe(false); expect(gate.open('relay')).toBe(false)
    expect(gate.release(third)).toBe(true)
  })
  it('late failure records backoff without releasing a newer reservation', () => {
    let now = 0; const gate = new RelayDialGate(() => now)
    gate.failed('relay'); now = 1000
    const first = gate.reserve('relay')!; now += DIAL_LEASE_MS
    const second = gate.reserve('relay')!
    gate.failedDial('relay', first)
    expect(gate.release(second)).toBe(true)
    expect(gate.retryAt('relay')).toBeGreaterThan(now)
  })
  it('forged and wrong-destination receipts cannot release a lease', () => {
    let now = 0; const gate = new RelayDialGate(() => now)
    gate.failed('relay'); now = 1000
    const held = gate.reserve('relay')!
    expect(gate.release(Object.freeze({}) as RelayDialLease)).toBe(false)
    gate.failedDial('different', held)
    expect(gate.open('relay')).toBe(false); expect(gate.release(held)).toBe(true)
  })
})
