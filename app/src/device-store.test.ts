import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  DEVICE_KEY_MAX_AGE_SECONDS,
  deviceKeyFor,
  forgetCredentialFor,
  forgetLegacyStorage,
  isPairedSecondary,
  loadCredentialFor,
  memoryDeviceStore,
  storeCredentialFor,
} from './device-store.js'
import type { DeviceCredential } from '../../src/types.js'

const NOW = 1_800_000_000
const ROOM_A = 'a'.repeat(64)
const ROOM_B = 'b'.repeat(64)

/** Shaped like a credential; nothing here verifies it, so nothing here signs it. */
function credential(device: string): DeviceCredential {
  return { kind: 20460, pubkey: 'p'.repeat(64), created_at: NOW, tags: [['d', device]], content: '', id: 'i'.repeat(64), sig: 's'.repeat(128) } as unknown as DeviceCredential
}

describe('per-room device keys', () => {
  // A relay learns every device pubkey in a room from the roster events it
  // carries. One device key for every room a browser ever joins lets that
  // relay link one person across all of them: a different key per room is
  // what stops a relay drawing that line, at no cost to the protocol, since
  // a credential is already minted per room.
  it('mints a different device key for every room', () => {
    const store = memoryDeviceStore()
    const a = deviceKeyFor(store, ROOM_A, NOW, generateSecretKey)
    const b = deviceKeyFor(store, ROOM_B, NOW, generateSecretKey)
    expect(getPublicKey(a)).not.toBe(getPublicKey(b))
  })

  it('hands the same room the same key next time, so a credential issued for it still names us', () => {
    const store = memoryDeviceStore()
    const first = deviceKeyFor(store, ROOM_A, NOW, generateSecretKey)
    const again = deviceKeyFor(store, ROOM_A, NOW + 3600, generateSecretKey)
    expect(getPublicKey(again)).toBe(getPublicKey(first))
  })

  it('forgets a room key that has not been used for a month, and keeps one that has', () => {
    const store = memoryDeviceStore()
    const old = deviceKeyFor(store, ROOM_A, NOW, generateSecretKey)
    deviceKeyFor(store, ROOM_B, NOW, generateSecretKey)
    // Room B is used again just before the month is up; room A is not.
    const later = NOW + DEVICE_KEY_MAX_AGE_SECONDS - 1
    const b = deviceKeyFor(store, ROOM_B, later, generateSecretKey)
    const muchLater = NOW + DEVICE_KEY_MAX_AGE_SECONDS + 1
    const bStill = deviceKeyFor(store, ROOM_B, muchLater, generateSecretKey)
    const aFresh = deviceKeyFor(store, ROOM_A, muchLater, generateSecretKey)
    expect(getPublicKey(bStill)).toBe(getPublicKey(b))
    expect(getPublicKey(aFresh)).not.toBe(getPublicKey(old))
  })

  it('keeps credentials per room too, so one room pairing cannot be handed to another', () => {
    const store = memoryDeviceStore()
    storeCredentialFor(store, ROOM_A, credential('device-a'))
    expect(loadCredentialFor(store, ROOM_A)?.tags).toEqual([['d', 'device-a']])
    expect(loadCredentialFor(store, ROOM_B)).toBeUndefined()
    forgetCredentialFor(store, ROOM_A)
    expect(loadCredentialFor(store, ROOM_A)).toBeUndefined()
  })

  it('treats a browser holding any room credential as somebody else’s secondary device', () => {
    // A secondary must never mint a participant key of its own, or it turns
    // back into a separate person the moment the credential lapses.
    const store = memoryDeviceStore()
    expect(isPairedSecondary(store)).toBe(false)
    storeCredentialFor(store, ROOM_B, credential('device-b'))
    expect(isPairedSecondary(store)).toBe(true)
  })

  it('drops the single shared device key and credential this replaces', () => {
    const store = memoryDeviceStore()
    store.set('kithmoot.device', 'deadbeef')
    store.set('kithmoot.credential', '{}')
    store.set('kithmoot.name', 'Ada')
    forgetLegacyStorage(store)
    expect(store.get('kithmoot.device')).toBeNull()
    expect(store.get('kithmoot.credential')).toBeNull()
    expect(store.get('kithmoot.name')).toBe('Ada')
  })

  it('does not choke on a stored value somebody else wrote', () => {
    const store = memoryDeviceStore()
    store.set('kithmoot.device.' + ROOM_A, 'not json')
    store.set('kithmoot.credential.' + ROOM_B, '{not json')
    expect(() => deviceKeyFor(store, ROOM_A, NOW, generateSecretKey)).not.toThrow()
    expect(loadCredentialFor(store, ROOM_B)).toBeUndefined()
  })
})
