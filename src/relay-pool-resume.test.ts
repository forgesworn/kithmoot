import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { matchFilters } from 'nostr-tools/filter'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NostrRelayPool, RESUME_OVERLAP_SECONDS, WIDE_REFRESH_MS, resumeFilters } from './relay-pool.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays, type FakeRelayServer } from '../test/fake-socket.js'
import { relayDials } from './relay-dial-gate.js'

// A chat log asks each relay for a month of history. A rebind of that
// subscription - after a relay closed it, dropped the socket, or the relay
// set changed - used to send the month again, every time: a relay that
// closes after answering was asked for it every fifteen seconds for as long
// as the room stayed open.

beforeAll(() => { useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket) })

const URL_A = 'wss://relay-a.test'
const URL_B = 'wss://relay-b.test'
const MONTH = 30 * 24 * 60 * 60
const HISTORY = 60
const sk = generateSecretKey()
const nowSeconds = () => Math.floor(Date.now() / 1000)

function chat(createdAt: number): Event {
  return finalizeEvent({ kind: 1460, created_at: createdAt, tags: [['d', 'room']], content: String(Math.random()) }, sk)
}

/** How many stored events `relay` was asked to send back: every chat `REQ`,
 *  matched against what it held. A replayed month shows up here. */
function eventsAskedFor(relay: FakeRelayServer): number {
  return relay.requestedFilters().filter(filters => filters.some(f => f.kinds?.includes(1460)))
    .reduce((total, filters) => total + relay.stored.filter(event => matchFilters(filters, event)).length, 0)
}

/** A relay that answers a `REQ` in full, then closes it from its side. */
function closesAfterAnswering(relay: FakeRelayServer): void {
  const receive = relay.receive.bind(relay)
  relay.receive = (socket, frame) => {
    receive(socket, frame)
    const message = JSON.parse(frame) as unknown[]
    if (message[0] === 'REQ') socket.deliver(JSON.stringify(['CLOSED', message[1], 'error: subscription ended']))
  }
}

/** A relay that answers a chat `REQ` in full, then drops the socket. */
function dropsAfterAnswering(relay: FakeRelayServer, afterMs: number): void {
  const receive = relay.receive.bind(relay)
  relay.receive = (socket, frame) => {
    receive(socket, frame)
    const message = JSON.parse(frame) as unknown[]
    if (message[0] === 'REQ' && JSON.stringify(message).includes('1460')) setTimeout(() => socket.dropped(), afterMs)
  }
}

/** A relay on a slow link: history trickles out over `overMs`, EOSE last,
 *  then the socket drops `dropAfterMs` later. */
function slowThenDrops(relay: FakeRelayServer, overMs: number, dropAfterMs: number): void {
  const receive = relay.receive.bind(relay)
  relay.receive = (socket, frame) => {
    const message = JSON.parse(frame) as unknown[]
    if (message[0] !== 'REQ' || !JSON.stringify(message).includes('1460')) { receive(socket, frame); return }
    relay.frames.push(frame)
    const filters = message.slice(2) as Parameters<typeof matchFilters>[0]
    const events = relay.stored.filter(event => matchFilters(filters, event))
    events.forEach((event, i) => setTimeout(() => socket.deliver(JSON.stringify(['EVENT', message[1], event])), Math.floor((i * overMs) / Math.max(1, events.length))))
    setTimeout(() => socket.deliver(JSON.stringify(['EOSE', message[1]])), overMs)
    setTimeout(() => socket.dropped(), overMs + dropAfterMs)
  }
}

