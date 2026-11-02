import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import { NostrRelayPool, PROBE_QUIET_MS, RESEND_MAX_MS, RESEND_MS, WRITE_HELD, closedReadEvidence, isEphemeralKind, refusalStops, resendDelay, writeRefusal } from './relay-pool.js'
import { FakeWebSocket, fakeRelay, resetFakeRelays, type FakeRelayServer } from '../test/fake-socket.js'
import { READ_HOLD_MAX_MS, READ_HOLD_MS, RelayDialGate, WRITE_HOLD_MAX_MS, WRITE_HOLD_MS, doublingBackoff, noticeThrottles, relayReason } from './relay-dial-gate.js'

beforeAll(() => {
  useWebSocketImplementation(FakeWebSocket as unknown as typeof WebSocket)
})

const URL_A = 'wss://relay-a.test'
const URL_B = 'wss://relay-b.test'
const A = 'wss://relay-a.test/'

function evt(kind = 1): Event {
  return finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' }, generateSecretKey())
}

const requests = (relay: FakeRelayServer) => relay.frames.filter(frame => JSON.parse(frame)[0] === 'REQ').length
const events = (relay: FakeRelayServer) => relay.frames.filter(frame => JSON.parse(frame)[0] === 'EVENT').length

describe('relay reasons', () => {
  it('reads the NIP-01 prefix with or without strfry’s ERROR: in front', () => {
    expect(relayReason('rate-limited: slow down')).toBe('rate-limited')
    expect(relayReason('ERROR: rate-limited: slow down')).toBe('rate-limited')
    expect(relayReason('ERROR: blocked: not on the list')).toBe('blocked')
    expect(relayReason('error: something broke')).toBe('error')
    expect(relayReason('auth-required: who are you')).toBe('auth-required')
    expect(relayReason('just words')).toBeUndefined()
    expect(relayReason('')).toBeUndefined()
  })

  it('classifies strfry refusals that used to read as nothing in particular', () => {
    expect(closedReadEvidence('ERROR: restricted: members only')).toBe('refused')
    expect(closedReadEvidence('ERROR: auth-required: sign in')).toBe('authentication-required')
    expect(closedReadEvidence('ERROR: error: internal')).toBeUndefined()
    expect(writeRefusal('ERROR: rate-limited: wait')).toBe('Write refused: rate limited')
  })

  it('stops for good only on reasons that mean stop', () => {
    for (const reason of ['blocked: no', 'ERROR: restricted: no', 'pow: difficulty 20', 'auth-required: sign in']) expect(refusalStops(reason, false)).toBe(true)
    expect(refusalStops('auth-required: sign in', true)).toBe(false)
    for (const reason of ['rate-limited: wait', 'error: busy', 'invalid: bad filter', 'relay connection closed', '']) expect(refusalStops(reason, false)).toBe(false)
  })

  it('hears a NOTICE about rates or too many requests', () => {
    expect(noticeThrottles('rate-limited: slow down')).toBe(true)
    expect(noticeThrottles('You are being rate limited')).toBe(true)
    expect(noticeThrottles('ERROR: too many concurrent REQs')).toBe(true)
    expect(noticeThrottles('Too many requests')).toBe(true)
    expect(noticeThrottles('welcome to the relay')).toBe(false)
    expect(noticeThrottles('could not generate the response')).toBe(false)
  })

  it('knows the ephemeral kinds', () => {
    expect(isEphemeralKind(20461)).toBe(true)
    expect(isEphemeralKind(21059)).toBe(true)
    expect(isEphemeralKind(1)).toBe(false)
    expect(isEphemeralKind(30078)).toBe(false)
  })
})

