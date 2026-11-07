/**
 * Carrying somebody else's media without ever decoding it.
 *
 * "Without decoding" is a statement about this code and its cost, not a
 * privacy guarantee - see "What makes it safe to ask" below, which says
 * plainly what a volunteer can and cannot do.
 *
 * ## What a browser can and cannot do
 *
 * The Node forwarder (`server/forwarder.mjs`) has it easy: werift hands it
 * RTP packets and it writes them straight onto another connection. A browser
 * has no `writeRtp`. The only way into the media path is Encoded Transform,
 * and it has a shape that dictates this whole module:
 *
 * - **A receiver's frames can be taken and dropped.** Consuming a receiver's
 *   readable without enqueuing onwards means no decoder ever sees the frames.
 *   That is what "without decoding" means here, and it is not a promise, it
 *   is the absence of a code path: the bytes go into a queue and out onto
 *   another connection.
 * - **A sender's frames can be replaced, but not conjured.** The sender-side
 *   transform is only invoked when the local encoder produces a frame. There
 *   is no API for pushing arbitrary encoded bytes into an RTP stream. So a
 *   relaying peer must be *sending something* to have frames to overwrite,
 *   and that something is a `clock`: a trivial locally-encoded track whose
 *   only job is to make the encoder tick. Its frames are thrown away and
 *   replaced with relayed ones, one for one.
 * - **The streams must be claimed before negotiation.** Calling
 *   `createEncodedStreams()` after the connection has negotiated throws
 *   `InvalidStateError: Too late to create encoded streams`. Measured, not
 *   assumed - which is why `FrameRelay` is attached when the connection is
 *   built rather than when a track turns up.
 *
 * The consequence worth stating plainly: **frames are forwarded at the
 * clock's rate, not the source's.** A clock slower than the stream it carries
 * drops the difference, and `RelayStats.dropped` counts exactly that.
 *
 * ## What makes it safe to ask, stated precisely
 *
 * A volunteer is a member of the room, and a member holds the room key. So
 * the claim is **not** the one a server forwarder gets to make: a volunteer
 * carrying A's media to B could read it. What makes that acceptable is that
 * it could already - a volunteer has to be directly connected to both ends to
 * carry them, and a direct connection is how it receives their media as an
 * ordinary participant. **Relaying gives a volunteer nothing it did not
 * already have.** Anyone who does not want a particular person seeing their
 * camera has a problem that peer assist neither creates nor solves.
 *
 * What a volunteer can do that it could not before is relabel. Nothing on
 * this path checks who made a frame: there is no encoded-frame layer here
 * (that runs on the server forwarder path only, see `media-crypto.ts`), each
 * hop is DTLS-SRTP that ends at the volunteer, and even with a frame layer
 * every member can derive every sender's media key. The receiving end
 * attributes a carried track because the volunteer's offer names it in
 * `carry` and the receiving end asked that volunteer to carry exactly that
 * person, which an honest or confused volunteer cannot get wrong silently
 * and a dishonest one can. So a volunteer can drop a track - it could always
 * do that by not relaying - and, until each sender signs their own frames,
 * it could show its own camera under another member's name.
 *
 * ## Where this sits beside the other transforms
 *
 * A sender or receiver has room for one transform. On the mesh path nothing
 * else wants it: the encryption transform is only installed on connections
 * to a server forwarder. The receiver side here is a tee - each frame is
 * copied into the relay and then handed on to this device's own decoder,
 * because a volunteer is on the call and still sees and hears the people it
 * carries. The sender side rides its own clock track and its own sender.
 *
 * ## What the browsers actually do
 *
 * Feature detection here is deliberately strict, because **advertising a
 * capability you cannot deliver is worse than not advertising**: a volunteer
 * that wins the selection and then cannot relay costs the pair a failed
 * connection and a round of fallback, where a volunteer that never offered
 * costs nothing.
 */
import type { EncodedFrameLike, FrameType } from './media-crypto.js'
import { assistPairKey, MAX_ASSISTED_PAIRS } from './peer-assist.js'
import { normaliseHex } from './hex.js'
import type { TrackRole } from './types.js'

export type { EncodedFrameLike } from './media-crypto.js'

