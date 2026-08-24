import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
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

  it('ignores an event that matches no filter', async () => {
    a.seed(evt(1460))

    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], (e) => seen.push(e.id))
    await settle()

    expect(seen).toEqual([])
  })
})
