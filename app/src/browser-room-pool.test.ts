import { afterEach, describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { BrowserRoomPool } from './browser-room-pool.js'
import { NostrRelayPool } from '../../src/relay-pool.js'
import { RelayDialGate } from '../../src/relay-dial-gate.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../../test/fake-socket.js'

const url = 'wss://guarded-room-route.test'
const reply = () => finalizeEvent({ kind: 20467, created_at: 1_800_000_000, tags: [], content: 'encrypted refusal' }, new Uint8Array(32).fill(3))
const pools: BrowserRoomPool[] = []
afterEach(() => { for (const p of pools.splice(0)) p.close() })

function fixture() {
  resetFakeRelays()
  const relay = fakeRelay(url)
  let opened!: () => void
  const gate = new Promise<void>(resolve => { opened = resolve })
  const publicPool = new NostrRelayPool([url], undefined, { websocketImplementation: FakeWebSocket as unknown as typeof WebSocket, dialGate: new RelayDialGate() })
  const pool = new BrowserRoomPool({ room: 'a'.repeat(64), account: () => undefined,
    store: { all: async () => [] }, barrier: { listen: () => () => {}, publicLease: async () => { await gate; return async () => {} } },
    publicPool: () => publicPool, privatePool: async () => { throw new Error('Unexpected private route') } })
  pools.push(pool)
  return { pool, publicPool, relay, opened }
}

describe('guarded room route publication', () => {
  it('retains the decision guard while waiting for room storage and route ownership', async () => {
    const f = fixture(); let allowed = true
    const sent = f.pool.publishGuarded(reply(), () => allowed), rejected = expect(sent).rejects.toThrow('unavailable')
    allowed = false; f.opened(); await rejected
    expect(f.relay.frames).toHaveLength(0)
  })
  it('cannot publish after the room route closes during opening', async () => {
    const f = fixture(), sent = f.pool.publishGuarded(reply(), () => true), rejected = expect(sent).rejects.toThrow()
    f.pool.close(); f.opened(); await rejected
    expect(f.relay.frames).toHaveLength(0)
  })
  it('does not silently fall back to an unguarded delegate', async () => {
    const f = fixture(); Object.defineProperty(f.publicPool, 'publishGuarded', { value: undefined })
    const sent = f.pool.publishGuarded(reply(), () => true), rejected = expect(sent).rejects.toThrow('unavailable')
    f.opened(); await rejected
    expect(f.relay.frames).toHaveLength(0)
  })
  it('uses the selected public delegate for an acknowledged current refusal', async () => {
    const f = fixture(), event = reply(), sent = f.pool.publishGuarded(event, () => true)
    f.opened(); await sent
    expect(f.relay.stored.map(e => e.id)).toEqual([event.id])
  })
})
