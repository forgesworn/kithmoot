import { describe, expect, it } from 'vitest'
import vectors from '../vectors/box-discovery.json'
import { readBoxClaim, readBoxStatus } from './box-status.js'

describe('signed discovery interoperability vectors', () => {
  it.each(vectors.cases)('$name', c => {
    const result = readBoxStatus(c.status, c.claim, c.pin, c.now)
    expect(result.ok).toBe(c.expect.ok)
    if (result.ok) expect({ drops: result.status.drops, dropsUrl: result.status.dropsUrl ?? null, validUntil: result.status.validUntil }).toEqual({ drops: c.expect.drops, dropsUrl: c.expect.dropsUrl, validUntil: c.expect.validUntil })
  })
  it.each(vectors.claims)('claim: $name', c => {
    expect(readBoxClaim(c.event, c.now).ok).toBe(c.expect.ok)
  })
})