/** How a browser lets script at the encoded frames. */
export type RelayMechanism =
  /** Chrome's `createEncodedStreams()` on the sender and receiver. */
  | 'insertable-streams'
  /** The standard `RTCRtpScriptTransform`, which runs in a worker. */
  | 'script-transform'
  /** Neither, so this browser cannot relay end-to-end encrypted media. */
  | 'none'

/** The globals feature detection looks at. A real `globalThis` satisfies it. */
export interface RelayScope {
  RTCRtpSender?: unknown
  RTCRtpReceiver?: unknown
  RTCRtpScriptTransform?: unknown
}

export interface RelayCapability {
  mechanism: RelayMechanism
  /**
   * Whether this browser can hand a sender frames the local encoder did not
   * produce - the one thing relaying actually needs.
   *
   * False is the answer whenever it has not been *measured* true, not
   * whenever it looks unlikely. See `detectRelayCapability`.
   */
  canForwardFrames: boolean
  /** What was missing, for honest copy in a UI. */
  missing: string[]
}

export interface DetectRelayOptions {
  /**
   * Treat a browser that offers only `RTCRtpScriptTransform` as able to
   * relay.
   *
   * Off by default, and the default is a statement about evidence rather than
   * about the API. Chromium relays through a script transform perfectly well
   * - both paths were measured carrying frames end to end. Safari and Firefox
   * expose the same API and attach the transform on both sides, and neither
   * could be measured carrying media at all in a headless harness, so
   * "Safari can relay" is untested rather than true.
   *
   * Turn this on when you have measured it on the browsers you support. Do
   * not turn it on because the API is present.
   */
  assumeScriptTransformRelays?: boolean
}

function hasMethod(ctor: unknown, name: string): boolean {
  const prototype = (ctor as { prototype?: Record<string, unknown> } | undefined)?.prototype
  return typeof prototype?.[name] === 'function'
}

function hasProperty(ctor: unknown, name: string): boolean {
  const prototype = (ctor as { prototype?: object } | undefined)?.prototype
  return prototype !== undefined && prototype !== null && name in prototype
}

/**
 * Work out whether this browser can relay, from the objects rather than from
 * the user agent.
 *
 * Both halves are required, and they are checked separately because a browser
 * that could read a receiver's frames but not replace a sender's would look
 * capable and relay nothing.
 */
export function detectRelayCapability(
  scope: RelayScope = globalThis as RelayScope,
  opts: DetectRelayOptions = {},
): RelayCapability {
  const missing: string[] = []

  const senderStreams = hasMethod(scope.RTCRtpSender, 'createEncodedStreams')
  const receiverStreams = hasMethod(scope.RTCRtpReceiver, 'createEncodedStreams')
  if (senderStreams && receiverStreams) {
    return { mechanism: 'insertable-streams', canForwardFrames: true, missing }
  }
  if (!senderStreams) missing.push('RTCRtpSender.createEncodedStreams')
  if (!receiverStreams) missing.push('RTCRtpReceiver.createEncodedStreams')

  const scriptTransform =
    scope.RTCRtpScriptTransform !== undefined &&
    hasProperty(scope.RTCRtpSender, 'transform') &&
    hasProperty(scope.RTCRtpReceiver, 'transform')
  if (scriptTransform) {
    return {
      mechanism: 'script-transform',
      canForwardFrames: opts.assumeScriptTransformRelays === true,
      missing: opts.assumeScriptTransformRelays === true ? [] : ['measured frame forwarding over RTCRtpScriptTransform'],
    }
  }
  missing.push('RTCRtpScriptTransform')

  return { mechanism: 'none', canForwardFrames: false, missing }
}

/**
 * The pair of streams a browser hands out for one sender or one receiver.
 *
 * `RTCRtpSender.createEncodedStreams()`'s return value satisfies this
 * structurally, and so does an `RTCRtpScriptTransformer` inside a worker,
 * which is why the pump below is written against this and not against either.
 */
export interface EncodedStreamPair {
  readable: ReadableStream<EncodedFrameLike>
  writable: WritableStream<EncodedFrameLike>
}

/**
 * How many frames may be held while waiting for a sender frame to carry them.
 *
 * Bounded for the same reason `MAX_PENDING_CANDIDATES` is: a source faster
 * than the clock would otherwise grow this array for as long as the call
 * lasts. The *oldest* goes when it overflows, because in live media the
 * newest frame is the one still worth sending - an old one arrives late
 * enough to be useless even if it arrives.
 *
 * Four seconds at 15fps: enough to ride out a stall, far too little to build
 * a latency problem out of.
 */
