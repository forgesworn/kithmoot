import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { BrowserRoomPool } from './browser-room-pool.js'
import { NostrRelayPool, type RelayTransport } from '../../src/relay-pool.js'
import type { RoomConsent } from './browser-room-consent.js'
import { RelayDialGate } from '../../src/relay-dial-gate.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays } from '../../test/fake-socket.js'

const url = 'wss://guarded-room-route.test'
const reply = (content = 'encrypted refusal') => finalizeEvent({ kind: 20467, created_at: 1_800_000_000, tags: [], content }, new Uint8Array(32).fill(3))
const pools: BrowserRoomPool[] = []
afterEach(() => { for (const p of pools.splice(0)) p.close() })

function fixture() {
  resetFakeRelays()
  const relay = fakeRelay(url)
  let opened!: () => void
  const gate = new Promise<void>(resolve => { opened = resolve })
  let released = 0
  const publicPool = new NostrRelayPool([url], undefined, { websocketImplementation: FakeWebSocket as unknown as typeof WebSocket, dialGate: new RelayDialGate() })
  const pool = new BrowserRoomPool({ room: 'a'.repeat(64), account: () => undefined,
    store: { all: async () => [] }, barrier: { listen: () => () => {}, publicLease: async () => { await gate; return async () => { released++ } } },
    publicPool: () => publicPool, privatePool: async () => { throw new Error('Unexpected private route') } })
  pools.push(pool)
  return { pool, publicPool, relay, opened, released: () => released }
}

function privateFixture(options: { throwOnStop?: boolean; synchronousEose?: boolean } = {}) {
  const room = 'a'.repeat(64), owner = 'b'.repeat(64), eventUrl = 'wss://paired-box.test/events'
  let account: string | undefined = owner, now = 1_800_000_000, change!: () => void
  const consent: RoomConsent = { account: owner, room, box: { routeId: 'owned-fixture-route', eventUrl }, device: 'c'.repeat(64), scopes: [room], aliases: [], expires: now + 60, phase: 'active', grants: [] }
  let receive!: Parameters<RelayTransport['subscribe']>[1], eose!: () => void, ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  let stopped = 0, subscribed = 0, publicCreated = 0, closed = 0, released = 0
  const delegate: RelayTransport = {
    publish: async () => {}, close: () => { closed++ },
    subscribe: (_filters, onEvent, onEose) => {
      subscribed++; receive = onEvent; eose = onEose!; ready()
      if (options.synchronousEose) onEose?.()
      return () => { stopped++; if (options.throwOnStop) throw new Error('Link route closed before CLOSE') }
    },
  }
  const pool = new BrowserRoomPool({ room, account: () => account, now: () => now,
    store: { all: async () => [consent] }, barrier: { listen: callback => { change = callback; return () => {} }, publicLease: async () => async () => { released++ } },
    publicPool: () => { publicCreated++; throw new Error('Unexpected public route') }, privatePool: async () => delegate })
  pools.push(pool)
  return { pool, eventUrl, started, receive: (event: ReturnType<typeof reply>) => receive(event), eose: () => eose(), change: () => change(),
    account: (value: string) => { account = value }, expire: () => { now += 61 }, counts: () => ({ stopped, subscribed, publicCreated }),
    teardown: () => ({ closed, released }) }
}

