import { describe, it, expect } from 'vitest'
import {
  SignalChannel,
  ACK_DELAY_MS,
  MAX_BUFFERED_SIGNALS,
  SIGNAL_RETRY_JITTER,
  type ChannelClock,
  type ChannelSignal,
} from './signal-channel.js'

/**
 * A clock whose timers only run when a test says so, so a 44 second half-open
 * socket costs no wall time and a backoff schedule can be asserted exactly.
 */
class FakeClock implements ChannelClock {
  #now = 0
  #next = 1
  readonly #timers = new Map<number, { at: number; run: () => void }>()
  /** Every delay a timer was asked for, in order. The backoff schedule. */
  readonly delays: number[] = []

  now(): number {
    return this.#now
  }

  setTimer(ms: number, run: () => void): unknown {
    const id = this.#next++
    this.delays.push(ms)
    this.#timers.set(id, { at: this.#now + ms, run })
    return id
  }

  clearTimer(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle)
  }

  /** Advance time, running everything that falls due in the order it does. */
  advance(ms: number): void {
    const until = this.#now + ms
    for (;;) {
      let dueId: number | undefined
      let dueAt = Infinity
      for (const [id, timer] of this.#timers) {
        if (timer.at <= until && timer.at < dueAt) {
          dueId = id
          dueAt = timer.at
        }
      }
      if (dueId === undefined) break
      const timer = this.#timers.get(dueId)
      if (timer === undefined) break
      this.#timers.delete(dueId)
      this.#now = timer.at
      timer.run()
    }
    this.#now = until
  }
}

/**
 * A transport that keeps everything, so a test can assert what left the
 * device rather than what a peer connection did about it. `test/fault-
 * transport.ts` is a different thing and lands with S1: it drops, delays and
 * reorders between two real channels. Nothing here depends on it.
 */
class FakeTransport {
  readonly sent: ChannelSignal[] = []

  send = (body: ChannelSignal): void => {
    this.sent.push(body)
  }

  ofType(type: string): ChannelSignal[] {
    return this.sent.filter((body) => body.type === type)
  }

  get last(): ChannelSignal {
    const body = this.sent[this.sent.length - 1]
    if (body === undefined) throw new Error('nothing was sent')
    return body
  }

  clear(): void {
    this.sent.length = 0
  }
}

const LOCAL_CONN = '0123456789abcdef'
const REMOTE_CONN = 'fedcba9876543210'

interface Harness {
  channel: SignalChannel
  wire: FakeTransport
  clock: FakeClock
  delivered: ChannelSignal[]
  adopted: { gen: number; body: ChannelSignal }[]
  foreign: string[]
}

function harness(options: {
  gen?: number
  random?: () => number
  localDescription?: (type: 'offer' | 'answer') => string | undefined
  bufferLimit?: number
} = {}): Harness {
  const clock = new FakeClock()
  const wire = new FakeTransport()
  const delivered: ChannelSignal[] = []
  const adopted: { gen: number; body: ChannelSignal }[] = []
  const foreign: string[] = []
  const channel = new SignalChannel({
    gen: options.gen ?? 4,
    conn: LOCAL_CONN,
    send: wire.send,
    deliver: (body) => delivered.push(body),
    onNewerGeneration: (gen, body) => adopted.push({ gen, body }),
    onForeignConnection: (conn) => foreign.push(conn),
    localDescription: options.localDescription,
    clock,
    // Pinned so the schedule is the schedule: 0.5 makes the jitter factor
    // exactly 1. Bounds are asserted separately.
    random: options.random ?? (() => 0.5),
    timing: options.bufferLimit === undefined ? undefined : { bufferLimit: options.bufferLimit },
  })
  return { channel, wire, clock, delivered, adopted, foreign }
}

/** A signal as the far end would put it on the wire. */
function from(body: Partial<ChannelSignal> & { type: ChannelSignal['type'] }): ChannelSignal {
  return { gen: 4, conn: REMOTE_CONN, peerConn: LOCAL_CONN, ...body }
}

