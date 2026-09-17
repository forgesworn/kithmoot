/**
 * The reliable signalling channel of the call reliability design, §3.2.
 *
 * Perfect negotiation assumes the signalling path delivers. Ours does not: a
 * signal is an ephemeral event on a public relay, handed to whoever happens
 * to be subscribed at the instant it arrives and kept for nobody. One lost
 * answer leaves a pair blind for the rest of the call, because the side that
 * is owed it has no way to know it was ever sent. This module is the layer
 * that makes the path reliable: sequence numbers, cumulative acknowledgement,
 * retransmission until acked, and in-order idempotent delivery.
 *
 * Deliberately pure. It owns no `RTCPeerConnection`, no relay, no room and no
 * crypto - it is handed a `send` for the wire and a `deliver` for the
 * negotiator, and everything it does is a function of what it has been told.
 * That is what lets the awkward cases (a 44 second half-open socket, three
 * answers lost in a row, a generation superseded mid-flight) be tested in
 * milliseconds against a fake clock rather than inferred from a browser run.
 *
 * Scope note: the wire encoding, its validation and the `SignalBody` union
 * belong to `src/signal.ts` (step S3, landing separately). The shapes here
 * are the subset this module reads and writes, declared locally so the two
 * steps do not have to land together; S3 owns the wire and this module will
 * be re-typed against it once it does. Wiring into `Peer` and `Mesh` is S4
 * and S5 - nothing here reaches for either.
 */

/** Signal types this channel understands. `health` rides `sendUnreliable`. */
export type ChannelSignalType = 'offer' | 'answer' | 'ice' | 'ack' | 'sync' | 'health'

/**
 * The profile-2 fields of a signal body, as §2.2 defines them.
 *
 * The index signature is not laziness: an offer also carries `slots`, `tier`,
 * `restart`, `roomId` and whatever else `Peer` puts on it, and this channel
 * must carry those through a retransmission untouched without knowing what
 * they mean. S3 owns which of them are legal.
 */
export interface ChannelSignal {
  type: ChannelSignalType
  /** Pair generation. Monotonic per pair, never reused. */
  gen?: number
  /** The sender's connection instance id, fresh per `RTCPeerConnection`. */
  conn?: string
  /** The connection the sender believes it is addressing. */
  peerConn?: string
  /** Per `conn`, from 1, gapless. On offer, answer and ice. */
  seq?: number
  /** First seq covered by a batched `ice`. */
  first?: number
  /** Batched candidates. */
  candidates?: string[]
  /** One candidate, as profile 1 sends them. */
  candidate?: string
  /** Highest contiguous seq received from `peerConn`. */
  ack?: number
  /** On an answer: the seq of the offer it answers. */
  re?: number
  sdp?: string
  [field: string]: unknown
}

/**
 * The first step of the retransmission backoff.
 *
 * Short, because the common case is a single lost signal and the pair is
 * blind until it is replaced.
 */
export const SIGNAL_RETRY_MS = 1_000

/**
 * The longest an unacked signal waits between re-sends.
 *
 * The schedule is 1s, 2s, 4s, 8s and then 8s for ever, each with +/-20%
 * jitter so two sides that lost the same window do not retransmit in
 * lockstep on every attempt.
 *
 * **Against the budget.** `MAX_SIGNALS_PER_WINDOW` (`src/signal-guard.ts`)
 * allows 120 signals per sending device per 20 second window. A wedged
 * connection in steady state costs one retransmission per 8 seconds - 2.5 per
 * window - and coalescing is what keeps it at one: an offer or answer
 * re-sends as a single current local description, and every unacked
 * candidate leaves as one batched `ice` no matter how many were gathered
 * (amendment A2; retransmitting candidates individually would have burned the
 * budget on its own). The acknowledging direction adds at most one delayed,
 * coalesced `ack` per 200ms burst, and normally none at all because acks
 * piggyback on whatever this side was already sending. So roughly 40
 * simultaneously stuck connections before a device could trip its own budget,
 * against a mesh that opens a couple of dozen at its largest - the same
 * headroom `MAX_OFFER_RETRY_MS` in `src/peer.ts` reasons about, and the same
 * conclusion.
 */
