import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom } from '../../src/room.js'
import { localIdentity } from '../../src/identity.js'
import { decodeReadPositions, encodeReadPositionsLocal, localSelfCrypt } from '../../src/read-position.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { ReadPositionSync } from './read-positions.js'

const NOW = 1_800_000_000

function fakeRelay() {
  const published: Event[] = []
  let handler: ((event: Event) => void) | undefined
  const relay = {
    subscribe: (_filters: unknown, onEvent: (event: Event) => void) => { handler = onEvent; return () => { handler = undefined } },
    publish: async (event: Event) => { published.push(event) },
    close: () => {},
  } as unknown as RelayTransport
  return { relay, published, deliver: (event: Event) => handler?.(event) }
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
    deliver(encodeReadPositionsLocal({ '': { at: 30 } }, { roomId, roomKey, participantSk: generateSecretKey(), createdAt: NOW }))
    await vi.advanceTimersByTimeAsync(0)
    expect(ahead).not.toHaveBeenCalled()
    sync.close()
    vi.useRealTimers()
  })
})