describe('private one-shot history ownership', () => {
  it('keeps only its bounded prefix and cancels on overflow', async () => {
    const f = privateFixture(), first = reply('first'), second = reply('second')
    const pending = f.pool.query(f.eventUrl, [{ kinds: [20467] }], 8000, 1)
    await f.started; f.receive(first); f.receive(second); f.eose()
    expect(await pending).toEqual({ events: [first], complete: false })
    expect(f.counts()).toEqual({ stopped: 1, subscribed: 1, publicCreated: 0 })
  })

  it.each(['account', 'expiry', 'route', 'close'] as const)('cannot complete after its %s changes', async reason => {
    const f = privateFixture(), pending = f.pool.query(f.eventUrl, [{ kinds: [20467] }], 8000, 1)
    await f.started
    if (reason === 'account') f.account('d'.repeat(64))
    if (reason === 'expiry') f.expire()
    if (reason === 'route') f.change()
    if (reason === 'close') f.pool.close()
    f.eose()
    expect(await pending).toEqual({ events: [], complete: false })
    expect(f.counts()).toEqual({ stopped: 1, subscribed: 1, publicCreated: 0 })
  })

  it('accepts its current native end-of-history response', async () => {
    const f = privateFixture(), pending = f.pool.query(f.eventUrl, [{ kinds: [20467] }], 8000, 1)
    await f.started; f.eose()
    expect(await pending).toEqual({ events: [], complete: true })
    expect(f.counts()).toEqual({ stopped: 1, subscribed: 1, publicCreated: 0 })
  })

  it('settles an EOSE as incomplete when unsubscribe throws, preserving its known prefix', async () => {
    const options = { throwOnStop: true }, f = privateFixture(options), first = reply('known prefix')
    try {
      const pending = f.pool.query(f.eventUrl, [{}])
      await f.started; f.receive(first)
      expect(() => f.eose()).not.toThrow()
      expect(await pending).toEqual({ events: [first], complete: false })
      expect(f.counts().stopped).toBe(1)
    } finally { options.throwOnStop = false; f.pool.close() }
  })

  it('waits for the returned unsubscribe before accepting synchronous EOSE', async () => {
    const f = privateFixture({ throwOnStop: true, synchronousEose: true })
    expect(await f.pool.query(f.eventUrl, [{}])).toEqual({ events: [], complete: false })
    expect(f.counts().stopped).toBe(1)
  })

  it('accepts synchronous EOSE after successful unsubscribe', async () => {
    const f = privateFixture({ synchronousEose: true })
    expect(await f.pool.query(f.eventUrl, [{}])).toEqual({ events: [], complete: true })
    expect(f.counts().stopped).toBe(1)
  })

  it('settles a timeout even when unsubscribe throws', async () => {
    vi.useFakeTimers()
    const options = { throwOnStop: true }, f = privateFixture(options)
    try {
      const pending = f.pool.query(f.eventUrl, [{}], 25)
      await f.started
      await vi.advanceTimersByTimeAsync(25)
      expect(await pending).toEqual({ events: [], complete: false })
      expect(f.counts().stopped).toBe(1)
    } finally { options.throwOnStop = false; f.pool.close(); vi.useRealTimers() }
  })

  it.each(['route', 'close'] as const)('settles all queries and closes the old delegate on %s despite throwing unsubscribes', async reason => {
    const options = { throwOnStop: true }, f = privateFixture(options)
    try {
      // Keep a live subscription as well as two independently owned queries.
      f.pool.subscribe([{}], () => {})
      const pending = [f.pool.query(f.eventUrl, [{}]), f.pool.query(f.eventUrl, [{}])]
      const results = Promise.all(pending)
      void results.catch(() => {})
      await vi.waitFor(() => expect(f.counts().subscribed).toBe(3))
      expect(() => reason === 'route' ? f.change() : f.pool.close()).not.toThrow()
      expect(await results).toEqual([{ events: [], complete: false }, { events: [], complete: false }])
      expect(f.counts()).toEqual({ stopped: 3, subscribed: 3, publicCreated: 0 })
      expect(f.teardown()).toEqual({ closed: 1, released: 1 })
    } finally { options.throwOnStop = false; f.pool.close() }
  })
})

describe('guarded room route publication', () => {
  it('closes the public delegate before releasing its lease when a read unsubscribe throws', async () => {
    const f = fixture(), subscribe = f.publicPool.subscribe.bind(f.publicPool)
    vi.spyOn(f.publicPool, 'subscribe').mockImplementation((...args) => {
      const stop = subscribe(...args)
      return () => { stop(); throw new Error('CLOSE failed') }
    })
    const closeDelegate = f.publicPool.close.bind(f.publicPool)
    const close = vi.spyOn(f.publicPool, 'close').mockImplementation(() => {
      expect(f.released()).toBe(0)
      closeDelegate()
    })
    f.pool.subscribe([{}], () => {}); f.opened()
    await vi.waitFor(() => expect(f.relay.requestedFilters()).toHaveLength(1))
    expect(() => f.pool.close()).not.toThrow()
    expect(close).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(f.released()).toBe(1))
    expect(f.relay.connections).toBe(0)
  })
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
