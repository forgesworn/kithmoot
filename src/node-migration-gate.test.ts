import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { NodeMigrationPublicationGate, createMigratableRelayPool } from './node-migration-gate.js'
import { RelayDialGate } from './relay-dial-gate.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../test/fake-socket.js'
const event = (content: string) => finalizeEvent({ kind: 1460, created_at: 1_900_000_000, tags: [], content }, new Uint8Array(32).fill(2))
afterEach(() => { vi.useRealTimers(); resetFakeRelays() })
it('permits only the exact signed control envelope while frozen and cannot reopen a retired source', () => {
  const gate = new NodeMigrationPublicationGate(), control = event('encrypted control'), message = event('encrypted chat')
  gate.freeze()
  expect(gate.allowed(message)).toBe(false)
  const one = gate.permit(control), two = gate.permit(control)
  expect(gate.frameAllowed(JSON.stringify(['EVENT', control]))).toBe(true)
  expect(gate.frameAllowed(JSON.stringify(['EVENT', { ...control, content: 'different bytes with the same id' }]))).toBe(false)
  expect(gate.frameAllowed(JSON.stringify(['EVENT', { ...control, extra: 'not signed' }]))).toBe(false)
  expect(gate.frameAllowed(new ArrayBuffer(1))).toBe(false)
  one(); one(); expect(gate.allowed(control)).toBe(true)
  two(); expect(gate.allowed(control)).toBe(false)
  gate.retire()
  expect(() => gate.reopen()).toThrow('retired')
  expect(() => gate.permit(control)).toThrow()
})
it('fences a queued application write at socket send, permits encrypted control and keeps readback working', async () => {
  vi.useFakeTimers()
  const url = 'wss://migration-publication.test', relay = fakeRelay(url)
  const { pool, gate, transport } = createMigratableRelayPool([url], undefined, {
    websocketImplementation: FakeWebSocket as unknown as typeof WebSocket, dialGate: new RelayDialGate(),
  })
  const message = event('queued before preparation'), control = event('encrypted preparation')
  const pending = transport.publish(message).then(() => 'accepted', () => 'refused')
  gate.freeze()
  const release = gate.permit(control)
  try {
    const sent = transport.publish(control, { allRelays: true })
    await vi.advanceTimersByTimeAsync(10); await sent
    expect(relay.stored.map(e => e.id)).toEqual([control.id])
    const read = pool.query(url, [{ ids: [control.id] }])
    await vi.advanceTimersByTimeAsync(10)
    expect((await read).complete).toBe(true)
    expect(relay.frames.filter(raw => JSON.parse(raw)[0] === 'EVENT').every(raw => JSON.parse(raw)[1].id === control.id)).toBe(true)
    gate.retire()
    await expect(transport.publish(control)).rejects.toThrow('paused')
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await pending).toBe('refused')
  } finally { release(); transport.close() }
})
it('retains the parent socket fence and fails closed if a frame guard throws', async () => {
  vi.useFakeTimers()
  const url = 'wss://migration-parent.test', relay = fakeRelay(url)
  const { pool, transport } = createMigratableRelayPool([url], undefined, {
    websocketImplementation: FakeWebSocket as unknown as typeof WebSocket, dialGate: new RelayDialGate(),
    frameGuard: () => { throw Error('parent fence failed') },
  })
  const sent = transport.publishGuarded!(event('encrypted control'), () => true).then(() => true, () => false)
  try {
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await sent).toBe(false); expect(relay.frames).toHaveLength(0)
  } finally { pool.close() }
})