describe('NostrRelayPool resubscription', () => {
  let a: FakeRelayServer
  let b: FakeRelayServer
  let pool: NostrRelayPool | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeRelays()
    relayDials.clear()
    a = fakeRelay(URL_A)
    b = fakeRelay(URL_B)
    // An hour apart: only the newest is inside a resumed request's overlap.
    for (let i = 0; i < HISTORY; i++) { const event = chat(nowSeconds() - i * 3600); a.seed(event); b.seed(event) }
  })

  afterEach(() => {
    pool?.close(); pool = undefined
    vi.useRealTimers()
  })

  function open(): Map<string, number> {
    pool = new NostrRelayPool([URL_A, URL_B], undefined, { reconnectJitterMs: 0 })
    const heard = new Map<string, number>()
    pool.subscribe([{ kinds: [1460], '#d': ['room'], since: nowSeconds() - MONTH, limit: 500 }], event => heard.set(event.id, (heard.get(event.id) ?? 0) + 1))
    return heard
  }

  it('does not ask a relay that closes after answering for the whole window again', async () => {
    closesAfterAnswering(a)
    const heard = open()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Resent several times, each from where it left off.
    expect(a.requestedFilters().filter(f => f[0]?.kinds?.includes(1460)).length).toBeGreaterThan(3)
    // A month each time would be HISTORY per request.
    expect(eventsAskedFor(a)).toBeLessThan(2 * HISTORY)
    expect(heard.size).toBe(HISTORY)
    expect([...heard.values()].every(n => n === 1)).toBe(true)
  })

  it('does not ask a relay that drops the socket after answering for the whole window again', async () => {
    dropsAfterAnswering(a, 3_000)
    const heard = open()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(a.attempts).toBeGreaterThan(3)
    expect(eventsAskedFor(a)).toBeLessThan(2 * HISTORY)
    expect(heard.size).toBe(HISTORY)
  })

  it('resumes from a relay whose history takes longer than the reader waits for', async () => {
    slowThenDrops(a, 12_000, 3_000)
    const heard = open()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(heard.size).toBe(HISTORY)
    const requests = a.requestedFilters().filter(f => f[0]?.kinds?.includes(1460))
    expect(requests.length).toBeGreaterThan(3)
    expect(requests.slice(1).every(f => f[0]!.since! > nowSeconds() - MONTH + 86_400)).toBe(true)
  })

  it('still hears what was published while the socket was down', async () => {
    const heard = open()
    await vi.advanceTimersByTimeAsync(1_000)
    a.stallConnections = b.stallConnections = true
    a.disconnectAll(); b.disconnectAll()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    // Missed while away; one stamped by a sender whose clock runs ten
    // minutes behind, inside the overlap.
    const missed = chat(nowSeconds()), behind = chat(nowSeconds() - 10 * 60)
    a.seed(missed); a.seed(behind)
    a.stallConnections = b.stallConnections = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard.has(missed.id)).toBe(true)
    expect(heard.has(behind.id)).toBe(true)
    // Asked from where each relay left off, less the overlap; not the month.
    const resumed = a.requestedFilters().filter(f => f[0]?.kinds?.includes(1460)).at(-1)![0]!
    expect(resumed.since).toBeGreaterThan(nowSeconds() - MONTH)
    expect(resumed.since).toBeLessThanOrEqual(nowSeconds() - RESUME_OVERLAP_SECONDS)
    expect(eventsAskedFor(a)).toBeLessThan(2 * HISTORY)
  })

  it('widens a resumed subscription again, so a long-held send published late is found', async () => {
    const heard = open()
    await vi.advanceTimersByTimeAsync(1_000)
    a.disconnectAll(); b.disconnectAll()
    await vi.advanceTimersByTimeAsync(60_000)
    // Signed two hours ago, kept by an outbox through a reload, sent now:
    // older than a resumed request's overlap.
    const late = chat(nowSeconds() - 2 * 3600)
    a.seed(late)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heard.has(late.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(WIDE_REFRESH_MS)
    expect(heard.has(late.id)).toBe(true)
    expect(heard.get(late.id)).toBe(1)
  })

  it('opens a new subscription with the full window, whatever an earlier one heard', async () => {
    open()
    await vi.advanceTimersByTimeAsync(1_000)
    const seen: string[] = []
    pool!.subscribe([{ kinds: [1460], '#d': ['room'], since: nowSeconds() - MONTH, limit: 500 }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toHaveLength(HISTORY)
  })

  it('keeps where each relay left off across a change of relays', async () => {
    open()
    await vi.advanceTimersByTimeAsync(1_000)
    const before = eventsAskedFor(a)
    pool!.setRelays([URL_A, URL_B])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(eventsAskedFor(a) - before).toBeLessThan(5)
  })

  it('does not parse or verify an event the subscription already delivered', async () => {
    b.refuseConnections = true
    open()
    await vi.advanceTimersByTimeAsync(1_000)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      b.refuseConnections = false
      relayDials.clear()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(b.requestedFilters().some(f => f[0]?.kinds?.includes(1460))).toBe(true)
      const parsedEvents = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.startsWith('["EVENT"')).length
      expect(parsedEvents).toBe(0)
    } finally { parse.mockRestore() }
  })

  it('narrows only filters that ask for a window', () => {
    const narrowed = resumeFilters([{ kinds: [1460], since: 100, limit: 500 }, { kinds: [4461] }, { kinds: [1465], since: 900 }], 500)
    expect(narrowed).toEqual([{ kinds: [1460], since: 500, limit: 500 }, { kinds: [4461] }, { kinds: [1465], since: 900 }])
  })
})