describe('SignalChannel sender', () => {
  it('stamps a gapless seq, the generation and the connection on everything it sends', () => {
    const { channel, wire } = harness()

    expect(channel.send({ type: 'offer', sdp: 'o1' })).toBe(1)
    expect(channel.send({ type: 'ice', candidate: 'c1' })).toBe(2)
    expect(channel.send({ type: 'ice', candidate: 'c2' })).toBe(3)

    expect(wire.sent.map((b) => [b.type, b.seq, b.gen, b.conn])).toEqual([
      ['offer', 1, 4, LOCAL_CONN],
      ['ice', 2, 4, LOCAL_CONN],
      ['ice', 3, 4, LOCAL_CONN],
    ])
  })

  it('sends once when the far end acknowledges, and never again', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    expect(wire.ofType('offer')).toHaveLength(1)

    channel.receive(from({ type: 'ack', ack: 1 }))
    expect(channel.queueDepth).toBe(0)

    wire.clear()
    clock.advance(60_000)
    expect(wire.sent).toHaveLength(0)
  })

  it('retransmits until it is acked, not for a fixed number of tries', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    // Three re-sends three seconds apart is what shipped and what wedged a
    // pair for the rest of the call. Forty seconds of silence must not.
    clock.advance(40_000)
    expect(wire.ofType('offer').length).toBeGreaterThan(5)

    const before = wire.ofType('offer').length
    channel.receive(from({ type: 'ack', ack: 1 }))
    clock.advance(40_000)
    expect(wire.ofType('offer')).toHaveLength(before)
  })

  it('walks 1s, 2s, 4s, 8s and then 8s for ever', () => {
    const { channel, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    clock.advance(60_000)

    expect(clock.delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000])
  })

  it('spreads every step by at most the jitter, either way', () => {
    for (const [random, factor] of [
      [() => 0, 1 - SIGNAL_RETRY_JITTER],
      [() => 1, 1 + SIGNAL_RETRY_JITTER],
    ] as [() => number, number][]) {
      const { channel, clock } = harness({ random })
      channel.send({ type: 'offer', sdp: 'o1' })
      clock.advance(60_000)

      expect(clock.delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000].map((s) => s * factor))
    }

    // And an arbitrary draw stays inside the window at every step.
    const draws = [0.1, 0.9, 0.37, 0.64, 0.02]
    let i = 0
    const { channel, clock } = harness({ random: () => draws[i++ % draws.length] as number })
    channel.send({ type: 'offer', sdp: 'o1' })
    clock.advance(60_000)
    const steps = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]
    clock.delays.slice(0, steps.length).forEach((delay, step) => {
      const nominal = steps[step] as number
      expect(delay).toBeGreaterThanOrEqual(nominal * (1 - SIGNAL_RETRY_JITTER))
      expect(delay).toBeLessThanOrEqual(nominal * (1 + SIGNAL_RETRY_JITTER))
    })
  })

  it('re-sends an offer as the description the connection holds now, under its original seq', () => {
    let sdp = 'o1'
    const { channel, wire, clock } = harness({ localDescription: () => sdp })

    channel.send({ type: 'offer', sdp: 'o1' })
    sdp = 'o1+candidates'
    clock.advance(1_000)

    const offers = wire.ofType('offer')
    expect(offers).toHaveLength(2)
    expect(offers[1]).toMatchObject({ sdp: 'o1+candidates', seq: 1 })
  })

  it('batches unacked candidates into one ice covering first..seq', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    channel.send({ type: 'ice', candidate: 'c1' })
    channel.send({ type: 'ice', candidate: 'c2' })
    channel.send({ type: 'ice', candidate: 'c3' })
    wire.clear()

    clock.advance(1_000)

    const ice = wire.ofType('ice')
    expect(ice).toHaveLength(1)
    expect(ice[0]).toMatchObject({ first: 2, seq: 4, candidates: ['c1', 'c2', 'c3'] })
    // Never both: a reader that understands each field would apply one twice.
    expect(ice[0]?.candidate).toBeUndefined()
    // The offer rides beside it, still one signal.
    expect(wire.sent).toHaveLength(2)
  })

  it('narrows the batch to what is still unacked', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    channel.send({ type: 'ice', candidate: 'c1' })
    channel.send({ type: 'ice', candidate: 'c2' })
    channel.send({ type: 'ice', candidate: 'c3' })
    channel.receive(from({ type: 'ack', ack: 2 }))
    wire.clear()

    clock.advance(1_000)

    expect(wire.ofType('ice')[0]).toMatchObject({ first: 3, seq: 4, candidates: ['c2', 'c3'] })
    expect(wire.ofType('offer')).toHaveLength(0)
  })

  it('publishes the whole unacked queue the moment the transport comes back', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    channel.send({ type: 'ice', candidate: 'c1' })
    // Mid-backoff, nothing locally has changed: this is the 44 second case.
    clock.advance(500)
    wire.clear()

    channel.reconnected()

    expect(wire.ofType('offer')).toHaveLength(1)
    expect(wire.ofType('ice')[0]).toMatchObject({ first: 2, seq: 2 })
  })

  it('does not charge the backoff for a reconnect', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    clock.advance(500)
    channel.reconnected()
    wire.clear()

    // The step that was running is still a one second step, not a two.
    clock.advance(1_000)
    expect(wire.ofType('offer')).toHaveLength(1)
  })

  it('sends nothing more once the peer has gone', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    channel.close()
    wire.clear()

    clock.advance(60_000)
    expect(wire.sent).toHaveLength(0)
    expect(channel.queueDepth).toBe(0)
    expect(channel.send({ type: 'offer', sdp: 'o2' })).toBe(0)
    expect(wire.sent).toHaveLength(0)
  })

  it('resets the backoff once the queue empties', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    clock.advance(20_000)
    channel.receive(from({ type: 'ack', ack: 1 }))
    wire.clear()
    const before = clock.delays.length

    channel.send({ type: 'ice', candidate: 'c1' })
    expect(clock.delays[before]).toBe(1_000)
  })
})

