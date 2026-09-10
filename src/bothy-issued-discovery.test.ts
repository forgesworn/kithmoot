import { describe, expect, it } from 'vitest'
import vectors from '../vectors/bothy-issued-discovery.json'
import { readBoxStatus } from './box-status.js'

describe('Bothy production-code discovery interoperability', () => {
  it.each(vectors.cases)('$name', c => {
    // Bothy separates valid signed data from freshness. A stale envelope
    // may be retained there, but cannot grant a current client lane label.
    expect(c.bothy.accepted && !c.bothy.stale).toBe(c.expect.ok)
    const result = readBoxStatus(c.status, c.claim, c.pin, c.now)
    expect(result.ok).toBe(c.expect.ok)
    if (result.ok) expect({ drops: result.status.drops, dropsUrl: result.status.dropsUrl ?? null, validUntil: result.status.validUntil })
      .toEqual({ drops: c.expect.drops, dropsUrl: c.expect.dropsUrl, validUntil: c.expect.validUntil })
  })
})
