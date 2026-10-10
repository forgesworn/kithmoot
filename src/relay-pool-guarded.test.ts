import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import type { UnsignedEvent } from './identity.js'
import { NostrRelayPool } from './relay-pool.js'
import { guardedWebSocket } from './guarded-websocket.js'
import { RelayDialGate } from './relay-dial-gate.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../test/fake-socket.js'

const url = 'wss://guarded-publication.test'
const Base = FakeWebSocket as unknown as typeof WebSocket
const event = () => finalizeEvent({ kind: 20467, created_at: 1_800_000_000, tags: [], content: 'encrypted refusal' }, new Uint8Array(32).fill(3))
const authenticationFrames: string[] = []

describe('authority-sensitive relay publication', () => {
  let pool: NostrRelayPool
  beforeEach(() => { resetFakeRelays(); authenticationFrames.length = 0; vi.useFakeTimers(); pool = new NostrRelayPool([url], undefined, { websocketImplementation: Base, dialGate: new RelayDialGate() }) })
  afterEach(() => { pool.close(); vi.useRealTimers() })

  it('checks at the underlying socket write without throwing an unhandled dependency error', async () => {
    const relay = fakeRelay(url); let allowed = true
    const Socket = guardedWebSocket(Base, () => allowed), socket = new Socket(url)
    await vi.advanceTimersByTimeAsync(1)
    allowed = false
    expect(() => socket.send(JSON.stringify(['EVENT', event()]))).not.toThrow()
    expect(relay.frames).toHaveLength(0)
    socket.close()
  })

  it('publishes a current decision, then closes its temporary carrier without closing the parent', async () => {
    const relay = fakeRelay(url), reply = event()
    const send = pool.publishGuarded(reply, () => true)
    await vi.advanceTimersByTimeAsync(1); await send
    expect(relay.stored.map(e => e.id)).toEqual([reply.id])
    expect(relay.connections).toBe(0)
    expect(pool.closed).toBe(false); expect(pool.publishing).toBe(false)
  })

  it.each(['authority', 'parent close', 'relay configuration'])('cannot write after %s changes during a delayed connection', async change => {
    const relay = fakeRelay(url); relay.stallConnections = true
    let allowed = true
    const send = pool.publishGuarded(event(), () => allowed)
    const rejected = expect(send).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1)
    if (change === 'authority') allowed = false
    else if (change === 'parent close') pool.close()
    else pool.setRelays([url])
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(relay.frames).toHaveLength(0); expect(relay.stored).toHaveLength(0)
    expect(relay.stalled.size).toBe(0); expect(pool.publishing).toBe(false)
  })

  it('does not retry a previously written event after its authority expires', async () => {
    const relay = fakeRelay(url); relay.silent = true
    let allowed = true
    const send = pool.publishGuarded(event(), () => allowed), rejected = expect(send).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1)
    expect(relay.stored).toHaveLength(1)
    allowed = false
    await vi.advanceTimersByTimeAsync(30_000); await rejected
    expect(relay.stored).toHaveLength(1); expect(relay.connections).toBe(0)
    expect(pool.publishing).toBe(false)
  })

  it('closes a slower relay after another relay acknowledges instead of leaving a background retry', async () => {
    const fast = fakeRelay(url), slow = fakeRelay('wss://guarded-slow.test'); slow.silent = true
    pool.setRelays([url, slow.url])
    const sent = pool.publishGuarded(event(), () => true)
    await vi.advanceTimersByTimeAsync(1); await sent
    const before = slow.stored.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fast.stored).toHaveLength(1); expect(slow.stored).toHaveLength(before)
    expect(slow.connections).toBe(0); expect(pool.publishing).toBe(false)
  })

  class ChallengedSocket extends FakeWebSocket {
    constructor(address: string) {
      super(address)
      queueMicrotask(() => this.deliver(JSON.stringify(['AUTH', 'guarded-challenge'])))
    }
    override send(raw: string): void {
      const frame = JSON.parse(raw)
      if (frame[0] === 'AUTH') { authenticationFrames.push(raw); this.deliver(JSON.stringify(['OK', frame[1].id, true, ''])) }
      else super.send(raw)
    }
  }

  it('preserves explicit relay authentication on its guarded carrier', async () => {
    const relay = fakeRelay(url), key = new Uint8Array(32).fill(5)
    const sign = vi.fn(async (template: UnsignedEvent) => finalizeEvent(template, key))
    pool.close(); pool = new NostrRelayPool([url], undefined, { websocketImplementation: ChallengedSocket as unknown as typeof WebSocket,
      dialGate: new RelayDialGate(), authentication: [{ url, identity: { pubkey: getPublicKey(key), signEvent: sign } }] })
    const sent = pool.publishGuarded(event(), () => true)
    await vi.advanceTimersByTimeAsync(200); await sent
    expect(sign).toHaveBeenCalledOnce(); expect(sign.mock.calls[0][0].kind).toBe(22242)
    expect(authenticationFrames).toHaveLength(1)
    expect(relay.stored).toHaveLength(1)
  })

  it('withdrawn relay consent blocks a delayed signer and every room write', async () => {
    const relay = fakeRelay(url), key = new Uint8Array(32).fill(5)
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const sign = vi.fn(async (template: UnsignedEvent) => { await waiting; return finalizeEvent(template, key) })
    pool.close(); pool = new NostrRelayPool([url], undefined, { websocketImplementation: ChallengedSocket as unknown as typeof WebSocket,
      dialGate: new RelayDialGate(), authentication: [{ url, identity: { pubkey: getPublicKey(key), signEvent: sign } }] })
    const sent = pool.publishGuarded(event(), () => true), rejected = expect(sent).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1); expect(sign).toHaveBeenCalledOnce()
    pool.setAuthentication([{ url, identity: null }]); release()
    await vi.advanceTimersByTimeAsync(100); await rejected
    expect(relay.frames).toHaveLength(0); expect(relay.stored).toHaveLength(0)
    expect(authenticationFrames).toHaveLength(0)
    expect(relay.connections).toBe(0)
  })
})
