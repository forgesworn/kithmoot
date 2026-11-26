import { describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { encodeRoomLink } from '../../src/link.js'
import { deriveRoom } from '../../src/room.js'
import { memoryDeviceStore } from './device-store.js'
import { forgetRoomRotation, hasRoomRotation, loadRoomRotation, ROOM_ROTATION_PREFIX, rotationHistory, storeRoomRotation, type RoomRotation } from './room-rotation-store.js'

const now = 1_800_000_000
const secret = new Uint8Array(32).fill(9)
const room = deriveRoom(secret).roomId
const first = 'ab'.repeat(32)
const second = 'bc'.repeat(32)
const ownerSk = new Uint8Array(32).fill(5)
const owner = getPublicKey(ownerSk)

function rotation(participant = first, inviter = owner): RoomRotation {
  return {
    participant,
    link: encodeRoomLink('https://example.test/j/', {
      invitation: { bearer: new Uint8Array(32).fill(7), inviter, ownerApprovedRoom: room },
      relays: [], iceUrls: [],
    }),
    admission: { secret, epoch: { epoch: 1, secret: new Uint8Array(32).fill(12), rotatedAt: now - 30 } },
    past: [],
  }
}

describe('saved legacy room rotation', () => {
  it('retains approval for that persona and fences the old link across personas', () => {
    const store = memoryDeviceStore()
    const state = { ...rotation(), ownerSk }
    expect(storeRoomRotation(store, room, state, now)).toEqual(state)
    expect(hasRoomRotation(store, room)).toBe(true)
    expect(loadRoomRotation(store, room, second)).toBeUndefined()
    expect(loadRoomRotation(store, room, first)).toEqual(state)
    expect(rotationHistory(state, now)).toEqual([{ epoch: 0, secret, leftAt: now - 30 }])
  })

  it('keeps another approved persona separate and refuses an owner substituted after migration', () => {
    const store = memoryDeviceStore()
    storeRoomRotation(store, room, { ...rotation(), ownerSk }, now)
    expect(() => storeRoomRotation(store, room, rotation(second, getPublicKey(new Uint8Array(32).fill(4))), now)).toThrow(/owner/)
    storeRoomRotation(store, room, rotation(second), now)
    expect(loadRoomRotation(store, room, second)?.ownerSk).toBeUndefined()
    expect(loadRoomRotation(store, room, first)?.ownerSk).toEqual(ownerSk)
  })

  it('holds its original cutoff and refuses a stale or conflicting grant', () => {
    const store = memoryDeviceStore()
    const old = rotation()
    const next = {
      ...old,
      admission: { secret, epoch: { epoch: 2, secret: new Uint8Array(32).fill(11), rotatedAt: now - 30 } },
      past: [{ ...old.admission.epoch, leftAt: now - 1 }],
    }
    storeRoomRotation(store, room, { ...old, ownerSk }, now)
    storeRoomRotation(store, room, next, now)
    expect(() => storeRoomRotation(store, room, old, now)).toThrow(/latest/)
    expect(() => storeRoomRotation(store, room, {
      ...next, admission: { secret, epoch: { ...next.admission.epoch, rotatedAt: now - 25 } },
    }, now)).toThrow(/key change/)
    const restored = loadRoomRotation(store, room, first)!
    expect(restored.ownerSk).toEqual(ownerSk)
    expect(rotationHistory(restored, now).map(item => [item.epoch, item.leftAt])).toEqual([[1, now - 1], [0, now - 30]])
  })

  it('rejects the leaked key as a new key and holds when a retained record is damaged', () => {
    const store = memoryDeviceStore()
    const state = rotation()
    expect(() => storeRoomRotation(store, room, {
      ...state, admission: { secret, epoch: { ...state.admission.epoch, secret } },
    }, now)).toThrow()
    expect(hasRoomRotation(store, room)).toBe(false)
    store.set(ROOM_ROTATION_PREFIX + room + '.' + first, '{}')
    expect(hasRoomRotation(store, room)).toBe(true)
    expect(() => loadRoomRotation(store, room, first)).toThrow()
  })

  it('drops the persona’s keys when forgotten and keeps the public owner pin', () => {
    const store = memoryDeviceStore()
    storeRoomRotation(store, room, { ...rotation(), ownerSk }, now)
    forgetRoomRotation(store, room, first)
    expect(loadRoomRotation(store, room, first)).toBeUndefined()
    expect(hasRoomRotation(store, room)).toBe(true)
    expect(store.keys()).toEqual([ROOM_ROTATION_PREFIX + room])
    expect(store.get(ROOM_ROTATION_PREFIX + room)).toBe(owner)
    expect(() => storeRoomRotation(store, room, rotation(first, second), now)).toThrow(/owner/)
  })

  it('requires a newer key when a saved device is waiting for reapproval', () => {
    const store = memoryDeviceStore()
    const old = rotation()
    storeRoomRotation(store, room, old, now)
    storeRoomRotation(store, room, { ...old, needsApproval: true }, now)
    expect(loadRoomRotation(store, room, first)?.needsApproval).toBe(true)
    expect(() => storeRoomRotation(store, room, old, now)).toThrow(/latest/)
  })
})
