import { expect, it } from 'vitest'
import { spryAppLink } from './spry-pairing-prompt.js'
import { parseSpryPairingLink } from '../../src/spry.js'

it('hands the exact unclaimed pairing code to the native app in its fragment', () => {
  const hash = '#spry=' + btoa(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 100 })).replaceAll('=', '')
  const link = spryAppLink(hash)
  expect(link).toBe(`kithmoot://join${hash}`)
  expect(new URL(link).search).toBe('')
  expect(parseSpryPairingLink(new URL(link).hash)).toEqual(parseSpryPairingLink(hash))
})

it('does not hand expired or malformed codes to another app', () => {
  for (const hash of ['#not-a-pairing', '#spry=' + btoa(JSON.stringify({ v: 1, endpoint: 'https://relay.example:3744', code: 'a'.repeat(43), expiresAt: 1 })).replaceAll('=', '')]) {
    expect(() => spryAppLink(hash)).toThrow()
  }
})
