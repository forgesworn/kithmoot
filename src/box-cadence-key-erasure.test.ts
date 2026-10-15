import { expect, it, vi } from 'vitest'
import * as drops from 'nostr-deaddrop'
import { getPublicKey } from 'nostr-tools/pure'
import { deriveCadenceDropPublicKeys } from './box-cadence.js'

// Preserve real derivation but expose a configurable wrapper for observing
// the actual mutable scalar buffers, rather than replacing the cryptography.
vi.mock('nostr-deaddrop', async importOriginal => {
  const actual = await importOriginal<typeof import('nostr-deaddrop')>()
  return { ...actual, deriveRoomDropKey: (...args: Parameters<typeof actual.deriveRoomDropKey>) => actual.deriveRoomDropKey(...args) }
})

it('wipes the actual private drop-key buffers after exposing only their public keys', () => {
  const derive = drops.deriveRoomDropKey, retained: Uint8Array[] = []
  const spy = vi.spyOn(drops, 'deriveRoomDropKey').mockImplementation((...args) => {
    const key = derive(...args); retained.push(key.privateKey); return key
  })
  try {
    const result = deriveCadenceDropPublicKeys(new Uint8Array(32).fill(9), getPublicKey(new Uint8Array(32).fill(4)), 500002, 500004, 0)
    expect(result).toHaveLength(16); expect(new Set(result.map(key => key.pubkey)).size).toBe(16)
    expect(retained).toHaveLength(16); expect(retained.every(key => key.every(byte => byte === 0))).toBe(true)
    expect(result.every(key => Object.keys(key).sort().join(',') === 'counter,epoch,pubkey')).toBe(true)
  } finally { spy.mockRestore() }
})
