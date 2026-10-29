import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import type { ChatMessage } from './chat.js'
import { deliveryReceiptIdHash } from './delivery-receipt.js'
import { DeliveryReceiptWriter, type ReceiptPublisher, type ReceiptWriterStore } from './delivery-receipt-writer.js'

const SELF = 'aa'.repeat(32)
const OTHER = 'bb'.repeat(32)
const D = 'cd'.repeat(32)
const T0 = 1_800_000_000_000

function memoryStore(): ReceiptWriterStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: k => data.get(k), set: (k, v) => { data.set(k, v) }, remove: k => { data.delete(k) } }
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, participant: OTHER, device: OTHER, credential: {} as ChatMessage['credential'], text: 'hi', sentAt: Math.floor(Date.now() / 1000), ...overrides }
}

function publisher(opts: { fail?: () => boolean; hold?: boolean } = {}) {
  const calls: Array<{ d: string; messageIds: readonly string[]; createdAt?: number; index?: number; agent?: boolean }> = []
  const release: Array<() => void> = []
  const p: ReceiptPublisher = {
    publishDeliveryReceipt: async (o) => {
      calls.push(o)
      if (opts.hold) await new Promise<void>(r => release.push(r))
      if (opts.fail?.()) throw new Error('no relay took it')
      return { id: `e${calls.length}` } as Event
    },
  }
  return { p, calls, release }
}

const ctx = { roomId: 'room', self: SELF }

