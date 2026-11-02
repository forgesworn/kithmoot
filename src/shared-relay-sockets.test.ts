import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { NostrRelayPool } from './relay-pool.js'
import { RelayDialGate } from './relay-dial-gate.js'
import { SharedRelaySockets } from './shared-relay-sockets.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../test/fake-socket.js'

const url = 'wss://shared-sockets.test'
const Base = FakeWebSocket as unknown as typeof WebSocket
const secret = new Uint8Array(32).fill(7)
let serial = 0
const note = (kind: number, content = `note ${++serial}`): Event =>
  finalizeEvent({ kind, created_at: 1_800_000_000 + serial, tags: [], content }, secret)

describe('room pools sharing real sockets', () => {
  let shared: SharedRelaySockets
  let gate: RelayDialGate
  const pools: NostrRelayPool[] = []
  const pool = (options: ConstructorParameters<typeof NostrRelayPool>[2] = {}) => {
    const made = new NostrRelayPool([url], undefined, { websocketImplementation: Base, dialGate: gate, sharedSockets: shared, ...options })
    pools.push(made); return made
  }
  const settle = () => vi.advanceTimersByTimeAsync(1)

  beforeEach(() => {
    resetFakeRelays(); vi.useFakeTimers()
    gate = new RelayDialGate()
    shared = new SharedRelaySockets(Base, { lingerMs: 1_000 })
  })
  afterEach(() => { for (const made of pools.splice(0)) made.close(); vi.useRealTimers() })

  it('puts two pools on one socket and routes each its own events under its own subscription id', async () => {
    const relay = fakeRelay(url)
    const a = pool(), b = pool()
    const heardA: number[] = [], heardB: number[] = []
    a.subscribe([{ kinds: [1001] }], event => heardA.push(event.kind))
    b.subscribe([{ kinds: [1002] }], event => heardB.push(event.kind))
    await settle()
    expect(relay.connections).toBe(1)
    await a.publish(note(1002)); await b.publish(note(1001))
    await settle()
    expect(heardA).toEqual([1001]); expect(heardB).toEqual([1002])
    // The relay never saw the pools' own ids, which collide.
    const ids = relay.frames.map(frame => JSON.parse(frame) as unknown[]).filter(m => m[0] === 'REQ').map(m => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => typeof id === 'string' && id.startsWith('k'))).toBe(true)
  })

  it('closes only the closed pool\'s subscriptions and keeps the socket for the other', async () => {
    const relay = fakeRelay(url)
    const a = pool(), b = pool()
    const heardB: number[] = []
    a.subscribe([{ kinds: [1003] }], () => {})
    b.subscribe([{ kinds: [1003] }], event => heardB.push(event.kind))
    await settle()
    a.close()
    await settle()
    expect(relay.connections).toBe(1)
    expect(relay.closedSubscriptions()).toHaveLength(1)
    await b.publish(note(1003)); await settle()
    expect(heardB).toEqual([1003])
  })

  it('answers each publish to the pool that sent it', async () => {
    const relay = fakeRelay(url)
    const a = pool(), b = pool()
    await Promise.all([a.publish(note(1004)), b.publish(note(1005))])
    expect(relay.stored.map(event => event.kind).sort()).toEqual([1004, 1005])
    expect(relay.connections).toBe(1)
  })

  it('opens another socket rather than pass the subscription budget, and delivers on both', async () => {
    shared = new SharedRelaySockets(Base, { subscriptionsPerSocket: 2, lingerMs: 1_000 })
    const relay = fakeRelay(url)
    const a = pool(), b = pool()
    const heard: string[] = []
    a.subscribe([{ kinds: [1010] }], () => heard.push('a10'))
    a.subscribe([{ kinds: [1011] }], () => heard.push('a11'))
    b.subscribe([{ kinds: [1012] }], () => heard.push('b12'))
    await settle()
    expect(relay.connections).toBe(2)
    expect(shared.connections(url)).toBe(2)
    await a.publish(note(1012)); await b.publish(note(1010)); await a.publish(note(1011))
    await settle()
    expect(heard.sort()).toEqual(['a10', 'a11', 'b12'])
  })

  it('brings every pool back onto one socket after the relay drops it', async () => {
    const relay = fakeRelay(url)
    const a = pool({ reconnectJitterMs: 0 }), b = pool({ reconnectJitterMs: 0 })
    const heard: string[] = []
    a.subscribe([{ kinds: [1020] }], () => heard.push('a'))
    b.subscribe([{ kinds: [1020] }], () => heard.push('b'))
    await settle()
    relay.disconnectAll()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(relay.connections).toBe(1)
    relay.seed(note(1020))
    const fresh = note(1020)
    await a.publish(fresh); await settle()
    expect(heard.filter(who => who === 'a').length).toBeGreaterThan(0)
    expect(heard.filter(who => who === 'b').length).toBeGreaterThan(0)
  })

  it('closes a socket nobody uses after the linger, and reuses it within it', async () => {
    const relay = fakeRelay(url)
    const a = pool()
    a.subscribe([{ kinds: [1030] }], () => {})
    await settle()
    a.close(); await vi.advanceTimersByTimeAsync(500)
    expect(relay.connections).toBe(1)
    const b = pool()
    b.subscribe([{ kinds: [1030] }], () => {})
    await settle()
    expect(relay.attempts).toBe(1)
    b.close(); await vi.advanceTimersByTimeAsync(1_500)
    expect(relay.connections).toBe(0)
  })

  it('keeps a pool that authenticates on a socket of its own', async () => {
    const relay = fakeRelay(url)
    const identity = { pubkey: getPublicKey(secret), signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secret) }
    const a = pool(), b = pool({ authentication: [{ url, identity }] })
    a.subscribe([{ kinds: [1040] }], () => {})
    b.subscribe([{ kinds: [1040] }], () => {})
    await settle()
    expect(relay.connections).toBe(2)
    expect(shared.connections(url)).toBe(1)
  })

  it('condemns a quiet socket for every pool on it, and spares one that is talking', async () => {
    const relay = fakeRelay(url)
    const a = pool(), b = pool()
    a.subscribe([{ kinds: [1050] }], () => {})
    b.subscribe([{ kinds: [1050] }], () => {})
    await settle()
    const heard = shared.lastHeard(url)
    expect(heard).toBeGreaterThan(0)
    shared.condemnQuiet(url, heard)
    expect(shared.connections(url)).toBe(1)
    shared.condemnQuiet(url, heard + 1)
    expect(shared.connections(url)).toBe(0)
    await settle()
    expect(relay.connections).toBe(0)
  })

  it('checks a pool\'s own guard above the shared socket, so it gates that pool alone', async () => {
    const relay = fakeRelay(url)
    let allowed = true
    const a = pool({ sendGuard: () => allowed }), b = pool()
    a.subscribe([{ kinds: [1060] }], () => {})
    await settle()
    allowed = false
    const refused = expect(a.publish(note(1061))).rejects.toThrow()
    const sent = b.publish(note(1062))
    await vi.advanceTimersByTimeAsync(30_000)
    await refused; await sent
    expect(relay.stored.map(event => event.kind)).toEqual([1062])
    // The refused pool's silence did not get the socket condemned.
    expect(relay.attempts).toBe(1)
  })

  it('probes a full socket on that socket rather than opening another', async () => {
    shared = new SharedRelaySockets(Base, { subscriptionsPerSocket: 2, lingerMs: 1_000 })
    const relay = fakeRelay(url)
    const a = pool({ probeQuietMs: 0 })
    a.subscribe([{ kinds: [1080] }], () => {})
    a.subscribe([{ kinds: [1081] }], () => {})
    await settle()
    expect(relay.connections).toBe(1)
    await a.probe()
    expect(relay.connections).toBe(1)
    expect(relay.frames.some(frame => frame.includes('"ids"'))).toBe(true)
  })

  it('stops placing subscriptions on a socket the relay says has too many', async () => {
    const relay = fakeRelay(url)
    const a = pool()
    a.subscribe([{ kinds: [1070] }], () => {})
    a.subscribe([{ kinds: [1071] }], () => {})
    await settle()
    relay.notice('ERROR: too many concurrent REQs')
    const b = pool()
    b.subscribe([{ kinds: [1072] }], () => {})
    await settle()
    expect(shared.connections(url)).toBe(2)
  })
})