export const DEFAULT_RELAY_QUEUE = 60

export interface RelayStats {
  /** Frames taken off the inbound connection. */
  received: number
  /** Frames put onto the outbound connection. */
  forwarded: number
  /** Frames discarded because the queue was full - the clock is too slow. */
  dropped: number
  /** Outbound frames that found nothing to carry - the clock is too fast. */
  starved: number
  bytesIn: number
  bytesOut: number
}

function emptyStats(): RelayStats {
  return { received: 0, forwarded: 0, dropped: 0, starved: 0, bytesIn: 0, bytesOut: 0 }
}

/**
 * One direction of one relayed pair: frames off an inbound connection, onto
 * an outbound one, unchanged.
 *
 * Nothing here reads a frame's contents. The bytes are copied out of the
 * inbound frame and set on an outbound one, and the only thing consulted
 * about them is their length, for the byte counters that tell a person what
 * they are actually spending.
 */
export interface FrameRelayOptions {
  queue?: number
  /**
   * Treat the stream as video with key and delta frames.
   *
   * A delta frame is only any use to a decoder that has the frames it refers
   * to, so a video leg forwards nothing until a key frame arrives, and when
   * its queue overflows it drops back to the newest key frame rather than
   * shedding the oldest delta - which would leave the far end decoding
   * references to a frame it never got. Audio frames carry no type and are
   * independent, so an audio leg leaves this off.
   */
  keyFrames?: boolean
  /** A video leg is waiting for a key frame it does not have. The caller
   *  asks the source for one; this may be called often, so rate limit it. */
  onKeyFrameNeeded?: () => void
}

export class FrameRelay {
  readonly #queue: Array<{ data: ArrayBuffer; type?: FrameType }> = []
  readonly #limit: number
  readonly #stats = emptyStats()
  readonly #keyFrames: boolean
  readonly #onKeyFrameNeeded?: () => void
  #awaitingKey: boolean
  #closed = false

  constructor(opts: FrameRelayOptions = {}) {
    this.#limit = opts.queue !== undefined && opts.queue > 0 ? Math.floor(opts.queue) : DEFAULT_RELAY_QUEUE
    this.#keyFrames = opts.keyFrames === true
    this.#awaitingKey = this.#keyFrames
    this.#onKeyFrameNeeded = opts.onKeyFrameNeeded
  }

  get stats(): Readonly<RelayStats> {
    return this.#stats
  }

  get queued(): number {
    return this.#queue.length
  }

  /** True while a video leg has nothing it can start a decoder on. */
  get awaitingKeyFrame(): boolean {
    return this.#awaitingKey
  }

  /**
   * Take frames off an inbound receiver and hold them.
   *
   * Deliberately a `pipeTo` into a sink that enqueues nothing onwards: the
   * frames end here, so the local decoder is never handed ciphertext it
   * cannot open, and a relaying peer never spends a decode on media it is
   * only carrying.
   */
  consume(streams: EncodedStreamPair): void {
    void streams.readable
      .pipeTo(
        new WritableStream<EncodedFrameLike>({
          write: (frame) => {
            this.#accept(frame)
          },
        }),
      )
      // A closed connection ends the pipe. That is how a relayed leg
      // finishes, not a fault, and there is no console in this library.
      .catch(() => {})
  }

  /** Hold one inbound frame. Exposed for a worker-side pump that has already
   *  read the frame off a transformer rather than a stream. */
  accept(frame: EncodedFrameLike): void {
    this.#accept(frame)
  }

  #accept(frame: EncodedFrameLike): void {
    if (this.#closed) return
    const data = frame.data
    this.#stats.received += 1
    this.#stats.bytesIn += data.byteLength
    if (this.#keyFrames) {
      if (frame.type === 'key') this.#awaitingKey = false
      else if (this.#awaitingKey) {
        this.#stats.dropped += 1
        this.#wantKeyFrame()
        return
      }
    }
    // Copied, because the frame object belongs to the inbound pipeline and is
    // recycled the moment this returns.
    this.#queue.push({ data: data.slice(0), type: frame.type })
    if (this.#queue.length <= this.#limit) return
    if (!this.#keyFrames) {
      while (this.#queue.length > this.#limit) {
        this.#queue.shift()
        this.#stats.dropped += 1
      }
      return
    }
    // Video: keep the newest key frame and what follows it, or nothing.
    let key = -1
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      if (this.#queue[i]!.type === 'key') {
        key = i
        break
      }
    }
    const cut = key > 0 && this.#queue.length - key <= this.#limit ? key : this.#queue.length
    this.#queue.splice(0, cut)
    this.#stats.dropped += cut
    if (this.#queue.length === 0) {
      this.#awaitingKey = true
      this.#wantKeyFrame()
    }
  }