describe('backoff schedules', () => {
  it('doubles to its cap', () => {
    expect([1, 2, 3, 4, 5].map(n => doublingBackoff(n, 60_000, 30 * 60_000))).toEqual([60_000, 120_000, 240_000, 480_000, 960_000])
    expect(doublingBackoff(6, 60_000, 30 * 60_000)).toBe(30 * 60_000)
    expect(doublingBackoff(1_000, 60_000, 30 * 60_000)).toBe(30 * 60_000)
  })

  it('resends a closed subscription after 15 s doubling to 5 min, within 20% either way', () => {
    expect(resendDelay(1, () => 0.5)).toBe(RESEND_MS)
    expect(resendDelay(2, () => 0.5)).toBe(2 * RESEND_MS)
    expect(resendDelay(20, () => 0.5)).toBe(RESEND_MAX_MS)
    expect(resendDelay(1, () => 0)).toBe(RESEND_MS * 0.8)
    expect(resendDelay(1, () => 0.999999)).toBeCloseTo(RESEND_MS * 1.2, -1)
  })

  it('holds writes for 30 s, doubling to an hour, one complaint per hold', () => {
    let now = 0
    const gate = new RelayDialGate(() => now)
    gate.throttled(A)
    expect(gate.writeHeldUntil(A)).toBe(WRITE_HOLD_MS)
    // Several pools hearing the same complaint count it once.
    gate.throttled(A); gate.throttled(A)
    expect(gate.writeHeldUntil(A)).toBe(WRITE_HOLD_MS)
    expect(gate.writeHeld(A)).toBe(true)
    now = WRITE_HOLD_MS
    expect(gate.writeHeld(A)).toBe(false)
    gate.throttled(A)
    expect(gate.writeHeldUntil(A) - now).toBe(2 * WRITE_HOLD_MS)
    for (let i = 0; i < 20; i++) { now = gate.writeHeldUntil(A); gate.throttled(A) }
    expect(gate.writeHeldUntil(A) - now).toBe(WRITE_HOLD_MAX_MS)
    // An hour without a complaint starts again from 30 s.
    now = gate.writeHeldUntil(A) + WRITE_HOLD_MAX_MS
    gate.throttled(A)
    expect(gate.writeHeldUntil(A) - now).toBe(WRITE_HOLD_MS)
    expect(gate.writeHeld('wss://other.test/')).toBe(false)
  })

  it('holds reads for 60 s, doubling to 30 minutes', () => {
    let now = 0
    const gate = new RelayDialGate(() => now)
    const holds: number[] = []
    for (let i = 0; i < 7; i++) { gate.readRateLimited(A); holds.push(gate.readHeldUntil(A) - now); now = gate.readHeldUntil(A) }
    expect(holds).toEqual([READ_HOLD_MS, 2 * READ_HOLD_MS, 4 * READ_HOLD_MS, 8 * READ_HOLD_MS, 16 * READ_HOLD_MS, READ_HOLD_MAX_MS, READ_HOLD_MAX_MS])
    gate.clear()
    expect(gate.readHeld(A)).toBe(false)
  })

  it('holds the next dial as well as writes after a refused upgrade', () => {
    let now = 0
    const gate = new RelayDialGate(() => now)
    gate.refusedUpgrade(A)
    expect(gate.writeHeld(A)).toBe(true)
    expect(gate.open(A)).toBe(false)
    expect(gate.retryAt(A)).toBe(WRITE_HOLD_MS)
    now = WRITE_HOLD_MS
    expect(gate.open(A)).toBe(true)
  })
})

describe('NostrRelayPool and refusals', () => {
  let a: FakeRelayServer
  let b: FakeRelayServer
  let gate: RelayDialGate
  let pool: NostrRelayPool

  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeRelays()
    a = fakeRelay(URL_A)
    b = fakeRelay(URL_B)
    gate = new RelayDialGate()
    pool = new NostrRelayPool([URL_A, URL_B], undefined, { dialGate: gate, reconnectJitterMs: 0, random: () => 0.5 })
  })

  afterEach(() => {
    pool.close()
    vi.useRealTimers()
  })

  it('never resends a subscription a relay refused with blocked:, until a reconnect', async () => {
    a.refuseReads = 'ERROR: blocked: not for you'
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    expect(requests(a)).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(requests(a)).toBe(1)
    // The other relay is not affected.
    expect(requests(b)).toBe(1)
    pool.reconnect()
    await vi.advanceTimersByTimeAsync(1)
    expect(requests(a)).toBe(2)
  })

  it('treats auth-required: without a grant as stop, and restricted: and pow: the same', async () => {
    for (const reason of ['auth-required: sign in', 'restricted: members', 'pow: 28 bits']) {
      pool.close(); resetFakeRelays(); a = fakeRelay(URL_A); b = fakeRelay(URL_B)
      pool = new NostrRelayPool([URL_A], undefined, { dialGate: new RelayDialGate(), reconnectJitterMs: 0 })
      a.refuseReads = reason
      pool.subscribe([{ kinds: [1] }], () => {})
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(requests(a), reason).toBe(1)
    }
  })

  it('holds every pool’s reads to a relay that answered rate-limited:, from 60 s', async () => {
    const other = new NostrRelayPool([URL_A], undefined, { dialGate: gate, reconnectJitterMs: 0 })
    try {
      a.refuseReads = 'ERROR: rate-limited: slow down'
      pool.subscribe([{ kinds: [1] }], () => {})
      await vi.advanceTimersByTimeAsync(1)
      expect(requests(a)).toBe(1)
      expect(gate.readHeld(A)).toBe(true)
      // A rate-limited read also holds writes.
      expect(gate.writeHeld(A)).toBe(true)
      // Another pool's new subscription waits too.
      other.subscribe([{ kinds: [2] }], () => {})
      await vi.advanceTimersByTimeAsync(50_000)
      expect(requests(a)).toBe(1)
      a.refuseReads = undefined
      await vi.advanceTimersByTimeAsync(30_000)
      // Both resent once the hold is over, each once.
      expect(requests(a)).toBe(3)
    } finally { other.close() }
  })

  it('resends other relay closes with a growing backoff instead of every 15 s', async () => {
    a.refuseReads = 'error: database busy'
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    const at: number[] = []
    const start = Date.now()
    let seen = requests(a)
    for (let t = 0; t < 4 * 60_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000)
      if (requests(a) !== seen) { seen = requests(a); at.push(Math.round((Date.now() - start) / 5_000) * 5) }
    }
    // 15 s, then 30 s more, then 60 s more, then 120 s more (recovery runs every 5 s).
    expect(at).toEqual([15, 45, 105, 225])
  })

  it('holds writes after OK false rate-limited:, then writes again once the hold ends', async () => {
    a.rejectPublishes = true
    a.rejectReason = 'rate-limited: you are noisy'
    await pool.publish(evt())
    expect(gate.writeHeld(A)).toBe(true)
    const before = events(a)
    await pool.publish(evt())
    expect(events(a)).toBe(before)
    expect(events(b)).toBe(2)
    expect(pool.health().find(relay => relay.url === A)?.lastError).toMatch(/slow down/)
    a.rejectPublishes = false
    await vi.advanceTimersByTimeAsync(30_000)
    await pool.publish(evt())
    expect(events(a)).toBe(before + 1)
  })

  it('drops an ephemeral event when every write relay is held, and refuses a stored one as unsent', async () => {
    gate.throttled(A); gate.throttled('wss://relay-b.test/')
    await expect(pool.publish(evt(20461))).resolves.toBeUndefined()
    await expect(pool.publish(evt(1))).rejects.toThrow(/no relay could be reached in time/)
    expect(events(a) + events(b)).toBe(0)
    await expect(pool.publishQuietly(URL_A, evt(1))).rejects.toThrow(WRITE_HELD)
  })

  it('reads NOTICEs, and one about rates holds writes', async () => {
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    a.notice('hello')
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.writeHeld(A)).toBe(false)
    a.notice('ERROR: too many concurrent REQs')
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.writeHeld(A)).toBe(true)
    expect(gate.writeHeld('wss://relay-b.test/')).toBe(false)
  })
})

