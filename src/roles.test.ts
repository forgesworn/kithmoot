import { describe, it, expect } from 'vitest'
import { resolveSingularRoles } from './roles.js'
import type { RosterEntry } from './types.js'

function entry(participant: string, device: string, claims: RosterEntry['claims']): RosterEntry {
  return {
    participant,
    device,
    credential: {} as RosterEntry['credential'],
    tracks: [],
    claims,
    updatedAt: 0,
  }
}

describe('resolveSingularRoles', () => {
  it('gives the role to the only claimant', () => {
    const result = resolveSingularRoles([entry('alice', 'phone', { mic: 100 })])
    expect(result.get('alice')?.mic).toBe('phone')
  })

  it('gives the mic to the most recent claim, so handover works', () => {
    const result = resolveSingularRoles([
      entry('alice', 'phone', { mic: 100 }),
      entry('alice', 'laptop', { mic: 200 }),
    ])
    expect(result.get('alice')?.mic).toBe('laptop')
  })

  it('breaks a tie deterministically by device pubkey', () => {
    const a = resolveSingularRoles([
      entry('alice', 'aaa', { mic: 100 }),
      entry('alice', 'bbb', { mic: 100 }),
    ])
    const b = resolveSingularRoles([
      entry('alice', 'bbb', { mic: 100 }),
      entry('alice', 'aaa', { mic: 100 }),
    ])
    expect(a.get('alice')?.mic).toBe(b.get('alice')?.mic)
    expect(a.get('alice')?.mic).toBe('aaa')
  })

  it('BUG: a tie must be broken the same way regardless of which case a device pubkey happens to arrive in', () => {
    // Two of the same participant's devices, tied on claim time. Both
    // platforms must pick the same one - two live mics is feedback, none is
    // silence - but nothing on the wire forces every device pubkey to be
    // lower case, and the tiebreak is `<`, which `hexEquals` cannot help
    // with: it needs the same total order on both sides, not just to agree
    // when two strings name the same device.
    const deviceLower = 'b'.repeat(64)
    const deviceUpper = 'B'.repeat(64) // the same device pubkey, differently cased
    const other = 'a'.repeat(64)

    const withLowerCase = resolveSingularRoles([
      entry('alice', other, { mic: 100 }),
      entry('alice', deviceLower, { mic: 100 }),
    ])
    const withUpperCase = resolveSingularRoles([
      entry('alice', other, { mic: 100 }),
      entry('alice', deviceUpper, { mic: 100 }),
    ])

    // Whichever device wins the tie when the other device's pubkey is
    // spelled in lower case must also win it when that same pubkey is
    // spelled in upper case, so every client arrives at the same mic
    // holder rather than each platform electing a different device.
    expect(withUpperCase.get('alice')?.mic).toBe(withLowerCase.get('alice')?.mic)
  })

  it('resolves mic and monitor independently', () => {
    const result = resolveSingularRoles([
      entry('alice', 'phone', { mic: 200, monitor: 100 }),
      entry('alice', 'laptop', { mic: 100, monitor: 200 }),
    ])
    expect(result.get('alice')?.mic).toBe('phone')
    expect(result.get('alice')?.monitor).toBe('laptop')
  })

  it('keeps participants independent of one another', () => {
    const result = resolveSingularRoles([
      entry('alice', 'phone', { mic: 100 }),
      entry('bob', 'laptop', { mic: 500 }),
    ])
    expect(result.get('alice')?.mic).toBe('phone')
    expect(result.get('bob')?.mic).toBe('laptop')
  })

  it('omits a role nobody claims', () => {
    const result = resolveSingularRoles([entry('alice', 'phone', {})])
    expect(result.get('alice')?.mic).toBeUndefined()
  })

  it('returns an empty map for an empty roster', () => {
    expect(resolveSingularRoles([]).size).toBe(0)
  })
})