  #wantKeyFrame(): void {
    try {
      this.#onKeyFrameNeeded?.()
    } catch {
      // Asking for a key frame is a courtesy to the far end's decoder.
    }
  }

  /**
   * Drive an outbound sender: every frame the local encoder produces is
   * replaced by a relayed one.
   *
   * The clock track's own frames are never sent. If there is nothing queued
   * the frame is dropped rather than sent, because sending the clock's own
   * picture would put a blank rectangle on somebody's screen where a person
   * should be.
   */
  emit(streams: EncodedStreamPair): void {
    void streams.readable
      .pipeThrough(
        new TransformStream<EncodedFrameLike, EncodedFrameLike>({
          transform: (frame, controller) => {
            const carried = this.#next(frame)
            if (carried) controller.enqueue(frame)
          },
        }),
      )
      .pipeTo(streams.writable)
      .catch(() => {})
  }

  /** Load the next queued frame onto `frame`. False when there was nothing to
   *  carry, in which case the caller must drop the frame. */
  fill(frame: EncodedFrameLike): boolean {
    return this.#next(frame)
  }

  #next(frame: EncodedFrameLike): boolean {
    if (this.#closed) return false
    const next = this.#queue.shift()
    if (!next) {
      this.#stats.starved += 1
      return false
    }
    frame.data = next.data
    // A browser's encoded video frame has a read-only `type`, and assigning
    // it throws in a module. The packetiser reads the codec's own bitstream
    // for what kind of frame it is, so this is for frames that are plain
    // objects, and harmless to skip.
    if (next.type !== undefined) {
      try {
        frame.type = next.type
      } catch {
        // Read-only on a real frame.
      }
    }
    this.#stats.forwarded += 1
    this.#stats.bytesOut += next.data.byteLength
    return true
  }

  close(): void {
    this.#closed = true
    this.#queue.length = 0
  }
}

/**
 * Both directions of one relayed pair.
 *
 * A pair is the unit because that is what it costs: carrying A and B means
 * two streams in and two out, which is the number `assistCostBps` charges a
 * volunteer for.
 */
export class RelayPair {
  readonly key: string
  readonly a: string
  readonly b: string
  readonly #legs: Map<string, FrameRelay>
  /** Counters for a leg pumped somewhere this object cannot see - a worker
   *  - reported with `report`. Replace that leg's own counters. */
  readonly #reported = new Map<string, RelayStats>()
  /** The ends that have asked for this pair. See `asked`. */
  readonly #asked = new Set<string>()
  #closed = false