describe('liveness probes', () => {
  let a: FakeRelayServer
  let gate: RelayDialGate
  let pool: NostrRelayPool

  beforeEach(() => {
    vi.useFakeTimers()
    resetFakeRelays()
    a = fakeRelay(URL_A)
    gate = new RelayDialGate()
  })

  afterEach(() => {
    pool.close()
    vi.useRealTimers()
  })

  it('probes only a socket that has been quiet for 30 s, with an ids filter', async () => {
    pool = new NostrRelayPool([URL_A], undefined, { dialGate: gate, reconnectJitterMs: 0 })
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(1)
    await pool.probe()
    expect(requests(a)).toBe(1)
    await vi.advanceTimersByTimeAsync(PROBE_QUIET_MS)
    await pool.probe()
    expect(requests(a)).toBe(2)
    const filter = a.requestedFilters()[1]![0]!
    expect(Object.keys(filter).sort()).toEqual(['ids', 'limit'])
    expect(filter.ids).toHaveLength(1)
    expect(filter.ids![0]).toMatch(/^[0-9a-f]{64}$/)
    expect(filter.limit).toBe(1)
    // It answered, so the socket counts as heard from again.
    await pool.probe()
    expect(requests(a)).toBe(2)
  })

  it('takes a CLOSED answer to a probe as a live socket', async () => {
    pool = new NostrRelayPool([URL_A], undefined, { dialGate: gate, reconnectJitterMs: 0 })
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(PROBE_QUIET_MS)
    a.refuseReads = 'ERROR: invalid: ids only please'
    await pool.probe()
    expect(a.connections).toBe(1)
    expect(a.attempts).toBe(1)
    expect(gate.failing(A)).toBe(false)
  })

  it('counts a probe that times out as a failed dial, and redials after a random wait', async () => {
    let draw = 0.6
    pool = new NostrRelayPool([URL_A], undefined, { dialGate: gate, reconnectJitterMs: 5_000, random: () => draw })
    pool.subscribe([{ kinds: [1] }], () => {})
    await vi.advanceTimersByTimeAsync(PROBE_QUIET_MS)
    a.silent = true
    const probed = pool.probe(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await probed
    expect(gate.failing(A)).toBe(true)
    a.silent = false
    // 0.6 of 5 s: not yet at 2.9 s, redialled by 3.1 s.
    await vi.advanceTimersByTimeAsync(2_900)
    expect(a.attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(a.attempts).toBe(2)
    draw = 0
  })
})
