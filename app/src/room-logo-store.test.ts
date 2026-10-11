import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLogoImage } from '../../src/logo-image.js'
import { memoryDeviceStore } from './device-store.js'
import { ROOM_LOGO_PREFIX, RoomLogoCache } from './room-logo-store.js'

const room = 'ab'.repeat(32)
const image = createLogoImage(new Uint8Array(readFileSync(new URL('../../desktop/icons/kithmoot-128.png', import.meta.url))), 'image/png')
const record = { image, id: 'a'.repeat(32), at: 1_800_000_000_000, sentAt: 1_800_000_000 }

describe('accepted room logo cache', () => {
  it('keeps original epoch and explicit removal across a fresh cache without exposing mutable state', () => {
    const store = memoryDeviceStore(), cache = new RoomLogoCache(store)
    cache.keep(room, record, 2, true)
    const loaded = new RoomLogoCache(store).get(room)!
    expect(loaded).toEqual({ record, epoch: 2 })
    loaded.record.image!.data = 'mutated'
    expect(cache.get(room)?.record.image).toEqual(image)
    cache.keep(room, { ...record, image: null }, 3, true)
    expect(new RoomLogoCache(store).get(room)?.record.image).toBeNull()
    cache.forget(room)
    expect(cache.get(room)).toBeUndefined(); expect(store.keys()).toEqual([])
  })
  it('removes old durable thumbnails when the room becomes temporary and never reloads them', () => {
    const store = memoryDeviceStore(), cache = new RoomLogoCache(store)
    cache.keep(room, record, 0, true)
    cache.keep(room, record, 1, false)
    expect(store.get(ROOM_LOGO_PREFIX + room)).toBeNull()
    expect(cache.get(room)?.record.image).toEqual(image)
    expect(new RoomLogoCache(store).get(room)).toBeUndefined()
    cache.forget(room); expect(cache.get(room)).toBeUndefined()
  })
  it('rejects invalid encodings/hash/epochs and caps optional images without deleting admission', () => {
    const store = memoryDeviceStore(), cache = new RoomLogoCache(store)
    store.set('kithmoot.admission.kept', 'retain')
    cache.keep(room, { ...record, image: { ...image, data: 'https://tracker.invalid' } }, 0, true)
    expect(cache.get(room)).toBeUndefined()
    cache.keep(room, record, -1, true); expect(cache.get(room)).toBeUndefined()
    store.set(ROOM_LOGO_PREFIX + room, JSON.stringify({ epoch: 0, record: { ...record, image: { ...image, sha256: '00'.repeat(32) } } }))
    expect(new RoomLogoCache(store).get(room)).toBeUndefined()
    for (let i = 0; i < 70; i++) cache.keep(i.toString(16).padStart(64, '0'), record, 0, true)
    expect(store.keys().filter(k => k.startsWith(ROOM_LOGO_PREFIX))).toHaveLength(64)
    expect(store.get('kithmoot.admission.kept')).toBe('retain')
  })
})
