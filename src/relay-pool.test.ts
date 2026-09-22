import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NostrRelayPool } from './relay-pool.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays, type FakeRelayServer } from '../test/fake-socket.js'
import { boundedEventVerifier } from './verify.js'

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
    vi.useRealTimers()
  })

  it('recovers a failed first connection without interrupting a healthy relay', async () => {
    vi.useFakeTimers()
    const missing = 'wss://later.test'
    pool.close()
    pool = new NostrRelayPool([URL_A, missing])
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    const healthyRequests = a.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
    const later = fakeRelay(missing)
    const missed = evt(); later.seed(missed)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(seen).toEqual([missed.id])
    expect(a.connections).toBe(1)
    expect(a.frames.filter(frame => JSON.parse(frame)[0] === 'REQ')).toHaveLength(healthyRequests)
  })

  it('recovers after a disconnected relay stalls its next handshake and delivers missed same-second events once', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A, URL_B])
    const first = evt(), missed = evt()
    expect(first.created_at).toBe(missed.created_at)
    a.seed(first); b.seed(first)
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([first.id])
    a.stallConnections = true
    a.disconnectAll()
    a.seed(missed)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(seen).toEqual([first.id])
    a.stallConnections = false
    await vi.advanceTimersByTimeAsync(11_000)
    expect(seen).toEqual([first.id, missed.id])
    expect(b.connections).toBe(1)
  })

  it('restores readers when a publish reconnects the socket before subscription recovery', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A, URL_B])
    const first = evt(), missed = evt()
    a.seed(first); b.seed(first)
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    const healthyRequests = b.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
    a.disconnectAll()
    a.seed(missed)
    // A presence heartbeat can reopen the socket before the recovery timer.
    // A connected socket does not imply that the old readers survived.
    const published = pool.publish(evt(20462))
    await vi.advanceTimersByTimeAsync(1)
    await published
    expect(pool.health()[0]!.state).toBe('connected')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(seen).toEqual([first.id, missed.id])
    expect(b.connections).toBe(1)
    expect(b.frames.filter(frame => JSON.parse(frame)[0] === 'REQ')).toHaveLength(healthyRequests)
  })

  it('does not recreate a closed subscription while its relay is unavailable', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A])
    const seen = vi.fn()
    const off = pool.subscribe([{ kinds: [20461] }], seen)
    await vi.advanceTimersByTimeAsync(1)
    a.disconnectAll()
    off()
    a.seed(evt())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.connections).toBe(0)
    expect(seen).not.toHaveBeenCalled()
    pool.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.connections).toBe(0)
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

    // Each relay's own words ride the error: the reason a room cannot start
    // is on a relay's lips, and a box that holds only drops says exactly
    // what it holds.
    await expect(pool.publish(evt())).rejects.toThrow(/every relay rejected the event \(.*blocked: this relay refuses everything.*\)/)
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

  it('retries a stalled connection handshake and delivers the same prepared event after recovery', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A])
    a.stallConnections = true
    const event = evt()
    const outcomes: unknown[] = []
    const published = pool.publish(event).then(() => outcomes.push('published'), error => outcomes.push(error))
    await vi.advanceTimersByTimeAsync(3_400)
    expect(outcomes).toEqual([])
    expect(a.stored).toEqual([])
    a.stallConnections = false
    await vi.advanceTimersByTimeAsync(5_000)
    await published
    expect(outcomes).toEqual(['published'])
    expect(a.stored.map(item => item.id)).toEqual([event.id])
  })

  it('keeps the existing retry budget when connection handshakes never recover', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A])
    a.stallConnections = true
    const failure = expect(pool.publish(evt())).rejects.toThrow(/no relay could be reached in time/)
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
  })

  it('reopens a failed connection handshake and publishes once when it recovers', async () => {
    vi.useFakeTimers()
    const laterUrl = 'wss://later.test'
    pool.close()
    pool = new NostrRelayPool([laterUrl])
    const event = evt()
    const published = pool.publish(event)
    await vi.advanceTimersByTimeAsync(1)
    const later = fakeRelay(laterUrl)
    await vi.advanceTimersByTimeAsync(1_000)
    await published
    expect(later.stored.map(item => item.id)).toEqual([event.id])
  })

  it('does not retry an explicit refusal that quotes the connection timeout wording', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A])
    const original = a.receive.bind(a)
    let attempts = 0
    a.receive = (socket, frame) => {
      const message = JSON.parse(frame)
      if (message[0] !== 'EVENT') return original(socket, frame)
      attempts++
      socket.deliver(JSON.stringify(['OK', message[1].id, false, 'connection failure: connection timed out']))
    }
    const failure = expect(pool.publish(evt())).rejects.toThrow(/every relay rejected the event/)
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    expect(attempts).toBe(1)
  })

  it('does not retry an explicit refusal that quotes the connection failed wording', async () => {
    vi.useFakeTimers()
    pool.close()
    pool = new NostrRelayPool([URL_A])
    const original = a.receive.bind(a)
    let attempts = 0
    a.receive = (socket, frame) => {
      const message = JSON.parse(frame)
      if (message[0] !== 'EVENT') return original(socket, frame)
      attempts++
      socket.deliver(JSON.stringify(['OK', message[1].id, false, 'connection failure: connection failed']))
    }
    const failure = expect(pool.publish(evt())).rejects.toThrow(/every relay rejected the event/)
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    expect(attempts).toBe(1)
  })

  it('retries a relay whose publish times out, and resolves once it recovers', async () => {
    // A joiner's socket opened while the door was showing goes half-open in
    // the background: `send()` succeeds into the void and no `OK` ever
    // comes back. The retry has to notice, reopen just that connection, and
    // try again rather than leaving the whole publish to fail.
    vi.useFakeTimers()
    a.silent = true
    const event = evt()
    const published = pool.publish(event)
    await vi.advanceTimersByTimeAsync(4_400) // AbstractRelay's own publish timeout
    expect(pool.health()[0]).toMatchObject({ lastError: 'Publish timed out' })
    a.silent = false // the reopened connection behaves normally
    await vi.advanceTimersByTimeAsync(1_000) // first retry backoff
    await published
    expect(a.stored.map(e => e.id)).toContain(event.id)
    expect(pool.health()[0]).toMatchObject({ state: 'connected', lastError: undefined })
  })

  it('resolves as soon as one relay acknowledges, while a silent relay keeps retrying behind it', async () => {
    // Before this, a publish waited for every relay to finish - including a
    // half-open one's own retries, at up to ~13s. A caller only ever needed
    // to know the event reached somewhere.
    vi.useFakeTimers()
    a.silent = true
    const event = evt()
    const published = pool.publish(event)
    // b's OK arrives on the next microtask; nothing here advances anywhere
    // near a's 4.4s publish timeout, so a resolved `published` at this point
    // is the proof this did not wait for a at all.
    await vi.advanceTimersByTimeAsync(1)
    await published
    expect(b.stored.map(e => e.id)).toContain(event.id)
    // a's socket accepted the send (it stores every event, silent or not -
    // that is what makes it a stand-in for a half-open socket) but never
    // sent an `OK`, so this publish did not - and could not - wait for it:
    // no timeout mark has landed yet.
    expect(pool.health()[0]?.lastError).toBeUndefined()
    // a is still retrying in the background - let it recover and confirm the
    // health mark catches up, with no unhandled rejection along the way.
    await vi.advanceTimersByTimeAsync(4_400)
    expect(pool.health()[0]).toMatchObject({ lastError: 'Publish timed out' })
    a.silent = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pool.health()[0]).toMatchObject({ state: 'connected', lastError: undefined })
  })

  it('rejects with timeout wording, not rejection wording, when every relay only ever times out', async () => {
    vi.useFakeTimers()
    a.silent = true
    b.silent = true
    const failure = expect(pool.publish(evt())).rejects.toThrow(/no relay could be reached in time/)
    // Retries for as long as the 20s per-relay budget allows, each preceded
    // by AbstractRelay's own timeout: comfortably more than two rounds.
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
  })

  it('does not retry an explicit OK false', async () => {
    a.rejectPublishes = true
    b.rejectPublishes = true
    const event = evt()
    await expect(pool.publish(event)).rejects.toThrow(/every relay rejected the event/)
    // No reconnection attempt: an explicit refusal answered, so the socket
    // it answered on is not suspect.
    expect(a.connections).toBe(1)
    expect(b.connections).toBe(1)
  })

  it('probe reconnects a relay whose socket has gone silent, and its subscription hears events again', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    a.silent = true
    const missed = evt()
    a.seed(missed)
    const probed = pool.probe(3_000)
    // The reopened socket answers normally; a relay that has genuinely gone
    // quiet stays silent, so this has to happen before the probe's own
    // timeout decides the connection is dead and reopens it.
    await vi.advanceTimersByTimeAsync(2_900)
    a.silent = false
    await vi.advanceTimersByTimeAsync(200)
    await probed
    // The reconnect resubscribes, and a fresh `REQ` replays whatever the
    // relay holds - including what arrived while the old socket sat silent.
    expect(seen).toEqual([missed.id])
  })

  it('leaves a healthy relay and its subscriptions untouched when another relay is reconnected by probe', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    const healthyRequests = b.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
    a.silent = true
    const probed = pool.probe(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await probed
    // b answers its own probe round trip (one more REQ, immediately closed)
    // but is never reconnected: no new socket, no resubscribe.
    expect(b.connections).toBe(1)
    expect(b.frames.filter(frame => JSON.parse(frame)[0] === 'REQ')).toHaveLength(healthyRequests + 1)
    // b never went near reconnection, so its live subscription just keeps
    // hearing new events, and a's own retries (still silent) do not stop
    // the publish resolving on b's account.
    const stillHeard = evt()
    const published = pool.publish(stillHeard)
    await vi.advanceTimersByTimeAsync(4_400 + 1_000 + 4_400 + 3_000 + 4_400)
    await published
    expect(seen).toEqual([stillHeard.id])
  })
})

describe('boundedEventVerifier', () => {
  it('verifies an exact relay replay once', () => {
    const verify = vi.fn(() => true)
    const cached = boundedEventVerifier(8, verify)
    const event = evt()

    expect(cached(event)).toBe(true)
    expect(cached(structuredClone(event))).toBe(true)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('does not transfer a verdict to changed signed fields with the same id', () => {
    const verify = vi.fn((event: Event) => event.content === 'x')
    const cached = boundedEventVerifier(8, verify)
    const event = evt()

    expect(cached(event)).toBe(true)
    expect(cached({ ...event, content: 'changed' })).toBe(false)
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('evicts old verdicts at its fixed bound', () => {
    const verify = vi.fn(() => true)
    const cached = boundedEventVerifier(1, verify)
    const first = evt()

    expect(cached(first)).toBe(true)
    expect(cached(evt())).toBe(true)
    expect(cached(first)).toBe(true)
    expect(verify).toHaveBeenCalledTimes(3)
  })
})
