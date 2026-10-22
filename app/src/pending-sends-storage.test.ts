import { describe, it, expect, vi } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import { PendingSends, stateAfter, neverLeft, RETRY_SECONDS } from './pending-sends.js'
import { CONVERSATION_MOVED } from '../../src/chat.js'
import { GROUP_STORAGE_WAITING } from '../../src/group-storage.js'

const ROOM = 'a'.repeat(64)
const event = (id: string) => ({ id, kind: 1, pubkey: 'p', created_at: 1, tags: [], content: id, sig: 's' }) as Event
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }

function harness() {
  const store = memoryDeviceStore()
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void }> = []
  const pending = new PendingSends({ store, connected: () => true, now: () => clock, schedule: (run, ms) => { timers.push({ at: clock + ms, run }) } })
  const advance = async (ms: number) => {
    clock += ms
    for (const timer of timers.splice(0).filter(t => { if (t.at <= clock) return true; timers.push(t); return false })) timer.run()
    await flush()
  }
  return { store, pending, advance }
}
const item = (pending: PendingSends, id: string) => pending.items(ROOM).find(saved => saved.id === id)!
const waitingForStorage = () => Promise.reject(new Error(GROUP_STORAGE_WAITING))

describe('a message waiting for the group’s storage to take its files', () => {
  it('is waiting, not unknown, so nothing of it has left and it can still be deleted without a trace', async () => {
    expect(stateAfter(new Error(GROUP_STORAGE_WAITING))).toBe('waiting')
    expect(stateAfter(new Error('every relay rejected the event (wss://a)'))).toBe('refused')
    expect(stateAfter(new Error('something else'))).toBe('unknown')
    const h = harness()
    await h.pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photo', files: ['a.jpg'], event: event('one'), publish: waitingForStorage, durable: false })
    await flush()
    const saved = item(h.pending, 'one')
    expect(saved.state).toBe('waiting')
    expect(saved.storage).toBe(true)
    expect(saved.attempts).toBe(1)
    expect(neverLeft(saved)).toBe(true)
    expect(await h.pending.take('one')).toBeDefined()
  })

  it('tries again on the usual back-off, and goes once a node takes the file', async () => {
    const h = harness()
    const publish = vi.fn().mockImplementationOnce(waitingForStorage).mockImplementationOnce(waitingForStorage).mockResolvedValue(undefined)
    await h.pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photo', files: ['a.jpg'], event: event('one'), publish, durable: false })
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)
    await h.advance(RETRY_SECONDS[1]! * 1000)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(item(h.pending, 'one').storage).toBe(true)
    await h.advance(RETRY_SECONDS[2]! * 1000)
    expect(publish).toHaveBeenCalledTimes(3)
    const sent = item(h.pending, 'one')
    expect(sent.acknowledged).toBe(true)
    expect(sent.storage).toBeUndefined()
  })

  it('goes at once when a grant or a newer list arrives, not at its next turn', async () => {
    const h = harness()
    const publish = vi.fn().mockImplementationOnce(waitingForStorage).mockResolvedValue(undefined)
    await h.pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photo', files: [], event: event('one'), publish, durable: false })
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)
    // An ordinary wake still honours the back-off.
    h.pending.wake()
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)
    h.pending.wakeStorage()
    await flush()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(item(h.pending, 'one').acknowledged).toBe(true)
  })

  it('wakeStorage leaves a message waiting on a relay to its own back-off', async () => {
    const h = harness()
    const publish = vi.fn().mockRejectedValue(new Error('no relay could be reached in time (wss://a)'))
    await h.pending.add({ id: 'relay', roomId: ROOM, channel: 'Chat', text: 'hi', files: [], event: event('relay'), publish, durable: true })
    await flush()
    h.pending.wakeStorage()
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(item(h.pending, 'relay').storage).toBeUndefined()
  })

  it('a message whose conversation changed its key is moved, not waiting: it is never sent under the old key', async () => {
    const h = harness()
    const publish = vi.fn().mockRejectedValue(new Error(CONVERSATION_MOVED))
    await h.pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photo', files: ['a.jpg'], event: event('one'), publish, durable: false })
    await flush()
    expect(item(h.pending, 'one').state).toBe('moved')
    expect(item(h.pending, 'one').storage).toBeUndefined()
    await h.advance(120_000)
    h.pending.wakeStorage()
    await flush()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('is held in memory only: a reload finds nothing of it', async () => {
    const h = harness()
    await h.pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 'photo', files: ['a.jpg'], event: event('one'), publish: waitingForStorage, durable: false })
    await flush()
    expect(h.store.keys()).toEqual([])
    const reloaded = new PendingSends({ store: h.store, connected: () => true })
    expect(await reloaded.restore(ROOM)).toEqual([])
  })
})
