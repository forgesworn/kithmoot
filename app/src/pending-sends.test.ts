import { describe, it, expect, vi } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import { memoryDeviceStore } from './device-store.js'
import { PendingSends, stateAfter, neverLeft, RETRY_SECONDS, ECHO_GRACE_MS, CONNECT_POLL_MS, type PendingSend } from './pending-sends.js'
import { CONVERSATION_MOVED } from '../../src/chat.js'

const ROOM = 'a'.repeat(64)
const event = (id: string) => ({ id, kind: 1, pubkey: 'p', created_at: 1, tags: [], content: id, sig: 's' }) as Event

function harness(connected = true) {
  const store = memoryDeviceStore()
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void }> = []
  const state = { connected }
  const pending = new PendingSends({
    store, connected: () => state.connected, now: () => clock,
    schedule: (run, ms) => { timers.push({ at: clock + ms, run }) },
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const timer of timers.splice(0).filter(t => { if (t.at <= clock) return true; timers.push(t); return false })) timer.run()
    await Promise.resolve(); await Promise.resolve()
  }
  return { store, pending, state, advance }
}

function add(pending: PendingSends, id: string, publish: () => Promise<void>, durable = true): PendingSend {
  pending.add({ id, roomId: ROOM, channel: 'Chat', text: `text ${id}`, files: [], event: event(id), publish, durable })
  return pending.items(ROOM).find(item => item.id === id)!
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('unsent messages', () => {
  it('reads what a failed publish says about where the event went', () => {
    expect(stateAfter(new Error('every relay rejected the event (wss://a: blocked)'))).toBe('refused')
    expect(stateAfter(new Error('no relay could be reached in time (wss://a: timeout)'))).toBe('unknown')
    expect(stateAfter(new Error(CONVERSATION_MOVED))).toBe('moved')
    expect(stateAfter(new Error('something else'))).toBe('unknown')
  })

  it('is not offered to the relays while none can be reached, then goes when one can', async () => {
    const h = harness(false)
    const publish = vi.fn(async () => {})
    const item = add(h.pending, 'one', publish)
    await flush()
    expect(publish).not.toHaveBeenCalled()
    expect(item.state).toBe('waiting')
    h.state.connected = true
    await h.advance(CONNECT_POLL_MS)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('stays listed until its message arrives in the chat, or a short grace passes', async () => {
    const h = harness()
    add(h.pending, 'one', async () => {}); add(h.pending, 'two', async () => {})
    await flush()
    h.pending.arrived(['one'])
    expect(h.pending.items(ROOM).map(item => item.id)).toEqual(['two'])
    await h.advance(ECHO_GRACE_MS)
    expect(h.pending.items(ROOM)).toEqual([])
  })

  it('retries on a back-off with the same event, and says whether it could have arrived', async () => {
    const h = harness()
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('no relay could be reached in time (wss://a)'))
      .mockRejectedValueOnce(new Error('every relay rejected the event (wss://a: rate-limited)'))
      .mockResolvedValue(undefined)
    const item = add(h.pending, 'one', publish)
    await flush()
    expect(item.state).toBe('unknown')
    await h.advance(RETRY_SECONDS[1]! * 1000)
    expect(item.state).toBe('refused')
    await h.advance(RETRY_SECONDS[2]! * 1000)
    expect(publish).toHaveBeenCalledTimes(3)
    expect(item.acknowledged).toBe(true)
  })

  it('never retries a message whose conversation moved on', async () => {
    const h = harness()
    const publish = vi.fn().mockRejectedValue(new Error(CONVERSATION_MOVED))
    const item = add(h.pending, 'one', publish)
    await flush()
    expect(item.state).toBe('moved')
    await h.advance(120_000)
    h.pending.retry('one')
    await flush()
    expect(publish).toHaveBeenCalledOnce()
  })

  it('keeps an unsent message across a reload, and drops it once a relay has it', async () => {
    const h = harness(false)
    add(h.pending, 'one', async () => {})
    add(h.pending, 'brief', async () => {}, false)
    const next = new PendingSends({ store: h.store, connected: () => true })
    const restored = next.restore(ROOM)
    expect(restored.map(item => [item.id, item.state, item.text])).toEqual([['one', 'waiting', 'text one']])
    const publish = vi.fn(async () => {})
    next.resume('one', publish)
    await flush()
    expect(publish).toHaveBeenCalledOnce()
    expect(h.store.get(`kithmoot.pending.${ROOM}`) ?? undefined).toBeUndefined()
  })

  it('says a reload caught mid-send may have arrived', async () => {
    const h = harness()
    add(h.pending, 'one', () => new Promise(() => {}))
    await flush()
    const next = new PendingSends({ store: h.store, connected: () => true })
    expect(next.restore(ROOM)[0]!.state).toBe('unknown')
  })

  it('will not dismiss a message while it is being sent', async () => {
    const h = harness()
    add(h.pending, 'one', () => new Promise(() => {}))
    await flush()
    expect(h.pending.dismiss('one')).toBeUndefined()
    expect(h.pending.items(ROOM)).toHaveLength(1)
  })

  it('waits, kept, while its room is not the one open, and goes through the room once it is again', async () => {
    const store = memoryDeviceStore()
    let open: string | undefined = ROOM
    const pending = new PendingSends({ store, connected: () => true, active: () => open })
    const closed = vi.fn().mockRejectedValue(new Error(CONVERSATION_MOVED))
    open = undefined
    pending.add({ id: 'one', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('one'), publish: closed, durable: true })
    pending.wake()
    await flush()
    expect(closed).not.toHaveBeenCalled()
    open = ROOM
    pending.release(ROOM)
    const fresh = vi.fn(async () => {})
    for (const item of pending.restore(ROOM)) pending.resume(item.id, fresh)
    await flush()
    expect(fresh).toHaveBeenCalledOnce()
    expect(closed).not.toHaveBeenCalled()
  })

  it('gives back only a message nothing of which has left the device', async () => {
    const h = harness(false)
    add(h.pending, 'offline', async () => {})
    expect(neverLeft(h.pending.items(ROOM)[0]!)).toBe(true)
    expect(h.pending.take('offline')?.text).toBe('text offline')
    expect(h.pending.items(ROOM)).toEqual([])
    h.state.connected = true
    const unanswered = add(h.pending, 'unanswered', vi.fn().mockRejectedValue(new Error('no relay could be reached in time')))
    const refused = add(h.pending, 'refused', vi.fn().mockRejectedValue(new Error('every relay rejected the event')))
    await flush()
    expect(unanswered.state).toBe('unknown')
    expect(h.pending.take('unanswered')).toBeUndefined()
    expect(h.pending.take('refused')).toBe(refused)
  })

  it('remembers across a reload which messages Edit can take back', () => {
    const h = harness(false)
    h.pending.add({ id: 'plain', roomId: ROOM, channel: 'Chat', text: 't', files: [], event: event('plain'), publish: async () => {}, durable: true, editable: true })
    add(h.pending, 'reply', async () => {})
    const next = new PendingSends({ store: h.store, connected: () => false })
    expect(next.restore(ROOM).map(item => [item.id, item.editable === true])).toEqual([['plain', true], ['reply', false]])
  })

  it('lists each room on its own', () => {
    const h = harness(false)
    add(h.pending, 'one', async () => {})
    h.pending.add({ id: 'two', roomId: 'b'.repeat(64), channel: 'Chat', text: 't', files: [], event: event('two'), publish: async () => {}, durable: true })
    expect(h.pending.items(ROOM).map(item => item.id)).toEqual(['one'])
  })
})