describe('SignalChannel receiver', () => {
  it('acknowledges cumulatively, once, after the delay', () => {
    const { channel, wire, delivered, clock } = harness()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    channel.receive(from({ type: 'ice', seq: 2, candidate: 'c1' }))
    channel.receive(from({ type: 'ice', seq: 3, candidate: 'c2' }))
    expect(delivered).toHaveLength(3)
    expect(wire.sent).toHaveLength(0)

    clock.advance(ACK_DELAY_MS)

    expect(wire.ofType('ack')).toHaveLength(1)
    expect(wire.last).toMatchObject({ ack: 3, peerConn: REMOTE_CONN, conn: LOCAL_CONN, gen: 4 })
  })

  it('piggybacks the acknowledgement on whatever this side was sending anyway', () => {
    const { channel, wire, clock } = harness()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    channel.send({ type: 'answer', sdp: 'a1', re: 1 })

    expect(wire.last).toMatchObject({ type: 'answer', ack: 1 })
    clock.advance(10_000)
    expect(wire.ofType('ack')).toHaveLength(0)
  })

  it('delivers a duplicate once and acknowledges it at once, because our ack was lost', () => {
    const { channel, wire, delivered, clock } = harness()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    clock.advance(ACK_DELAY_MS)
    wire.clear()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))

    expect(delivered).toHaveLength(1)
    expect(wire.ofType('ack')).toHaveLength(1)
    expect(wire.last).toMatchObject({ ack: 1 })
  })

  it('buffers out of order and releases in order', () => {
    const { channel, delivered, wire, clock } = harness()

    channel.receive(from({ type: 'ice', seq: 3, candidate: 'c3' }))
    channel.receive(from({ type: 'ice', seq: 2, candidate: 'c2' }))
    expect(delivered).toHaveLength(0)
    // A gap is never acknowledged: the ack is cumulative, so it would claim
    // the missing signal arrived and the far end would stop re-sending it.
    clock.advance(ACK_DELAY_MS)
    expect(wire.sent).toHaveLength(0)

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))

    expect(delivered.map((b) => b.seq)).toEqual([1, 2, 3])
    clock.advance(ACK_DELAY_MS)
    expect(wire.last).toMatchObject({ type: 'ack', ack: 3 })
  })

  it('takes a batch that starts at the expected seq as the missing signal, not as its last seq', () => {
    const { channel, delivered, wire, clock } = harness()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    // Candidate 2 was lost; 3 and 4 arrived singly and wait behind the hole.
    channel.receive(from({ type: 'ice', seq: 3, candidate: 'c3' }))
    channel.receive(from({ type: 'ice', seq: 4, candidate: 'c4' }))
    expect(delivered.map((b) => b.seq)).toEqual([1])

    // The far end re-sends 2 only as part of a batch covering 2..4.
    channel.receive(from({ type: 'ice', first: 2, seq: 4, candidates: ['c2', 'c3', 'c4'] }))

    expect(delivered.map((b) => b.seq)).toEqual([1, 4])
    expect(delivered[1]).toMatchObject({ candidates: ['c2', 'c3', 'c4'] })
    clock.advance(ACK_DELAY_MS)
    expect(wire.last).toMatchObject({ type: 'ack', ack: 4 })

    // And what comes next is 5, with nothing stale left waiting.
    channel.receive(from({ type: 'ice', seq: 5, candidate: 'c5' }))
    expect(delivered.map((b) => b.seq)).toEqual([1, 4, 5])
  })

  it('still buffers a batch whose range starts beyond the expected seq', () => {
    const { channel, delivered } = harness()

    channel.receive(from({ type: 'ice', first: 3, seq: 4, candidates: ['c3', 'c4'] }))
    expect(delivered).toHaveLength(0)

    channel.receive(from({ type: 'ice', first: 1, seq: 2, candidates: ['c1', 'c2'] }))
    expect(delivered.map((b) => b.seq)).toEqual([2, 4])
  })

  it('drops the oldest buffered signal rather than growing without bound', () => {
    const { channel, delivered } = harness()
    const limit = MAX_BUFFERED_SIGNALS

    // Seq 1 never arrives, so everything after it is held.
    for (let seq = 2; seq <= limit + 2; seq++) {
      channel.receive(from({ type: 'ice', seq, candidate: `c${seq}` }))
    }
    // That is limit + 1 held signals, so the first one in (seq 2) is gone.
    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    expect(delivered.map((b) => b.seq)).toEqual([1])

    // Dropping is not loss: the far end retransmits what it has not seen
    // acked, and the stream runs on.
    channel.receive(from({ type: 'ice', seq: 2, candidate: 'c2' }))
    expect(delivered).toHaveLength(limit + 2)
    expect(delivered[delivered.length - 1]?.seq).toBe(limit + 2)
  })

  it('drops an older generation, replies with one sync, and rate limits it', () => {
    const { channel, wire, delivered, clock } = harness({ gen: 4 })

    channel.receive(from({ type: 'offer', gen: 3, seq: 1, sdp: 'old' }))
    channel.receive(from({ type: 'offer', gen: 3, seq: 1, sdp: 'old' }))
    channel.receive(from({ type: 'offer', gen: 2, seq: 1, sdp: 'older' }))

    expect(delivered).toHaveLength(0)
    expect(wire.ofType('sync')).toHaveLength(1)
    expect(wire.last).toMatchObject({ type: 'sync', gen: 4, conn: LOCAL_CONN })

    clock.advance(1_999)
    channel.receive(from({ type: 'offer', gen: 3, seq: 1, sdp: 'old' }))
    expect(wire.ofType('sync')).toHaveLength(1)

    clock.advance(2)
    channel.receive(from({ type: 'offer', gen: 3, seq: 1, sdp: 'old' }))
    expect(wire.ofType('sync')).toHaveLength(2)
  })

  it('reports a newer generation without delivering or acknowledging it', () => {
    const { channel, wire, delivered, adopted, clock } = harness({ gen: 4 })

    channel.receive(from({ type: 'offer', gen: 5, seq: 1, sdp: 'new' }))

    expect(adopted).toEqual([{ gen: 5, body: expect.objectContaining({ gen: 5 }) }])
    expect(delivered).toHaveLength(0)
    clock.advance(10_000)
    // Unacked on purpose: this channel cannot honour it, and the far end must
    // keep asking until the new generation's channel answers.
    expect(wire.sent).toHaveLength(0)
  })

  it('applies an answer only if it answers the outstanding offer, and acks the rest', () => {
    const { channel, wire, delivered, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    channel.receive(from({ type: 'answer', seq: 1, re: 99, sdp: 'stale' }))

    expect(delivered).toHaveLength(0)
    clock.advance(ACK_DELAY_MS)
    expect(wire.last).toMatchObject({ type: 'ack', ack: 1 })

    channel.receive(from({ type: 'answer', seq: 2, re: 1, sdp: 'a1' }))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sdp: 'a1' })
    expect(channel.outstandingOffer).toBeUndefined()
  })

  it('treats an answer as proof its offer arrived, whatever the ack said', () => {
    const { channel, wire, clock } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    // No `ack` on the answer at all.
    channel.receive(from({ type: 'answer', seq: 1, re: 1, sdp: 'a1' }))

    expect(channel.queueDepth).toBe(0)
    wire.clear()
    clock.advance(30_000)
    expect(wire.ofType('offer')).toHaveLength(0)
  })

  it('binds to one remote connection and reports any other at the same generation', () => {
    const { channel, delivered, foreign } = harness()

    channel.receive(from({ type: 'offer', seq: 1, sdp: 'o1' }))
    channel.receive({ type: 'offer', gen: 4, conn: 'aaaaaaaaaaaaaaaa', seq: 1, sdp: 'other' })

    expect(delivered).toHaveLength(1)
    expect(foreign).toEqual(['aaaaaaaaaaaaaaaa'])
  })

  it('ignores a signal addressed to a connection this side has replaced', () => {
    const { channel, delivered } = harness()

    channel.receive({ type: 'offer', gen: 4, conn: REMOTE_CONN, peerConn: 'dddddddddddddddd', seq: 1 })

    expect(delivered).toHaveLength(0)
  })

  it('addresses the far end once its connection id is known', () => {
    const { channel, wire } = harness()

    channel.send({ type: 'offer', sdp: 'o1' })
    expect(wire.last.peerConn).toBeUndefined()

    channel.receive(from({ type: 'answer', seq: 1, re: 1, sdp: 'a1' }))
    channel.send({ type: 'ice', candidate: 'c1' })

    expect(wire.last).toMatchObject({ peerConn: REMOTE_CONN })
  })

  it('passes an unsequenced signal straight through, so a legacy peer is not dropped here', () => {
    const { channel, delivered } = harness()

    channel.receive({ type: 'offer', sdp: 'legacy' })

    expect(delivered).toHaveLength(1)
  })
})
