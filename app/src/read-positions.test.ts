import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom } from '../../src/room.js'
import { localIdentity } from '../../src/identity.js'
import { decodeReadPositions, encodeReadPositionsLocal, localSelfCrypt } from '../../src/read-position.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { READ_POSITION_IDS_PER_FILTER, ReadPositionSync } from './read-positions.js'
import type { Filter } from 'nostr-tools/filter'
import { readPositionId } from '../../src/read-position.js'

const NOW = 1_800_000_000

function fakeRelay() {
  const published: Event[] = []
  const open = new Map<number, { filters: Filter[]; onEvent: (event: Event) => void }>()
  let next = 0
  const relay = {
    subscribe: (filters: Filter[], onEvent: (event: Event) => void) => { const id = next++; open.set(id, { filters, onEvent }); return () => { open.delete(id) } },
    publish: async (event: Event) => { published.push(event) },
    close: () => {},
  } as unknown as RelayTransport
  return { relay, published, open, deliver: (event: Event) => { for (const sub of [...open.values()]) sub.onEvent(event) } }
}

describe('ReadPositionSync', () => {
  const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(9))
  const sk = generateSecretKey()

  it('publishes when this device is ahead, once, after the delay', async () => {
    vi.useFakeTimers()
    const { relay, published } = fakeRelay()
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), relay, () => {}, () => NOW)
    sync.follow(roomId, roomKey, { '': { at: 10 } })
    sync.note(roomId, { '': { at: 20, id: 'm2' } })
    sync.note(roomId, { '': { at: 25, id: 'm3' } })
    sync.note(roomId, { '': { at: 24 } })
    expect(published).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(published).toHaveLength(1)
    const record = await decodeReadPositions(published[0]!, { participant: getPublicKey(sk), roomId, roomKey, crypt: localSelfCrypt(sk) })
    expect(record?.read).toEqual({ '': { at: 25, id: 'm3' } })
    sync.close()
    vi.useRealTimers()
  })

  it('applies a record that is ahead, and republishes when this device knew more', async () => {
    vi.useFakeTimers()
    const { relay, published, deliver } = fakeRelay()
    const ahead = vi.fn()
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), relay, ahead, () => NOW)
    sync.follow(roomId, roomKey, { '': { at: 10 }, minutes: { at: 50 } })
    await Promise.resolve()
    deliver(encodeReadPositionsLocal({ '': { at: 30 } }, { roomId, roomKey, participantSk: sk, createdAt: NOW - 5 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(ahead).toHaveBeenCalledWith(roomId, { '': { at: 30 }, minutes: { at: 50 } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(published).toHaveLength(1)
    // A record that is behind changes nothing and publishes nothing more.
    deliver(encodeReadPositionsLocal({ '': { at: 5 } }, { roomId, roomKey, participantSk: sk, createdAt: NOW - 50 }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ahead).toHaveBeenCalledTimes(1)
    expect(published).toHaveLength(1)
    sync.close()
    vi.useRealTimers()
  })

  it('lets go of a record already being signed when the room is forgotten', async () => {
    vi.useFakeTimers()
    const { relay, published } = fakeRelay()
    const crypt = localSelfCrypt(sk)
    let signing: (() => void) | undefined
    const slow = { encrypt: async (text: string) => { await new Promise<void>(resolve => { signing = resolve }); return crypt.encrypt(text) }, decrypt: crypt.decrypt }
    const sync = new ReadPositionSync(localIdentity(sk), slow, relay, () => {}, () => NOW)
    sync.follow(roomId, roomKey, { '': { at: 10 } })
    sync.note(roomId, { '': { at: 20, id: 'm2' } })
    await vi.advanceTimersByTimeAsync(5_000)
    // The signer has the record and the room is tidied up underneath it.
    expect(signing).toBeDefined()
    expect(published).toHaveLength(0)
    sync.forget(roomId)
    signing!()
    await sync.settle()
    expect(published).toEqual([])
    // Nothing more is scheduled for a room this browser no longer keeps.
    sync.note(roomId, { '': { at: 30, id: 'm3' } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(published).toEqual([])
    sync.close()
    vi.useRealTimers()
  })

  it('waits for a record already on its way, and does not wait for ever', async () => {
    vi.useFakeTimers()
    const { relay, published } = fakeRelay()
    let landed: (() => void) | undefined
    const slow = { ...relay, publish: async (event: Event) => { published.push(event); await new Promise<void>(resolve => { landed = resolve }) } } as unknown as RelayTransport
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), slow, () => {}, () => NOW)
    sync.follow(roomId, roomKey, { '': { at: 10 } })
    sync.note(roomId, { '': { at: 20, id: 'm2' } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(published).toHaveLength(1)
    sync.forget(roomId)
    // A relay that never answers must not hold the room's tidy-up open.
    let settled = false
    void sync.settle(2_000).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(settled).toBe(true)
    landed!()
    sync.close()
    vi.useRealTimers()
  })

  it('ignores a record from somebody else', async () => {
    vi.useFakeTimers()
    const { relay, deliver } = fakeRelay()
    const ahead = vi.fn()
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), relay, ahead, () => NOW)
    sync.follow(roomId, roomKey, {})
    await Promise.resolve()
    deliver(encodeReadPositionsLocal({ '': { at: 30 } }, { roomId, roomKey, participantSk: generateSecretKey(), createdAt: NOW }))
    await vi.advanceTimersByTimeAsync(0)
    expect(ahead).not.toHaveBeenCalled()
    sync.close()
    vi.useRealTimers()
  })

  it('follows every room in one subscription, and routes each record to its room', async () => {
    vi.useFakeTimers()
    const { relay, open, deliver } = fakeRelay()
    const ahead = vi.fn()
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), relay, ahead, () => NOW)
    const rooms = Array.from({ length: 30 }, (_, i) => deriveRoom(new Uint8Array(32).fill(i + 1)))
    for (const room of rooms) sync.follow(room.roomId, room.roomKey, { '': { at: 1 } })
    await Promise.resolve()
    expect(open.size).toBe(1)
    const [sub] = [...open.values()]
    expect(sub!.filters).toHaveLength(1)
    expect(sub!.filters[0]!['#d']).toEqual(rooms.map(room => readPositionId(room.roomKey)))
    const target = rooms[7]!
    deliver(encodeReadPositionsLocal({ '': { at: 40 } }, { roomId: target.roomId, roomKey: target.roomKey, participantSk: sk, createdAt: NOW - 5 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(ahead).toHaveBeenCalledTimes(1)
    expect(ahead).toHaveBeenCalledWith(target.roomId, { '': { at: 40 } })
    // Forgetting a room narrows the one subscription; nothing is left open twice.
    sync.forget(target.roomId)
    await Promise.resolve()
    expect(open.size).toBe(1)
    expect([...open.values()][0]!.filters[0]!['#d']).not.toContain(readPositionId(target.roomKey))
    sync.close()
    expect(open.size).toBe(0)
    vi.useRealTimers()
  })

  it('splits a long list of rooms across filters of one subscription', async () => {
    const { relay, open } = fakeRelay()
    const sync = new ReadPositionSync(localIdentity(sk), localSelfCrypt(sk), relay, () => {}, () => NOW)
    const count = READ_POSITION_IDS_PER_FILTER * 2 + 5
    for (let i = 0; i < count; i++) {
      const seed = new Uint8Array(32); seed[0] = i & 0xff; seed[1] = i >> 8; seed[2] = 7
      const room = deriveRoom(seed)
      sync.follow(room.roomId, room.roomKey, {})
    }
    await Promise.resolve()
    expect(open.size).toBe(1)
    const filters = [...open.values()][0]!.filters
    expect(filters.map(filter => filter['#d']!.length)).toEqual([READ_POSITION_IDS_PER_FILTER, READ_POSITION_IDS_PER_FILTER, 5])
    sync.close()
  })
})
