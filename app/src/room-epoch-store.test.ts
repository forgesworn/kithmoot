import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { memoryDeviceStore } from './device-store.js'
import {
  ROOM_EPOCH_PREFIX,
  ROOM_EPOCH_V2_PREFIX,
  forgetRoomEpoch,
  keepFollowedRekey,
  keptEpochIds,
  loadKeptRoomEpoch,
  loadRoomEpochV1,
  loadWatchedEpoch,
  pastRootsOf,
  storeKeptRoomEpoch,
} from './room-epoch-store.js'
import { HISTORY_WINDOW_SECONDS, MAX_HISTORY_EPOCHS, deriveEpoch, generateEpochSecret } from '../../src/epoch.js'

const NOW = 1_800_000_000
const ROOM = 'ab'.repeat(32)
const ROOM_SECRET = new Uint8Array(32).fill(5)
const A = '11'.repeat(32)
const B = '22'.repeat(32)
const epochAt = (epoch: number) => ({ epoch, secret: new Uint8Array(32).fill(epoch + 40) })

describe('room epoch store', () => {
  it('keeps the epoch, its secret, the window, the removed and the members, and v1 beside them', () => {
    const store = memoryDeviceStore()
    storeKeptRoomEpoch(store, ROOM, {
      epoch: epochAt(3),
      past: [{ ...epochAt(2), leftAt: NOW - 10 }, { ...epochAt(1), leftAt: NOW - 20 }, { epoch: 0, secret: ROOM_SECRET, leftAt: NOW - 30 }],
      removed: [B],
      members: [A, B],
    }, NOW)
    const kept = loadKeptRoomEpoch(store, ROOM)!
    expect(kept.epoch).toEqual(epochAt(3))
    expect(kept.past.map((e) => [e.epoch, e.leftAt])).toEqual([[2, NOW - 10], [1, NOW - 20], [0, NOW - 30]])
    expect(kept.past[0]!.secret).toEqual(epochAt(2).secret)
    expect(kept.removed).toEqual([B])
    // The removed are never members.
    expect(kept.members).toEqual([A])
    const keys = deriveEpoch(epochAt(3))
    expect(loadRoomEpochV1(store, ROOM)).toEqual(keys)
    expect(loadWatchedEpoch(store, ROOM)).toEqual(keys)
    expect(pastRootsOf(kept)).toEqual([
      { root: { id: deriveEpoch(epochAt(2)).id, key: deriveEpoch(epochAt(2)).key }, leftAt: NOW - 10 },
      { root: { id: deriveEpoch(epochAt(1)).id, key: deriveEpoch(epochAt(1)).key }, leftAt: NOW - 20 },
      { leftAt: NOW - 30 },
    ])
  })

  it('cuts the window as it writes: the last 30 days, at most sixteen, nothing at or above the epoch', () => {
    const store = memoryDeviceStore()
    const past = Array.from({ length: 20 }, (_, i) => ({ ...epochAt(i + 1), leftAt: NOW - 100 + i }))
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(30), past: [...past, { ...epochAt(0), leftAt: NOW - HISTORY_WINDOW_SECONDS - 1 }, { ...epochAt(31), leftAt: NOW }], removed: [], members: [] }, NOW)
    const kept = loadKeptRoomEpoch(store, ROOM)!
    expect(kept.past).toHaveLength(MAX_HISTORY_EPOCHS)
    expect(kept.past[0]!.epoch).toBe(20)
    expect(kept.past.at(-1)!.epoch).toBe(5)
  })

  it('never moves back to an earlier epoch, and rewrites the same one', () => {
    const store = memoryDeviceStore()
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(3), past: [], removed: [], members: [A] }, NOW)
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(2), past: [], removed: [], members: [] }, NOW)
    expect(loadKeptRoomEpoch(store, ROOM)!.epoch.epoch).toBe(3)
    expect(loadRoomEpochV1(store, ROOM)!.epoch).toBe(3)
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(3), past: [{ ...epochAt(2), leftAt: NOW }], removed: [], members: [A, B] }, NOW)
    expect(loadKeptRoomEpoch(store, ROOM)!.members).toEqual([A, B])
    expect(loadKeptRoomEpoch(store, ROOM)!.past.map((e) => e.epoch)).toEqual([2])
  })

  it('reads what an earlier release wrote: v1 alone is what the list reads, and no session epoch', () => {
    const store = memoryDeviceStore()
    const keys = deriveEpoch(epochAt(4))
    store.set(ROOM_EPOCH_PREFIX + ROOM, JSON.stringify({ epoch: 4, id: keys.id, key: bytesToHex(keys.key) }))
    expect(loadKeptRoomEpoch(store, ROOM)).toBeUndefined()
    expect(loadWatchedEpoch(store, ROOM)).toEqual(keys)
    // A v2 record behind a later v1 (an older release ran since) is not
    // what the list reads.
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(3), past: [], removed: [], members: [] }, NOW)
    expect(loadWatchedEpoch(store, ROOM)).toEqual(keys)
  })

  it('drops a left epoch that does not parse and keeps the rest; a bad epoch is no record', () => {
    const store = memoryDeviceStore()
    store.set(ROOM_EPOCH_V2_PREFIX + ROOM, JSON.stringify({
      epoch: 3,
      secret: '33'.repeat(32),
      past: [{ epoch: 2, secret: '22'.repeat(32), leftAt: NOW }, { epoch: 3, secret: '22'.repeat(32), leftAt: NOW }, { epoch: 1, secret: 'zz', leftAt: NOW }, null, { epoch: 1, secret: '11'.repeat(32), leftAt: -1 }],
      removed: [A, 'not hex'],
      members: 'nobody',
    }))
    const kept = loadKeptRoomEpoch(store, ROOM)!
    expect(kept.past.map((e) => e.epoch)).toEqual([2])
    expect(kept.removed).toEqual([A])
    expect(kept.members).toEqual([])
    store.set(ROOM_EPOCH_V2_PREFIX + ROOM, JSON.stringify({ epoch: 0, secret: '33'.repeat(32) }))
    expect(loadKeptRoomEpoch(store, ROOM)).toBeUndefined()
    store.set(ROOM_EPOCH_V2_PREFIX + ROOM, '{not json')
    expect(loadKeptRoomEpoch(store, ROOM)).toBeUndefined()
  })

  describe('a rekey the rooms list followed', () => {
    const notice = (at: number, more: { removed?: string[]; members?: string[] } = {}) => ({ at, removed: more.removed ?? [], ...(more.members ? { members: more.members } : {}) })

    it('out of epoch 0: the whole record, epoch 0 left with the room secret', () => {
      const store = memoryDeviceStore()
      const one = { epoch: 1, secret: generateEpochSecret() }
      keepFollowedRekey(store, ROOM, { roomSecret: ROOM_SECRET, left: 0, next: one, notice: notice(NOW - 5, { members: [A] }) }, NOW)
      const kept = loadKeptRoomEpoch(store, ROOM)!
      expect(kept.epoch).toEqual(one)
      expect(kept.past).toEqual([{ epoch: 0, secret: ROOM_SECRET, leftAt: NOW - 5 }])
      expect(kept.members).toEqual([A])
      expect(loadRoomEpochV1(store, ROOM)!.epoch).toBe(1)
    })

    it('out of the epoch held: the window grows by the one left, the removed are added', () => {
      const store = memoryDeviceStore()
      storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(1), past: [{ epoch: 0, secret: ROOM_SECRET, leftAt: NOW - 50 }], removed: [], members: [A, B] }, NOW)
      const two = { epoch: 2, secret: generateEpochSecret() }
      keepFollowedRekey(store, ROOM, { roomSecret: ROOM_SECRET, left: 1, next: two, notice: notice(NOW - 5, { removed: [B] }) }, NOW)
      const kept = loadKeptRoomEpoch(store, ROOM)!
      expect(kept.epoch).toEqual(two)
      expect(kept.past.map((e) => [e.epoch, e.leftAt])).toEqual([[1, NOW - 5], [0, NOW - 50]])
      expect(kept.past[0]!.secret).toEqual(epochAt(1).secret)
      expect(kept.removed).toEqual([B])
      expect(kept.members).toEqual([A])
    })

    it('from a v1 record, whose secret this device never kept: only v1 moves', () => {
      const store = memoryDeviceStore()
      const keys = deriveEpoch(epochAt(4))
      store.set(ROOM_EPOCH_PREFIX + ROOM, JSON.stringify({ epoch: 4, id: keys.id, key: bytesToHex(keys.key) }))
      const five = { epoch: 5, secret: generateEpochSecret() }
      keepFollowedRekey(store, ROOM, { roomSecret: ROOM_SECRET, left: 4, next: five, notice: notice(NOW) }, NOW)
      expect(loadKeptRoomEpoch(store, ROOM)).toBeUndefined()
      expect(loadRoomEpochV1(store, ROOM)).toEqual(deriveEpoch(five))
    })

    it('behind what a session already wrote: nothing moves', () => {
      const store = memoryDeviceStore()
      storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(3), past: [], removed: [], members: [] }, NOW)
      keepFollowedRekey(store, ROOM, { roomSecret: ROOM_SECRET, left: 1, next: epochAt(2), notice: notice(NOW) }, NOW)
      expect(loadKeptRoomEpoch(store, ROOM)!.epoch.epoch).toBe(3)
    })
  })

  it('forgets both records, after naming every epoch they hold', () => {
    const store = memoryDeviceStore()
    storeKeptRoomEpoch(store, ROOM, { epoch: epochAt(3), past: [{ ...epochAt(2), leftAt: NOW }, { epoch: 0, secret: ROOM_SECRET, leftAt: NOW }], removed: [], members: [] }, NOW)
    expect(new Set(keptEpochIds(store, ROOM))).toEqual(new Set([deriveEpoch(epochAt(3)).id, deriveEpoch(epochAt(2)).id]))
    store.set('kithmoot.device.' + ROOM, 'kept')
    forgetRoomEpoch(store, ROOM)
    expect(store.get(ROOM_EPOCH_PREFIX + ROOM)).toBeNull()
    expect(store.get(ROOM_EPOCH_V2_PREFIX + ROOM)).toBeNull()
    expect(store.get('kithmoot.device.' + ROOM)).toBe('kept')
  })
})
