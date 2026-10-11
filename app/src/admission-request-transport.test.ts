import { describe, expect, it } from 'vitest'
import type { RelayTransport } from '../../src/relay-pool.js'
import { admissionRequestTransport } from './admission-request-transport.js'

function fixture() {
  let current = true, release!: () => void, reject!: (error: Error) => void
  let pending = Promise.resolve()
  const events: string[] = [], phases: string[] = []
  let guard: (() => boolean) | undefined, receiver: Parameters<RelayTransport['subscribe']>[1] | undefined
  let closes = 0, received = 0
  const pool: RelayTransport = {
    publish: () => { throw new Error('Unguarded publication used') },
    publishGuarded: async (event, allowed) => { guard = allowed; events.push(event.id); await pending },
    subscribe: (_, callback) => { receiver = callback; return () => {} }, close: () => { closes++ },
  }
  const transport = admissionRequestTransport(pool, { current: () => current, phase: value => phases.push(value) })
  const event = { id: 'a'.repeat(64), kind: 20466, pubkey: 'b'.repeat(64), created_at: 1, tags: [], content: '', sig: 'c'.repeat(128) }
  return { pool, transport, event, events, phases, stale: () => { current = false },
    hold: () => { pending = new Promise<void>((resolve, fail) => { release = resolve; reject = fail }) },
    release: () => release(), fail: () => reject(new Error('Relay rejected request')),
    guard: () => guard?.(), closes: () => closes,
    listen: () => transport.subscribe([], () => { received++ }), deliver: () => receiver?.(event), received: () => received }
}

describe('guest request dispatch', () => {
  it('requires a guarded carrier rather than falling back to ordinary publication', async () => {
    const f = fixture(); delete f.pool.publishGuarded
    await expect(f.transport.publish(f.event)).rejects.toThrow('no longer available')
    expect(f.events).toEqual([])
  })
  it('cancellation between the click and dispatch prevents the queued write', async () => {
    const f = fixture(), operation = f.transport.publish(f.event); f.stale()
    await expect(operation).rejects.toThrow('cancelled'); expect(f.events).toEqual([])
  })
  it('coalesces overlapping retries while connecting and binds the socket guard to this request', async () => {
    const f = fixture(); f.hold()
    const first = f.transport.publish(f.event), second = f.transport.publish(f.event)
    expect(first).toBe(second); await Promise.resolve()
    expect(f.events).toEqual([f.event.id]); expect(f.guard()).toBe(true)
    f.stale(); expect(f.guard()).toBe(false); f.release(); await first
    expect(f.phases).toEqual(['sending'])
  })
  it('retries the same request after rejection and reports waiting only after acknowledgement', async () => {
    const f = fixture(); f.hold(); const first = f.transport.publish(f.event)
    await Promise.resolve(); f.fail(); await expect(first).rejects.toThrow('Relay rejected')
    expect(f.phases).toEqual(['sending', 'reconnecting'])
    f.hold(); const second = f.transport.publish(f.event); await Promise.resolve(); f.release(); await second
    expect(f.events).toEqual([f.event.id, f.event.id]); expect(f.phases.at(-1)).toBe('waiting')
  })
  it('periodic retries after an acknowledgement do not flicker back to Sending', async () => {
    const f = fixture(); await f.transport.publish(f.event); await f.transport.publish(f.event)
    expect(f.phases).toEqual(['sending', 'waiting', 'waiting'])
  })
  it('a later connection failure is visible even after the initial acknowledgement', async () => {
    const f = fixture(); await f.transport.publish(f.event); f.hold()
    const retry = f.transport.publish(f.event); await Promise.resolve(); f.fail()
    await expect(retry).rejects.toThrow('Relay rejected')
    expect(f.phases).toEqual(['sending', 'waiting', 'reconnecting'])
  })
  it('rejects a different request or a non-request event', async () => {
    const f = fixture(); await f.transport.publish(f.event)
    await expect(f.transport.publish({ ...f.event, id: 'd'.repeat(64) })).rejects.toThrow('Another admission')
    await expect(f.transport.publish({ ...f.event, kind: 20467 })).rejects.toThrow('no longer available')
    expect(f.events).toHaveLength(1)
  })
  it('does not deliver late replies to a cancelled guest and closes the owned pool', () => {
    const f = fixture(); f.listen(); f.deliver(); expect(f.received()).toBe(1)
    f.stale(); f.deliver(); expect(f.received()).toBe(1)
    f.transport.close(); expect(f.closes()).toBe(1)
  })
  it('closing the request carrier invalidates writes and ignores late confirmation', async () => {
    const f = fixture(); f.hold(); const operation = f.transport.publish(f.event)
    await Promise.resolve(); f.transport.close(); expect(f.guard()).toBe(false)
    f.release(); await operation
    expect(f.phases).toEqual(['sending'])
    await expect(f.transport.publish(f.event)).rejects.toThrow('no longer available')
  })
})
