import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { sanitiseSpryKey, spryDeviceKey, spryDevicePublicKey } from './spry-key.js'
import { spryDeviceKey as fromClient } from './spry.js'

describe('spry device key', () => {
  const deviceSk = new Uint8Array(32).fill(1)
  it('is the public half of the key SpryRoom signs with', () => {
    expect(fromClient(deviceSk)).toBe(spryDeviceKey(deviceSk))
    expect(spryDevicePublicKey(deviceSk)).toBe(getPublicKey(hexToBytes(spryDeviceKey(deviceSk))))
    expect(spryDevicePublicKey(deviceSk)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('differs per room device key', () => {
    expect(spryDevicePublicKey(new Uint8Array(32).fill(2))).not.toBe(spryDevicePublicKey(deviceSk))
  })
  it('accepts curve points only, lower-cased', () => {
    const key = spryDevicePublicKey(deviceSk)
    expect(sanitiseSpryKey(key.toUpperCase())).toBe(key)
    for (const bad of ['f'.repeat(64), '0'.repeat(64), key.slice(1), key + '0', 'z'.repeat(64), 1, undefined, null]) expect(sanitiseSpryKey(bad)).toBeUndefined()
  })
})
