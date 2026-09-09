import { describe, it, expect } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { QUIET_PREFIX, QUIET_QUEUE_MAX_AGE_SECONDS, forgetQuietState, loadQuietState, storeQuietState } from './quiet-store.js'
import type { Event } from 'nostr-tools/pure'

const NOW = 1_800_000_000
const ROOM = 'a'.repeat(64)
const event = (id: string): Event => ({ id, pubkey: 'p'.repeat(64), sig: 's'.repeat(128), kind: 1460, created_at: NOW, tags: [['d', 'x']], content: 'c' })

describe('quiet state on this device', () => {
  it('keeps used counters and the queue per room, and forgets them', () => {
    const store = memoryDeviceStore()
    expect(loadQuietState(store, ROOM, NOW)).toEqual({ queued: [], at: NOW })
    storeQuietState(store, ROOM, { used: { m: { epoch: 500000, counters: [1, 5] } }, epoch: 2, queued: [event('1'.repeat(64))] }, NOW)
    expect(store.keys()).toEqual([QUIET_PREFIX + ROOM])
    const back = loadQuietState(store, ROOM, NOW + 60)
    expect(back.used).toEqual({ m: { epoch: 500000, counters: [1, 5] } })
    expect(back.epoch).toBe(2)
    expect(back.queued.map((e) => e.id)).toEqual(['1'.repeat(64)])
    forgetQuietState(store, ROOM)
    expect(store.keys()).toEqual([])
  })
  it('an empty state removes the entry rather than keeping a blank one', () => {
    const store = memoryDeviceStore()
    storeQuietState(store, ROOM, { used: { m: { epoch: 1, counters: [] } }, queued: [] }, NOW)
    storeQuietState(store, ROOM, { queued: [] }, NOW)
    expect(store.keys()).toEqual([])
  })
  it('a queue older than a day is not re-queued; the counters still come back', () => {
    const store = memoryDeviceStore()
    storeQuietState(store, ROOM, { used: { m: { epoch: 1, counters: [3] } }, queued: [event('1'.repeat(64))] }, NOW)
    const later = loadQuietState(store, ROOM, NOW + QUIET_QUEUE_MAX_AGE_SECONDS + 1)
    expect(later.queued).toEqual([])
    expect(later.used).toEqual({ m: { epoch: 1, counters: [3] } })
  })
  it('refuses a malformed entry and a bad room id', () => {
    const store = memoryDeviceStore()
    store.set(QUIET_PREFIX + ROOM, '{"queued":[{"id":1}],"used":"no","at":' + NOW + '}')
    expect(loadQuietState(store, ROOM, NOW)).toEqual({ queued: [], at: NOW })
    store.set(QUIET_PREFIX + ROOM, 'not json')
    expect(loadQuietState(store, ROOM, NOW)).toEqual({ queued: [], at: NOW })
    storeQuietState(store, 'nope', { queued: [event('1'.repeat(64))] }, NOW)
    expect(store.keys()).toEqual([QUIET_PREFIX + ROOM])
  })
})