export const MAX_SIGNAL_RETRY_MS = 8_000

/** How much each backoff step is spread by, either way. */
export const SIGNAL_RETRY_JITTER = 0.2

/**
 * How long an acknowledgement waits for something to ride on.
 *
 * Long enough that an offer's burst of candidates is acked once rather than
 * twenty times, and that the answer this side is about to send carries the
 * ack itself; short enough that the far end's first backoff step (one second)
 * never expires waiting for it.
 */
export const ACK_DELAY_MS = 200

/**
 * How many out-of-order signals are held before the oldest is dropped.
 *
 * Bounded because an unbounded buffer fed by a hostile or broken sender is a
 * free memory sink, and cheap to bound because dropping is not loss: the far
 * end retransmits anything it has not seen acked, for as long as the pair
 * exists. Sized well above a full negotiation's worth of trickled candidates.
 */
export const MAX_BUFFERED_SIGNALS = 64

/** At most one `sync` per pair per this interval, per §2.3. */
export const SYNC_INTERVAL_MS = 2_000

/** Injected so the schedule can be asserted exactly rather than waited out. */
export interface ChannelClock {
  now(): number
  setTimer(ms: number, run: () => void): unknown
  clearTimer(handle: unknown): void
}

const REAL_CLOCK: ChannelClock = {
  now: () => Date.now(),
  setTimer: (ms, run) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface SignalChannelOptions {
  /** The generation this channel belongs to. A channel never changes it: a
   *  new generation is a new connection and therefore a new channel. */
  gen: number
  /** This side's connection instance id (16 hex), stamped on everything. */
  conn: string
  /** The remote connection being addressed, when it is already known. It is
   *  otherwise learned from the first signal that arrives. */
  peerConn?: string
  /**
   * The first seq this channel should expect from the far end. Defaults to 1.
   *
   * Only ever anything else when a connection is replaced while the far end's
   * is not: amendment A1's polite side discards its connection object on
   * generation-opening glare, and the offer that caused it is at whatever seq
   * the far end's unbroken stream had reached. A fresh channel expecting 1
   * would buffer that offer for ever and the pair would never be answered.
   */
  expectedSeq?: number
  /** Put a body on the wire. Failure is the caller's business; a publish that
   *  never left the device is repaired by `retransmitNow`. */
  send: (body: ChannelSignal) => void
  /** Hand a signal to the negotiator. Called once per `(conn, seq)`, in seq
   *  order, and never for something this channel consumed itself. */
  deliver: (body: ChannelSignal) => void
  /**
   * A signal from a newer generation arrived.
   *
   * The channel does not act on it - adopting a generation means closing a
   * connection and building another, which is S5's job (§3.3). It reports it
   * and stops, and the offending signal is neither delivered nor acked, so
   * the far end keeps asking until the new generation's channel answers.
   */
  onNewerGeneration?: (gen: number, body: ChannelSignal) => void
  /**
   * A signal arrived at this generation from a connection that is not the one
   * this channel is bound to. §3.3 calls that a protocol error and rebuilds;
   * the channel only reports it, and drops the signal.
   */
  onForeignConnection?: (conn: string, body: ChannelSignal) => void
  /**
   * The connection's current local description, used when an offer or answer
   * is retransmitted (§3.2). What goes back out is the description the
   * connection holds *now*, under the original seq: same session, same ICE
   * credentials, and by now carrying every candidate gathered since. Omitted
   * or returning undefined, the body as first queued is re-sent instead.
   */
  localDescription?: (type: 'offer' | 'answer') => string | undefined
  /** Defaults to the constants above; tests shorten them. */
  timing?: {
    intervalMs?: number
    maxIntervalMs?: number
    jitter?: number
    ackDelayMs?: number
    syncMs?: number
    bufferLimit?: number
  }
  /** Where the backoff jitter comes from. Defaults to `Math.random`. */
  random?: () => number
  clock?: ChannelClock
}

interface Unacked {
  seq: number
  body: ChannelSignal
}

/**
 * One direction's sender and the other direction's receiver for a single
 * connection. Both halves are here because they share one wire and one ack:
 * every outgoing body carries what this side has received, which is what
 * makes acknowledgement free in the common case.
 */
export class SignalChannel {
  readonly gen: number
  readonly conn: string

  readonly #send: (body: ChannelSignal) => void
  readonly #deliver: (body: ChannelSignal) => void
  readonly #onNewerGeneration: ((gen: number, body: ChannelSignal) => void) | undefined
  readonly #onForeignConnection: ((conn: string, body: ChannelSignal) => void) | undefined
  readonly #localDescription: ((type: 'offer' | 'answer') => string | undefined) | undefined
  readonly #clock: ChannelClock
  readonly #random: () => number
  readonly #retryMs: number
  readonly #maxRetryMs: number
  readonly #jitter: number
  readonly #ackDelayMs: number
  readonly #syncMs: number
  readonly #bufferLimit: number

  #peerConn: string | undefined
  #closed = false

  // Sender.
  #outSeq = 0
  #queue: Unacked[] = []
  #attempt = 0
  #retryTimer: unknown
  #outstandingOffer: number | undefined

  // Receiver.
  #expected = 1
  readonly #buffer = new Map<number, ChannelSignal>()
  #ackTimer: unknown
  #lastSyncAt: number | undefined

  constructor(options: SignalChannelOptions) {
    this.gen = options.gen
    this.conn = options.conn
    this.#peerConn = options.peerConn
    this.#send = options.send
    this.#deliver = options.deliver
    this.#onNewerGeneration = options.onNewerGeneration
    this.#onForeignConnection = options.onForeignConnection
    this.#localDescription = options.localDescription
    this.#clock = options.clock ?? REAL_CLOCK
    this.#random = options.random ?? Math.random
    const timing = options.timing ?? {}
    this.#retryMs = timing.intervalMs ?? SIGNAL_RETRY_MS
    this.#maxRetryMs = timing.maxIntervalMs ?? MAX_SIGNAL_RETRY_MS
    this.#jitter = timing.jitter ?? SIGNAL_RETRY_JITTER
    this.#ackDelayMs = timing.ackDelayMs ?? ACK_DELAY_MS
    this.#syncMs = timing.syncMs ?? SYNC_INTERVAL_MS
    this.#bufferLimit = timing.bufferLimit ?? MAX_BUFFERED_SIGNALS
    if (options.expectedSeq !== undefined && options.expectedSeq >= 1) this.#expected = options.expectedSeq
  }

  /** The remote connection this channel is bound to, once it is known. */
  get peerConn(): string | undefined {
    return this.#peerConn
  }

  /** How many signals are still waiting to be acknowledged. Diagnostics. */
  get queueDepth(): number {
    return this.#queue.length
  }

  /** The highest contiguous seq received from the far end. */
  get ackedThrough(): number {
    return this.#expected - 1
  }

  /** The seq of the local offer still waiting for its answer, if any. */
  get outstandingOffer(): number | undefined {
    return this.#outstandingOffer
  }

  /**
   * Send reliably: stamp a seq, queue it, publish it and keep publishing
   * until the far end says it arrived.
   *
   * Returns the assigned seq, or 0 if the channel is closed.
   */
  send(body: ChannelSignal): number {
    if (this.#closed) return 0
    const seq = ++this.#outSeq
    const queued: ChannelSignal = { ...body, seq }
    if (body.type === 'offer') this.#outstandingOffer = seq
    this.#queue.push({ seq, body: queued })
    this.#publish(queued)
    this.#armRetry()
    return seq
  }

  /**
   * Send once, without a seq and without retransmission.
   *
   * For signals whose value is entirely in being current: `health` (§3.4)
   * describes what is being received right now, and a stale copy of it is
   * worse than none. It still carries the generation, the connection ids and
   * a piggybacked ack, so it is never wasted.
   */
  sendUnreliable(body: ChannelSignal): void {
    if (this.#closed) return
    this.#publish({ ...body })
  }

  /**
   * A signal arrived for this connection, already unwrapped and validated.
   *
   * Everything §3.2's receiver block describes happens here: generation
   * filtering, acknowledgement, deduplication, buffering and in-order
   * release.
   */
  receive(body: ChannelSignal): void {
    if (this.#closed) return

    const gen = typeof body.gen === 'number' ? body.gen : undefined
    if (gen !== undefined) {
      if (gen < this.gen) {
        // An older generation is talking to a connection that no longer
        // exists. Telling it our generation is the whole repair - it rebuilds
        // upwards - and one telling per two seconds is enough, since a
        // retransmitting far end will ask again regardless.
        this.#replySync()
        return
      }
      if (gen > this.gen) {
        // Not acked on purpose: this channel cannot honour it, and an ack
        // would stop the far end asking before anything had adopted it.
        this.#onNewerGeneration?.(gen, body)
        return
      }
    }

    // Addressed to a connection this side has already replaced. Its seq space
    // is not ours, so applying it would corrupt the ordered stream.
    if (typeof body.peerConn === 'string' && body.peerConn !== this.conn) return

    const from = typeof body.conn === 'string' ? body.conn : undefined
    if (from !== undefined) {
      if (this.#peerConn === undefined) this.#peerConn = from
      else if (from !== this.#peerConn) {
        this.#onForeignConnection?.(from, body)
        return
      }
    }

    if (typeof body.ack === 'number') this.#ackUpTo(body.ack)
    // A bare ack carries nothing else and is never sequenced.
    if (body.type === 'ack') return
    // `sync` carries a generation only; an equal or older one says nothing
    // this side does not already know.
    if (body.type === 'sync') return
    if (body.type === 'health') {
      this.#deliver(body)
      return
    }

    const seq = typeof body.seq === 'number' ? body.seq : undefined
    if (seq === undefined) {
      // A profile-2 offer, answer or ice always carries a seq; one that does
      // not is a profile-1 shaped signal, which S5 downgrades the pair for.
      // Passing it through unsequenced is the tolerant reading and keeps this
      // module from being the thing that drops a legacy peer's negotiation.
      this.#deliver(body)
      return
    }

    // A duplicate means our acknowledgement was lost - the far end would not
    // be asking again otherwise - so the repair is to ack at once rather than
    // wait out the delay and watch it ask a third time.
    if (seq < this.#expected || this.#buffer.has(seq)) {
      this.#sendAckNow()
      return
    }

    if (seq > this.#expected) {
      this.#buffer.set(seq, body)
      while (this.#buffer.size > this.#bufferLimit) {
        const oldest = this.#buffer.keys().next().value
        if (oldest === undefined) break
        this.#buffer.delete(oldest)
      }
      // Deliberately not acked: the ack is cumulative, so acking a gap would
      // claim the missing signal arrived. The far end keeps retransmitting
      // the hole, which is exactly what is wanted.
      return
    }

    this.#release(body)
    for (;;) {
      const next = this.#buffer.get(this.#expected)
      if (next === undefined) break
      this.#buffer.delete(this.#expected)
      this.#release(next)
    }
    this.#armAck()
  }

  /**
   * Stop asking about a signal this side has given up on.
   *
   * Exactly one caller: the polite side of an in-generation glare, which
   * rolls its own offer back so the far end's can land. The connection no
   * longer holds that proposal, so retransmitting it would re-open a
   * negotiation this side has already conceded - and, since the retransmission
   * re-sends the connection's *current* local description, would re-send the
   * far end's own answer back at it.
   */
  drop(seq: number): void {
    if (this.#closed) return
    this.#queue = this.#queue.filter((entry) => entry.seq !== seq)
    if (this.#outstandingOffer === seq) this.#outstandingOffer = undefined
    if (this.#queue.length > 0) return
    this.#attempt = 0
    this.#clock.clearTimer(this.#retryTimer)
    this.#retryTimer = undefined
  }

  /**
   * The transport came back. Publish everything outstanding immediately.
   *
   * This is the 44 second case from the diagnosis: a client whose relay
   * sockets went half-open reconnected, resubscribed, and never re-offered,
   * because nothing local had changed and the backoff was mid-step. A
   * reconnect is new information about the wire, so it is worth a publish on
   * its own.
   *
   * It does not advance the backoff. The attempt that was waiting has not
   * happened yet, and charging a step for a reconnect would push the next
   * genuine retransmission further out for no reason.
   */
  reconnected(): void {
    if (this.#closed) return
    if (this.ackedThrough > 0) this.#sendAckNow()
    if (this.#queue.length === 0) return
    this.#flush()
    this.#armRetry()
  }

  /**
   * Publish what is outstanding now, without advancing the backoff.
   *
   * The mesh calls this when a relay publish was rejected outright: the
   * signal never left the device, so nothing on the far end will ever ask for
   * it and waiting out the step accomplishes nothing.
   */
  retransmitNow(): void {
    if (this.#closed || this.#queue.length === 0) return
    this.#flush()
    this.#armRetry()
  }

  /**
   * The connection is gone - closed, superseded by a newer generation, or the
   * peer has left the roster. Drop the queue and stop.
   *
   * Nothing short of this stops the retransmission. Whether a peer is still
   * there is the roster's call and the rebuild ladder's, never a retry
   * counter's: a two-retry budget is exactly what left pairs wedged for the
   * rest of a call when signalling was lost for more than six seconds.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue = []
    this.#buffer.clear()
    this.#outstandingOffer = undefined
    this.#clock.clearTimer(this.#retryTimer)
    this.#retryTimer = undefined
    this.#clock.clearTimer(this.#ackTimer)
    this.#ackTimer = undefined
  }

  get closed(): boolean {
    return this.#closed
  }

  /** In-order, deduplicated, and consumed rather than delivered where §3.2
   *  says so. `#expected` advances either way: a signal this side chose not
   *  to act on has still arrived, and the stream must not stall on it. */
  #release(body: ChannelSignal): void {
    this.#expected = (body.seq as number) + 1
    if (body.type === 'answer' && !this.#answersOutstandingOffer(body)) return
    if (body.type === 'answer' && typeof body.re === 'number') {
      // The answer is proof its offer arrived, whatever the ack said.
      this.#ackUpTo(body.re)
      this.#outstandingOffer = undefined
    }
    this.#deliver(body)
  }

  /**
   * Whether an answer answers the offer this side is actually waiting on.
   *
   * A retransmitted offer and its answer can cross; applying an answer to an
   * offer that has since been superseded puts the connection into a session
   * neither side described. It is acked all the same - it did arrive, and the
   * far end should stop asking - and then ignored.
   *
   * An answer with no `re` is applied: that is a peer that does not speak the
   * sequenced profile, and refusing it would break the pair outright.
   */
  #answersOutstandingOffer(body: ChannelSignal): boolean {
    if (typeof body.re !== 'number') return true
    return body.re === this.#outstandingOffer
  }

  #ackUpTo(n: number): void {
    if (this.#queue.length === 0) return
    const before = this.#queue.length
    this.#queue = this.#queue.filter((entry) => entry.seq > n)
    if (this.#queue.length === before) return
    // `#outstandingOffer` is deliberately left alone. An answer normally
    // piggybacks the ack for the very offer it answers, and clearing the
    // outstanding seq here would make that answer fail its own `re` check a
    // line later - the pair would then never hear an answer at all.
    if (this.#queue.length === 0) {
      this.#attempt = 0
      this.#clock.clearTimer(this.#retryTimer)
      this.#retryTimer = undefined
    }
  }

  /** Stamp the channel's identity and whatever is owed on a body, and send
   *  it. Every send is an acknowledgement opportunity, which is why the
   *  common case costs no ack signal at all. */
  #publish(body: ChannelSignal): void {
    const stamped: ChannelSignal = { ...body, gen: this.gen, conn: this.conn }
    if (this.#peerConn !== undefined) stamped.peerConn = this.#peerConn
    const acked = this.ackedThrough
    if (acked > 0) {
      stamped.ack = acked
      this.#clock.clearTimer(this.#ackTimer)
      this.#ackTimer = undefined
    }
    this.#send(stamped)
  }

  #armAck(): void {
    if (this.#closed || this.#ackTimer !== undefined) return
    if (this.ackedThrough <= 0) return
    this.#ackTimer = this.#clock.setTimer(this.#ackDelayMs, () => {
      this.#ackTimer = undefined
      if (this.#closed) return
      this.#publish({ type: 'ack' })
    })
  }

  #sendAckNow(): void {
    if (this.#closed || this.ackedThrough <= 0) return
    this.#publish({ type: 'ack' })
  }

  #replySync(): void {
    const now = this.#clock.now()
    if (this.#lastSyncAt !== undefined && now - this.#lastSyncAt < this.#syncMs) return
    this.#lastSyncAt = now
    // No `peerConn`: the connection it is addressed to is precisely the one
    // that no longer exists.
    this.#send({ type: 'sync', gen: this.gen, conn: this.conn })
  }

  #armRetry(): void {
    if (this.#closed || this.#queue.length === 0) return
    if (this.#retryTimer !== undefined) return
    this.#retryTimer = this.#clock.setTimer(this.#backoffMs(), () => {
      this.#retryTimer = undefined
      if (this.#closed || this.#queue.length === 0) return
      this.#flush()
      this.#attempt += 1
      this.#armRetry()
    })
  }

  /** 1s, 2s, 4s, 8s, then 8s for ever, each spread by +/-`#jitter`. */
  #backoffMs(): number {
    const doublings = Math.min(this.#attempt, 30)
    const step = Math.min(this.#retryMs * 2 ** doublings, this.#maxRetryMs)
    const spread = 1 + (this.#random() * 2 - 1) * this.#jitter
    return Math.max(1, Math.round(step * spread))
  }

  /**
   * Republish the unacked queue, coalesced (amendment A2).
   *
   * An offer or answer goes out as the connection's current local
   * description under its original seq, because that description already
   * contains every candidate gathered so far - re-sending the candidates
   * beside it would be redundant as well as expensive. Everything still
   * unacked that was a candidate leaves as one `ice` covering `first`..`seq`,
   * so a burst of thirty trickled candidates costs one signal, not thirty.
   */
  #flush(): void {
    const candidates: string[] = []
    let firstIce: number | undefined
    let lastIce: number | undefined

    for (const entry of this.#queue) {
      if (entry.body.type === 'ice') {
        if (firstIce === undefined) firstIce = entry.seq
        lastIce = entry.seq
        if (Array.isArray(entry.body.candidates)) candidates.push(...entry.body.candidates)
        else if (typeof entry.body.candidate === 'string') candidates.push(entry.body.candidate)
        continue
      }
      this.#publish(this.#current(entry.body))
    }

    if (firstIce === undefined || lastIce === undefined) return
    const batch: ChannelSignal = { type: 'ice', candidates, first: firstIce, seq: lastIce }
    // The single-candidate field is dropped on purpose: a batch that also
    // carried `candidate` would have one of its candidates applied twice by a
    // reader that understood both.
    this.#publish(batch)
  }

  /** An offer or answer re-sent as what the connection holds now. */
  #current(body: ChannelSignal): ChannelSignal {
    if (body.type !== 'offer' && body.type !== 'answer') return body
    const sdp = this.#localDescription?.(body.type)
    if (sdp === undefined || sdp === body.sdp) return body
    return { ...body, sdp }
  }
}