  constructor(a: string, b: string, opts: { queue?: number } = {}) {
    this.a = normaliseHex(a)
    this.b = normaliseHex(b)
    this.key = assistPairKey(a, b)
    this.#legs = new Map([
      [this.a, new FrameRelay(opts)],
      [this.b, new FrameRelay(opts)],
    ])
  }

  /**
   * Record that one end has asked for this pair to be carried.
   *
   * Consent runs per direction: a volunteer carries X's media to Y because X
   * asked, and for no other reason. An end that did not ask may have refused
   * the other one - blocked them, or kept its media from an agent - and its
   * media must never reach them through somebody else. `Mesh` only accepts
   * once both have asked, and the pump only wires a leg whose source asked.
   */
  ask(from: string): void {
    const device = normaliseHex(from)
    if (device === this.a || device === this.b) this.#asked.add(device)
  }

  /** Whether `from` has asked, and so whether its leg may be carried. */
  asked(from: string): boolean {
    return this.#asked.has(normaliseHex(from))
  }

  /** The directions that may be carried, `[from, to]`: one for each end that
   *  has asked, and none for an end that has not. */
  directions(): Array<readonly [string, string]> {
    const out: Array<readonly [string, string]> = []
    if (this.#asked.has(this.a)) out.push([this.a, this.b])
    if (this.#asked.has(this.b)) out.push([this.b, this.a])
    return out
  }

  /** Counters for `from`'s leg from a pump running elsewhere. */
  report(from: string, stats: RelayStats): void {
    const device = normaliseHex(from)
    if (this.#closed || !this.#legs.has(device)) return
    this.#reported.set(device, { ...stats })
  }

  /** The leg carrying `from`'s media towards the other end. Null for a device
   *  that is not one of this pair - which is a caller mistake, and answered
   *  rather than thrown because it happens inside a signalling handler. */
  leg(from: string): FrameRelay | null {
    return this.#legs.get(normaliseHex(from)) ?? null
  }

  /** The other end of this pair, from one end's point of view. */
  other(from: string): string | null {
    const device = normaliseHex(from)
    if (device === this.a) return this.b
    if (device === this.b) return this.a
    return null
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Both legs added together: what carrying this pair has actually cost. */
  get stats(): RelayStats {
    const total = emptyStats()
    for (const [device, leg] of this.#legs) {
      const stats = this.#reported.get(device) ?? leg.stats
      total.received += stats.received
      total.forwarded += stats.forwarded
      total.dropped += stats.dropped
      total.starved += stats.starved
      total.bytesIn += stats.bytesIn
      total.bytesOut += stats.bytesOut
    }
    return total
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const leg of this.#legs.values()) leg.close()
  }
}

/**
 * One of a source's tracks, carried one way through this device.
 *
 * `source` is the receiver on this device's connection to `from`, where
 * `from`'s own media already arrives because this device is on the call with
 * them. `sink` is the clock: a clone of that same received track, sent on
 * this device's connection to `to` so the encoder ticks at the source's own
 * rate, with every frame it produces replaced by one of the source's.
 */
export interface RelayLeg {
  pair: RelayPair
  from: string
  to: string
  role: TrackRole
  source: { track: MediaStreamTrack; receiver: unknown }
  sink: { clock: MediaStreamTrack; sender: unknown; transceiver?: unknown }
  /** This leg cannot be carried after all - a codec that turned out not to
   *  match, a transform the browser took back. The pair is dropped and both
   *  ends told, so they find another route rather than waiting on this one. */
  fail(reason: string): void
}

export interface RelayLegHandle {
  close(): void
}

/**
 * The browser half of carrying a pair: the encoded-frame transforms that
 * take a source's frames off one connection and put them on another.
 *
 * A seam rather than code here for the same reason as the forwarder's media
 * pipeline: a script transform needs a worker, and the worker's URL belongs
 * to the application's bundler. Without one, `Mesh` refuses every request to
 * carry a pair, because accepting a pair and then carrying nothing is the
 * failure peer assist was paused for.
 */
export interface RelayMediaPipeline {
  /** Whether this pipeline can carry anything at all, right now. */
  readonly ready: boolean
  /** This device is offering: get ready to carry, without carrying yet - a
   *  browser starts its worker here, so `ready` can become true. */
  warm?(): void
  /** This device has stopped offering: give back every receiver claimed by
   *  `prepare` that no leg is using. */
  release?(): void
  /**
   * A receiver this device might later be asked to tap. Called for every
   * track that arrives on a direct connection while this device is
   * offering, so a transform can be claimed before it is needed. Optional:
   * a pipeline that can attach late need not.
   */
  prepare?(receiver: unknown, track: MediaStreamTrack): void
  /** Start one leg. Null when it cannot be carried; the caller removes the
   *  clock and carries the pair's other tracks without it. */
  carry(leg: RelayLeg): RelayLegHandle | null
  close?(): void
}

export interface PeerRelayOptions {
  /** The most pairs this device will carry. Clamped to `MAX_ASSISTED_PAIRS`,
   *  which is the cap the protocol enforces however generous a local caller
   *  feels. */
  maxPairs?: number
  queue?: number
}

/**
 * Everything this device is carrying for other people, and the cap that stops
 * it carrying too much.
 *
 * The cap is enforced here rather than trusted to the selection, because
 * selection runs on every other client and this is the only place that knows
 * what this device has actually agreed to. Somebody who volunteers must not
 * have their own call ruined for it, and the number they advertised is a
 * claim like any other - including when it is their own.
 */
export class PeerRelay {
  readonly #pairs = new Map<string, RelayPair>()
  readonly #max: number
  readonly #queue?: number
  /** Pairs turned away since this device joined, so a UI can say so. */
  #refused = 0
  #closed = false

  constructor(opts: PeerRelayOptions = {}) {
    const asked = opts.maxPairs !== undefined && opts.maxPairs >= 0 ? Math.floor(opts.maxPairs) : MAX_ASSISTED_PAIRS
    this.#max = Math.min(asked, MAX_ASSISTED_PAIRS)
    this.#queue = opts.queue
  }

  /** How many pairs this device is carrying - the number that goes into its
   *  assist offer, and the reason a busy volunteer stops being chosen. */
  get relaying(): number {
    return this.#pairs.size
  }

  get max(): number {
    return this.#max
  }

  get refused(): number {
    return this.#refused
  }

  get pairs(): RelayPair[] {
    return [...this.#pairs.values()]
  }

  /**
   * Agree to carry a pair, or refuse.
   *
   * Null is a refusal, and it is an ordinary one: the pair that asked falls
   * through to the next volunteer, then a named forwarder, then TURN. Asking
   * again for a pair already carried returns the same handle rather than a
   * second slot, because both ends of a pair ask independently.
   */
  admit(a: string, b: string): RelayPair | null {
    if (this.#closed) return null
    const key = assistPairKey(a, b)
    const existing = this.#pairs.get(key)
    if (existing) return existing
    if (this.#pairs.size >= this.#max) {
      this.#refused += 1
      return null
    }
    const pair = new RelayPair(a, b, this.#queue === undefined ? {} : { queue: this.#queue })
    this.#pairs.set(key, pair)
    return pair
  }

  /** The pair being carried for these two, if any. */
  get(a: string, b: string): RelayPair | null {
    return this.#pairs.get(assistPairKey(a, b)) ?? null
  }

  /** Stop carrying one pair. */
  drop(a: string, b: string): void {
    const key = assistPairKey(a, b)
    const pair = this.#pairs.get(key)
    if (!pair) return
    this.#pairs.delete(key)
    pair.close()
  }

  /**
   * Stop carrying every pair one device is part of.
   *
   * What happens when an assisted device leaves, or its connection to this
   * one drops: the other end of that pair is not being relayed to anybody any
   * more, so holding the slot open would cost this device a slot it could
   * give somebody else.
   */
  dropDevice(device: string): number {
    const target = normaliseHex(device)
    let dropped = 0
    for (const [key, pair] of [...this.#pairs]) {
      if (pair.a !== target && pair.b !== target) continue
      this.#pairs.delete(key)
      pair.close()
      dropped += 1
    }
    return dropped
  }

  /** What relaying has cost this device, across everything it is carrying. */
  get stats(): RelayStats {
    const total = emptyStats()
    for (const pair of this.#pairs.values()) {
      const stats = pair.stats
      total.received += stats.received
      total.forwarded += stats.forwarded
      total.dropped += stats.dropped
      total.starved += stats.starved
      total.bytesIn += stats.bytesIn
      total.bytesOut += stats.bytesOut
    }
    return total
  }

  /**
   * Stop relaying entirely, without touching anything else.
   *
   * This is what revoking consent mid-call does. Every pair being carried
   * loses its relay and falls back; nobody's room ends, including this
   * device's own, because none of this was ever load-bearing for its own
   * connections.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const pair of this.#pairs.values()) pair.close()
    this.#pairs.clear()
  }

  /** True once `close` has been called and until `reopen` is. */
  get closed(): boolean {
    return this.#closed
  }

  /**
   * Be willing to carry pairs again after a revocation.
   *
   * Somebody who turns assisting off mid-call and changes their mind ten
   * minutes later is an ordinary thing to do, and without this the second
   * decision does not take: the offer goes back on the wire, this device wins
   * selections with it, and `admit` refuses every one of them. That is
   * precisely the "advertising a capability you cannot deliver" failure the
   * rest of this module is built to avoid, arrived at from the inside.
   *
   * Nothing carried before the revocation comes back. Those pairs were
   * dropped and have found another route by now, and re-adopting them would
   * take them off a working path.
   */
  reopen(): void {
    this.#closed = false
  }
}
