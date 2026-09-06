import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NostrRelayPool } from './relay-pool.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays, type FakeRelayServer } from '../test/fake-socket.js'

// Must happen before any pool is constructed: SimplePool reads the websocket
// implementation once, in its constructor.
beforeAll(() => {
  useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket)
})

const URL_A = 'wss://relay-a.test'
const URL_B = 'wss://relay-b.test'

function evt(kind = 20461, tags: string[][] = []): Event {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content: 'x' },
    generateSecretKey(),
  )
}

/** Let the fake sockets connect and every queued frame be delivered. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('NostrRelayPool', () => {
  let a: FakeRelayServer
  let b: FakeRelayServer
  let pool: NostrRelayPool

  beforeEach(() => {
    resetFakeRelays()
    a = fakeRelay(URL_A)
    b = fakeRelay(URL_B)
    pool = new NostrRelayPool([URL_A, URL_B])
  })

  afterEach(() => {
    pool.close()
  })

  it('refuses to be built with no relays at all', () => {
    expect(() => new NostrRelayPool([])).toThrow(/at least one relay/)
  })

  it('publishes to every relay, not to whichever one answers first', async () => {
    // No relay is load-bearing, which is the entire point: an event that
    // reached only one of them is an event that disappears when that relay
    // does.
    const event = evt()
    await pool.publish(event)

    expect(a.stored.map((e) => e.id)).toEqual([event.id])
    expect(b.stored.map((e) => e.id)).toEqual([event.id])
  })

  it('succeeds when one relay accepts and the other refuses', async () => {
    b.rejectPublishes = true
    const event = evt()

    await expect(pool.publish(event)).resolves.toBeUndefined()
    expect(a.stored.map((e) => e.id)).toEqual([event.id])
  })

  it('fails only when every relay refuses', async () => {
    a.rejectPublishes = true
    b.rejectPublishes = true

    await expect(pool.publish(evt())).rejects.toThrow(/every relay rejected/)
  })

  it('hears an event once, however many relays deliver it', async () => {
    // Publishing everywhere means being told everything twice, and a caller
    // of `RelayTransport` is promised it hears each event once. `nostr-tools`
    // happens to de-duplicate within a subscription too, so this pins the
    // contract rather than one line of ours - deleting our own `seen` set
    // leaves this green. Which is the point: the day the dependency stops
    // doing it, this is what notices.
    const event = evt()
    a.seed(event)
    b.seed(event)

    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    await settle()

    expect(seen).toEqual([event.id])
  })

  it('fans every filter out to every relay, and ORs them', async () => {
    // `subscribeMany` takes one filter per relay, so a multi-filter subscribe
    // has to be fanned out and regrouped - otherwise a second filter is
    // silently dropped and the room goes deaf to a whole kind. This is the
    // piece most likely to break on a version bump.
    const roster = evt(20461)
    const chat = evt(1460)
    a.seed(roster)
    b.seed(chat)

    const seen: number[] = []
    pool.subscribe([{ kinds: [20461] }, { kinds: [1460] }], (e) => seen.push(e.kind))
    await settle()

    expect(seen.sort()).toEqual([1460, 20461])
    // Both filters reached both relays, grouped into one REQ each.
    for (const relay of [a, b]) {
      expect(relay.requestedFilters()).toHaveLength(1)
      expect(relay.requestedFilters()[0]).toEqual([{ kinds: [20461] }, { kinds: [1460] }])
    }
  })

  it('delivers events published while the subscription is open', async () => {
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    await settle()

    const event = evt()
    await pool.publish(event)
    await settle()

    expect(seen).toEqual([event.id])
  })

  it('stops delivering, and closes the subscription on every relay, once unsubscribed', async () => {
    const seen: string[] = []
    const unsub = pool.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    await settle()

    unsub()
    await settle()

    expect(a.closedSubscriptions()).toHaveLength(1)
    expect(b.closedSubscriptions()).toHaveLength(1)

    await pool.publish(evt())
    await settle()
    expect(seen).toEqual([])
  })

  it('refuses to publish or subscribe once closed', async () => {
    pool.close()

    await expect(pool.publish(evt())).rejects.toThrow(/pool is closed/)
    expect(() => pool.subscribe([{ kinds: [20461] }], () => {})).toThrow(/pool is closed/)
  })

  it('re-opens its subscriptions when a relay drops the socket', async () => {
    // A conference room is nothing but long-lived subscriptions, and a relay
    // restart, a laptop lid, or a phone crossing from Wi-Fi to mobile closes
    // every one of them from the far side. Nothing tells the person; the
    // room simply stops hearing anybody new and, after the presence
    // timeout, everybody else stops hearing them.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const tick = () => vi.advanceTimersByTimeAsync(0)
    // Somebody else on the same relay, whose publishes prove whether our
    // subscription is live there - a pool of one relay, so nothing can be
    // heard by way of another.
    const mine = new NostrRelayPool([URL_A])
    const theirs = new NostrRelayPool([URL_A])
    try {
      const seen: string[] = []
      mine.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
      await tick()

      const before = evt()
      await theirs.publish(before)
      await tick()
      expect(seen).toEqual([before.id])

      a.disconnectAll()
      await tick()
      expect(a.connections).toBe(0)

      // nostr-tools waits out a backoff before dialling again; give it
      // several, not one, so the test pins the behaviour and not the number.
      await vi.advanceTimersByTimeAsync(60_000)

      const after = evt()
      await theirs.publish(after)
      await tick()
      expect(seen).toEqual([before.id, after.id])
    } finally {
      mine.close()
      theirs.close()
      vi.useRealTimers()
    }
  })

  it('enforces read and write permissions independently', async () => {
    pool.setRelays([{ url: URL_A, read: true, write: false }, { url: URL_B, read: false, write: true }])
    const received = evt()
    a.seed(received)
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await settle()
    const sent = evt()
    await pool.publish(sent)
    expect(seen).toEqual([received.id])
    expect(a.stored.map(event => event.id)).toEqual([received.id])
    expect(b.stored.map(event => event.id)).toEqual([sent.id])
    expect(b.requestedFilters()).toHaveLength(0)
    pool.setRelays([{ url: URL_A, read: true, write: false }])
    await expect(pool.publish(evt())).rejects.toThrow('no writable relay')
  })

  it('moves live subscriptions to added relays, closes removed sockets and does not replay duplicates', async () => {
    pool.setRelays([URL_A])
    const first = evt(); a.seed(first); b.seed(first)
    const second = evt(); b.seed(second)
    const seen: string[] = []
    const off = pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await settle()
    expect(seen).toEqual([first.id])
    pool.setRelays([URL_B])
    await settle()
    expect(a.connections).toBe(0)
    expect(seen).toEqual([first.id, second.id])
    await pool.publish(evt())
    await settle()
    expect(a.stored).toHaveLength(1)
    expect(seen).toHaveLength(3)
    pool.reconnect(); await settle()
    expect(seen).toHaveLength(3)
    off(); await settle()
    expect(b.closedSubscriptions().length).toBeGreaterThan(0)
  })

  it('reports real connections and accepted or rejected writes separately', async () => {
    expect(pool.health().every(relay => relay.state === 'idle')).toBe(true)
    pool.subscribe([{ kinds: [20461] }], () => {})
    await settle()
    expect(pool.health().every(relay => relay.state === 'connected')).toBe(true)
    b.rejectPublishes = true
    await pool.publish(evt())
    const [first, second] = pool.health()
    expect(first).toMatchObject({ state: 'connected', lastPublishedAt: expect.any(Number), publishLatencyMs: expect.any(Number) })
    expect(second).toMatchObject({ state: 'connected', lastError: expect.stringContaining('publish') })
    expect(second!.lastPublishedAt).toBeUndefined()
    a.disconnectAll()
    expect(pool.health()[0]!.state).toBe('disconnected')
    pool.close()
    expect(pool.health().every(relay => relay.state === 'closed')).toBe(true)
  })

  it('refuses invalid URLs and duplicate permissions without altering current connections', () => {
    for (const url of ['https://relay.test', 'ws://public.test', 'wss://user:secret@relay.test', 'wss://relay.test/#key']) {
      expect(() => pool.setRelays([url])).toThrow()
    }
    expect(() => pool.setRelays([URL_A, `${URL_A}/`])).toThrow('already')
    expect(() => pool.setRelays([{ url: URL_A, read: false, write: false }])).toThrow('reading or writing')
    expect(pool.configuration().map(relay => relay.url)).toEqual([`${URL_A}/`, `${URL_B}/`])
  })

  it('ignores an event that matches no filter', async () => {
    a.seed(evt(1460))

    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    await settle()

    expect(seen).toEqual([])
  })
})
