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
