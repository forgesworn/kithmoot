import { describe, it, expect } from 'vitest'
import { mintTurnCredential } from './turn.js'

describe('mintTurnCredential', () => {
  it('matches a known vector for HMAC-SHA1 over the coturn REST scheme', () => {
    // Computed independently with Node's crypto module:
    //   crypto.createHmac('sha1', 'my-shared-secret')
    //     .update('1735776000:kithmoot').digest('base64')
    //   -> '6ALV1ws8NhxOgTy3BzMBan5OyVQ='
    // now=1735689600 (2025-01-01T00:00:00Z) + ttl=86400 -> expiry 1735776000
    const result = mintTurnCredential('my-shared-secret', 86400, 1_735_689_600)
    expect(result).toEqual({
      username: '1735776000:kithmoot',
      credential: '6ALV1ws8NhxOgTy3BzMBan5OyVQ=',
    })
  })

  it('encodes the expiry as now + ttl, not ttl alone', () => {
    const result = mintTurnCredential('secret', 3600, 1_000_000_000)
    expect(result.username).toBe('1000003600:kithmoot')
  })

  it('accepts a custom name in place of the default', () => {
    const result = mintTurnCredential('secret', 60, 100, 'alice-device-1')
    expect(result.username).toBe('160:alice-device-1')
  })

  it('floors fractional seconds so expiry is always a whole unix second', () => {
    const result = mintTurnCredential('secret', 60.7, 100.4)
    expect(result.username).toBe('160:kithmoot')
  })

  it('produces a different credential for a different secret', () => {
    const a = mintTurnCredential('secret-a', 60, 100)
    const b = mintTurnCredential('secret-b', 60, 100)
    expect(a.credential).not.toBe(b.credential)
  })

  it('produces a base64 string, not base64url', () => {
    // Distinguishing input chosen so the HMAC output contains a byte whose
    // base64 encoding differs between the standard and URL-safe alphabets
    // (+ or / rather than - or _) - otherwise this test could pass by
    // accident with either encoder.
    let found = false
    for (let i = 0; i < 50 && !found; i++) {
      const { credential } = mintTurnCredential('secret', 60, 100, `probe-${i}`)
      if (/[+/]/.test(credential)) found = true
    }
    expect(found).toBe(true)
  })
})
