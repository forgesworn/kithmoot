import { describe, it, expect } from 'vitest'
import { memoryDeviceStore, type DeviceStore } from './device-store.js'
import { VOLUME_PREFIX, loadVolumeLevel, storeVolumeLevel, volumeLevelCount } from './volume-store.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

describe('remembered volume levels', () => {
  it('has nothing to say about a participant nobody has touched', () => {
    const store = memoryDeviceStore()
    expect(loadVolumeLevel(store, ADA)).toBeUndefined()
    expect(volumeLevelCount(store)).toBe(0)
  })

  it('remembers a level and reads it back', () => {
    const store = memoryDeviceStore()
    storeVolumeLevel(store, ADA, 0.5)
    expect(loadVolumeLevel(store, ADA)).toBe(0.5)
    expect(store.keys()).toEqual([VOLUME_PREFIX + ADA])
  })

  it('does not store the untouched default, and clears a level put back to it', () => {
    const store = memoryDeviceStore()
    storeVolumeLevel(store, ADA, 1)
    expect(store.keys()).toEqual([])
    storeVolumeLevel(store, ADA, 1.5)
    expect(store.keys()).toHaveLength(1)
    storeVolumeLevel(store, ADA, 1)
    expect(store.keys()).toEqual([])
  })

  it('keeps one participant’s level separate from another’s', () => {
    const store = memoryDeviceStore()
    storeVolumeLevel(store, ADA, 0)
    storeVolumeLevel(store, BOB, 2)
    expect(loadVolumeLevel(store, ADA)).toBe(0)
    expect(loadVolumeLevel(store, BOB)).toBe(2)
    expect(volumeLevelCount(store)).toBe(2)
  })

  it('refuses a level outside the slider range and a malformed record', () => {
    const store = memoryDeviceStore()
    store.set(VOLUME_PREFIX + ADA, JSON.stringify({ level: 9 }))
    expect(loadVolumeLevel(store, ADA)).toBeUndefined()
    store.set(VOLUME_PREFIX + ADA, 'not json')
    expect(loadVolumeLevel(store, ADA)).toBeUndefined()
  })

  it('refuses a key that is not a participant pubkey', () => {
    const store = memoryDeviceStore()
    storeVolumeLevel(store, 'short', 0.5)
    expect(store.keys()).toEqual([])
    expect(loadVolumeLevel(store, 'short')).toBeUndefined()
  })

  it('a store that throws loses only the memory of the setting, never the call', () => {
    const angry: DeviceStore = {
      get: () => {
        throw new Error('storage disabled')
      },
      set: () => {
        throw new Error('storage disabled')
      },
      remove: () => {
        throw new Error('storage disabled')
      },
      keys: () => {
        throw new Error('storage disabled')
      },
    }
    expect(loadVolumeLevel(angry, ADA)).toBeUndefined()
    expect(() => storeVolumeLevel(angry, ADA, 1.5)).not.toThrow()
    expect(volumeLevelCount(angry)).toBe(0)
  })
})