describe('DeliveryReceiptWriter', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers() })

  it('waits 2 to 6 seconds, then sends one receipt for everything waiting', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0.5 })
    const { p, calls } = publisher()
    w.received(ctx, message('m1'), D, p)
    w.received(ctx, message('m2'), D, p)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([{ d: D, messageIds: ['m1', 'm2'], createdAt: T0 / 1000 + 4, index: 0 }])
    expect(w.waiting('room')).toBe(0)
  })

  it('draws the first delay across the whole window', async () => {
    for (const [r, at] of [[0, 2_000], [0.999, 5_996]] as const) {
      vi.setSystemTime(T0)
      const w = new DeliveryReceiptWriter({ random: () => r })
      const { p, calls } = publisher()
      w.received(ctx, message('m'), D, p)
      await vi.advanceTimersByTimeAsync(at - 1)
      expect(calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toHaveLength(1)
    }
  })

  it('spaces receipts on a stream at least 30 seconds apart', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    const { p, calls } = publisher()
    w.received(ctx, message('m1'), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    w.received(ctx, message('m2'), D, p)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map(c => c.messageIds)).toEqual([['m1'], ['m2']])
  })

  it('splits more than 256 waiting ids into indexed receipts in one flush', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    const { p, calls } = publisher()
    for (let i = 0; i < 300; i++) w.received(ctx, message(`m${i}`), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.map(c => [c.index, c.messageIds.length, c.createdAt])).toEqual([[0, 256, T0 / 1000 + 2], [1, 44, T0 / 1000 + 2]])
  })

  it('never acknowledges its own person, reactions, edits, retractions or invitations', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    const { p, calls } = publisher()
    w.received(ctx, message('mine', { participant: SELF.toUpperCase() }), D, p)
    w.received(ctx, message('r', { reaction: { emoji: '👍', to: 'x' } as unknown as ChatMessage['reaction'] }), D, p)
    w.received(ctx, message('e', { replaces: 'x' }), D, p)
    w.received(ctx, message('t', { retracts: 'x' }), D, p)
    w.received(ctx, message('i', { invite: {} as ChatMessage['invite'] }), D, p)
    w.received(ctx, message('ok'), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.map(c => c.messageIds)).toEqual([['ok']])
  })

  it('says nothing about history from before this device first saw the room, or older than seven days', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    const { p, calls } = publisher()
    const now = T0 / 1000
    w.received(ctx, message('slack', { sentAt: now - 60 }), D, p)
    w.received(ctx, message('history', { sentAt: now - 61 }), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.map(c => c.messageIds)).toEqual([['slack']])

    const joined = new DeliveryReceiptWriter({ random: () => 0 })
    const second = publisher()
    joined.received({ ...ctx, joinedAt: now - 30 * 86_400 }, message('old', { sentAt: now - 8 * 86_400 }), D, second.p)
    joined.received({ ...ctx, joinedAt: now - 30 * 86_400 }, message('week', { sentAt: now - 6 * 86_400 }), D, second.p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(second.calls.map(c => c.messageIds)).toEqual([['week']])
  })

  it('acknowledges a backlog that arrived while it was away, on the next visit', async () => {
    const store = memoryStore()
    const first = new DeliveryReceiptWriter({ store, random: () => 0 })
    const a = publisher()
    first.received(ctx, message('m1'), D, a.p)
    await vi.advanceTimersByTimeAsync(2_000)
    // Away for a day; messages were sent meanwhile.
    vi.setSystemTime(T0 + 86_400_000)
    const later = new DeliveryReceiptWriter({ store, random: () => 0 })
    const b = publisher()
    later.received(ctx, message('m1', { sentAt: T0 / 1000 }), D, b.p)
    later.received(ctx, message('m2', { sentAt: T0 / 1000 + 3_600 }), D, b.p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(b.calls.map(c => c.messageIds)).toEqual([['m2']])
  })

  it('remembers an id only after a relay took the receipt, and retries one that failed', async () => {
    const store = memoryStore()
    let failing = true
    const w = new DeliveryReceiptWriter({ store, random: () => 0 })
    const { p, calls } = publisher({ fail: () => failing })
    w.received(ctx, message('m1'), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(1)
    expect(store.data.get('kithmoot.delivery-acks.v1.room')).not.toContain(deliveryReceiptIdHash('m1'))
    failing = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toHaveLength(2)
    expect(store.data.get('kithmoot.delivery-acks.v1.room')).toContain(deliveryReceiptIdHash('m1'))
    w.received(ctx, message('m1'), D, p)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(2)
  })

  it('sends nothing while the setting is off', async () => {
    let on = false
    const w = new DeliveryReceiptWriter({ random: () => 0, enabled: () => on })
    const { p, calls } = publisher()
    w.received(ctx, message('m1'), D, p)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(0)
    on = true
    w.received(ctx, message('m2'), D, p)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.map(c => c.messageIds)).toEqual([['m2']])
  })

  it('sends nothing for a quiet room, and marks an agent\'s receipts', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0, agent: true })
    const { p, calls } = publisher()
    w.received({ ...ctx, quiet: true }, message('q'), D, p)
    w.received(ctx, message('a'), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toEqual([expect.objectContaining({ messageIds: ['a'], agent: true })])
  })

  it('cancelling a room stops what waits and records nothing from a receipt in flight', async () => {
    const store = memoryStore()
    const w = new DeliveryReceiptWriter({ store, random: () => 0 })
    const held = publisher({ hold: true })
    w.received(ctx, message('m1'), D, held.p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(held.calls).toHaveLength(1)
    w.cancel('room')
    held.release.forEach(r => r())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.data.get('kithmoot.delivery-acks.v1.room')).not.toContain(deliveryReceiptIdHash('m1'))

    const waiting = publisher()
    w.received(ctx, message('m2'), D, waiting.p)
    w.forget('room')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(waiting.calls).toHaveLength(0)
    expect(store.data.has('kithmoot.delivery-acks.v1.room')).toBe(false)
  })

  it('drops what waits for a conversation that closed, instead of retrying it for ever', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    let closed = false
    const calls: unknown[] = []
    const p: ReceiptPublisher = {
      get closed() { return closed },
      publishDeliveryReceipt: async (o) => { calls.push(o); throw new Error('closed') },
    }
    w.received(ctx, message('m1'), D, p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls).toHaveLength(1)
    closed = true
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toHaveLength(1)
    expect(w.waiting('room')).toBe(0)
  })

  it('keeps streams apart', async () => {
    const w = new DeliveryReceiptWriter({ random: () => 0 })
    const { p, calls } = publisher()
    w.received(ctx, message('a'), D, p)
    w.received(ctx, message('b'), 'ef'.repeat(32), p)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls.map(c => [c.d, c.messageIds])).toEqual([[D, ['a']], ['ef'.repeat(32), ['b']]])
  })
})
