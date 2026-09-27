import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NostrRelayPool } from './relay-pool.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays, type FakeRelayServer } from '../test/fake-socket.js'

// The failures public relays were seen to have in September 2026, one at a
// time, beside a relay that behaves: a relay that accepts the socket and then
// never answers, one that refuses every connection, one that says OK to a
// write and keeps nothing, and one that pushes junk.

beforeAll(() => {
  useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket)
})

const GOOD = 'wss://good.test'
const BAD = 'wss://bad.test'

function evt(kind = 20461, content = 'x', key = generateSecretKey()): Event {
  return finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [], content }, key)
}

describe('NostrRelayPool with a bad relay beside a good one', () => {
  let good: FakeRelayServer
  let bad: FakeRelayServer
  let pool: NostrRelayPool

  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeRelays()
    good = fakeRelay(GOOD)
    bad = fakeRelay(BAD)
  })

  afterEach(() => {
    pool?.close()
    vi.useRealTimers()
  })

  it('finishes loading history within the first deadline when one relay connects and never answers', async () => {
    bad.silent = true
    pool = new NostrRelayPool([GOOD, BAD])
    const stored = evt(); good.seed(stored)
    const seen: string[] = []
    let eoseAt: number | undefined
    const start = Date.now()
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id), () => { eoseAt ??= Date.now() - start })
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([stored.id])
    await vi.advanceTimersByTimeAsync(30_000)
    // nostr-tools' own 8s wait is the deadline a reader was promised; the
    // resend watchdog must not stretch it.
    expect(eoseAt).toBeDefined()
    expect(eoseAt!).toBeLessThanOrEqual(8_000)
  })

  it('keeps delivering live events from the good relay while the hung one is resent to', async () => {
    bad.silent = true
    pool = new NostrRelayPool([GOOD, BAD])
    const other = new NostrRelayPool([GOOD])
    try {
      const seen: string[] = []
      pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
      await vi.advanceTimersByTimeAsync(12_000)
      const live = evt()
      await other.publish(live)
      await vi.advanceTimersByTimeAsync(1)
      expect(seen).toEqual([live.id])
    } finally { other.close() }
  })

  it('counts a publish as sent the moment the good relay accepts, with a hung relay beside it', async () => {
    bad.silent = true
    pool = new NostrRelayPool([GOOD, BAD])
    const event = evt(1460)
    const published = pool.publish(event)
    await vi.advanceTimersByTimeAsync(1)
    await expect(published).resolves.toBeUndefined()
    expect(good.stored.map(e => e.id)).toEqual([event.id])
  })

  // Two minutes of a presence heartbeat every 20 seconds, with two readers.
  // Each publish's retries and the rebinds they trigger used to dial on their
  // own schedules: 101 dials to a refusing relay, 19 to a hung one. The
  // shared backoff, cleared only by an answer, holds each to about one dial
  // per 8 seconds.
  for (const [failure, mode] of [
    ['refuses every connection', 'refuseConnections'],
    ['connects and never answers', 'silent'],
  ] as const) {
    it(`does not storm a relay that ${failure}`, async () => {
      bad[mode] = true
      pool = new NostrRelayPool([GOOD, BAD])
      pool.subscribe([{ kinds: [20461] }], () => {})
      pool.subscribe([{ kinds: [20462] }], () => {})
      let failures = 0
      for (let second = 0; second < 120; second += 20) {
        pool.publish(evt()).catch(() => { failures++ })
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(failures).toBe(0)
      expect(bad.attempts).toBeLessThanOrEqual(20)
      expect(good.connections).toBe(1)
      expect(pool.health().find(r => r.url === 'wss://bad.test/')!.lastError).toBeTruthy()
    })
  }

  it('does not storm a relay that drops every socket as it opens', async () => {
    // Publishes alone: nostr-tools leaves a REQ fired onto such a socket as
    // an unhandled rejection of its own, noise here and not this pool's.
    // A publish that lost that race was taken for the relay saying no, so
    // it was never retried and never counted against the relay: 34 dials.
    bad.dropOnOpen = true
    pool = new NostrRelayPool([GOOD, BAD])
    for (let second = 0; second < 120; second += 20) {
      await pool.publish(evt())
      await vi.advanceTimersByTimeAsync(20_000)
    }
    expect(bad.attempts).toBeLessThanOrEqual(20)
    expect(pool.health().find(r => r.url === 'wss://bad.test/')!.lastError).not.toMatch(/rejected/)
  })

  it('backs off a refusing relay and reaches it again once it comes back', async () => {
    bad.refuseConnections = true
    pool = new NostrRelayPool([GOOD, BAD])
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(60_000)
    bad.refuseConnections = false
    const missed = evt(); bad.seed(missed)
    // Recovery's own 15s spacing, plus at most one 15s backoff.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(seen).toEqual([missed.id])
    expect(pool.health().find(r => r.url === 'wss://bad.test/')).toMatchObject({ state: 'connected', lastError: undefined })
  })

  it('still delivers a publish to a relay that refused briefly and then came back', async () => {
    bad.refuseConnections = true
    good.rejectPublishes = true
    pool = new NostrRelayPool([GOOD, BAD])
    const event = evt(1460)
    const published = pool.publish(event)
    await vi.advanceTimersByTimeAsync(5_000)
    bad.refuseConnections = false
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(published).resolves.toBeUndefined()
    expect(bad.stored.map(e => e.id)).toEqual([event.id])
  })

  it('reports an unreachable relay as unreachable, not as a timed-out or refused publish', async () => {
    bad.refuseConnections = true
    good.refuseConnections = true
    pool = new NostrRelayPool([GOOD, BAD])
    const failure = expect(pool.publish(evt(1460))).rejects.toThrow(/no relay could be reached in time/)
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    expect(pool.health().map(r => r.lastError)).toEqual(['Connection failed', 'Connection failed'])
  })

  it('notices a relay that says OK to chat and keeps none of it, and says nothing about one that keeps it', async () => {
    bad.forgetful = true
    pool = new NostrRelayPool([GOOD, BAD])
    await pool.publish(evt(1460))
    expect(pool.health().every(r => r.unreturned === undefined)).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000)
    const [kept, dropped] = pool.health()
    expect(kept!.unreturned).toBeUndefined()
    expect(dropped!.unreturned).toEqual([1460])
    // Asked once per kind, not on every message.
    const reads = bad.requestedFilters().length
    await pool.publish(evt(1460))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(bad.requestedFilters()).toHaveLength(reads)
    // Ephemeral kinds are never kept by anybody, so never asked about.
    await pool.publish(evt(20461))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(bad.requestedFilters()).toHaveLength(reads)
  })

  it('claims nothing when the read-back itself goes unanswered', async () => {
    pool = new NostrRelayPool([GOOD, BAD])
    await pool.publish(evt(1460))
    bad.silent = true
    await vi.advanceTimersByTimeAsync(3_000 + 8_000 + 1)
    expect(pool.health().every(r => r.unreturned === undefined)).toBe(true)
  })

  it('never reads back from a write-only relay', async () => {
    bad.forgetful = true
    pool = new NostrRelayPool([GOOD, { url: BAD, read: false, write: true }])
    await pool.publish(evt(1460))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(bad.requestedFilters()).toHaveLength(0)
    expect(pool.health()[1]!.unreturned).toBeUndefined()
  })

  it('refuses a flood of forged copies of a real event and hears the real one once', async () => {
    pool = new NostrRelayPool([GOOD, BAD])
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    const key = generateSecretKey()
    const first = evt(20461, '0', key)
    good.inject(sub => ['EVENT', sub, first])
    for (let i = 1; i <= 2_000; i++) {
      const event = { ...first, id: i.toString(16).padStart(64, '0') }
      bad.inject(sub => ['EVENT', sub, event])
    }
    await vi.advanceTimersByTimeAsync(1)
    // The forged copies are all refused by signature; the real one was heard once.
    expect(seen).toEqual([first.id])
  })

  it('never hands a reader a forged, mismatched, malformed or unknown-subscription event', async () => {
    pool = new NostrRelayPool([BAD])
    const seen: string[] = []
    pool.subscribe([{ kinds: [20461] }], event => seen.push(event.id))
    await vi.advanceTimersByTimeAsync(1)
    const real = evt()
    const forged = { ...evt(), content: 'changed after signing' }
    const wrongKind = evt(1)
    bad.inject(sub => ['EVENT', sub, forged])
    bad.inject(sub => ['EVENT', sub, wrongKind])
    bad.inject(sub => ['EVENT', sub, { id: 'x' }])
    bad.inject(sub => ['EVENT', sub, null])
    bad.inject(() => ['EVENT', 'no-such-subscription', real])
    bad.inject(() => '["EVENT",')
    bad.inject(() => 'not json at all')
    bad.inject(sub => ['EVENT', sub, real])
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual([real.id])
  })
})
