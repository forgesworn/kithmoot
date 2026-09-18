/**
 * One profile-2 connection to one remote device: fixed media slots (S4) and
 * generations (S5) of the call reliability design.
 *
 * `Peer` and this class are siblings rather than one class with a flag. They
 * negotiate differently enough that a shared method would be a branch in every
 * line of it - `Peer` offers because a track was added, this one offers only
 * to open a generation or to carry an ICE restart - and the profile-1 path is
 * what every far end from before today speaks, including the current Android
 * build, so it must not move at all while this lands. The mesh holds them both
 * behind `NegotiatingPeer` and chooses per pair.
 *
 * What is different, in one paragraph. Four `sendrecv` transceivers - mic,
 * camera, screen, screen-audio - are created once, by whichever side opens the
 * generation, and every media change afterwards is `replaceTrack`: no offer,
 * no answer, nothing to lose on a relay. Every signal carries `gen` and
 * `conn`, so the two ends can always tell "this is about the connection we are
 * both on" from "this is about one of us that no longer exists" - which
 * profile 1 cannot say at all, and which is H2. Signalling goes through
 * `SignalChannel`, so an offer or an answer is retransmitted until it is
 * acknowledged rather than until a retry counter runs out.
 *
 * Healing beyond an ICE restart inside the generation is deliberately not here
 * yet: the pair-health ladder is S7 and S8, and until it lands the mesh's
 * route ladder owns a pair that will not come up, exactly as it does for
 * profile 1.
 */

import { normaliseHex } from './hex.js'
import { SignalChannel } from './signal-channel.js'
import type { ChannelClock, ChannelSignal } from './signal-channel.js'
import {
  ICE_RESTART_GRACE_MS,
  ICE_RESTART_TIMEOUT_MS,
  MAX_PENDING_CANDIDATES,
} from './peer.js'
import type { NegotiatingPeer, PeerContext, PeerFactory, RouteTier, RTCPeerConnectionLike } from './peer.js'
import { SlotSet, inferRoles, supportsSlots } from './peer-slots.js'
import type { RoleResolver, SlotConnection } from './peer-slots.js'
import { decideOffer, nextGeneration } from './peer-generation.js'
import type { OutstandingOffer } from './peer-generation.js'
import type { SignalBody } from './signal.js'
import type { TrackRole } from './types.js'

const REAL_CLOCK: ChannelClock = {
  now: () => Date.now(),
  setTimer: (ms, run) => {
    const timer = setTimeout(run, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * How often one slot may be re-attached in answer to a `health` report.
 *
 * §3.4's "once per 10s per slot". A far end whose decoder is stuck keeps
 * saying so; re-keying this side's encoder every two seconds in reply would
 * be the fault rather than the repair.
 */
export const SLOT_REPAIR_MS = 10_000

/** A connection instance id: 16 lower-case hex, fresh per
 *  `RTCPeerConnection` and never reused, per §2.2. */
function randomConnectionId(): string {
  const bytes = new Uint8Array(8)
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface SlotPeerOptions {
  factory: PeerFactory
  localDevice: string
  remoteDevice: string
  onSignal: (body: SignalBody) => void
  /** `role` is resolved from the transceiver mid against the
   *  generation-opening offer's `slots` map, so the app never guesses. */
  onTrack: (track: MediaStreamTrack, receiver?: unknown, role?: TrackRole) => void
  onConnectionState?: (state: RTCPeerConnectionState) => void
  /**
   * A profile-1 shaped signal arrived from a device believed to speak profile
   * 2 - which is what a far end reloading into an old build looks like
   * (§2.3). This peer stops; the caller rebuilds the pair legacy-style,
   * because everything this class does from here would be addressed to a
   * connection the far end no longer has.
   */
  onDowngrade?: (body: SignalBody) => void
  /**
   * The far end reports one of our slots dead and this side cannot repair it
   * because the local track has ended - a camera another application took, a
   * microphone that was unplugged.
   *
   * Only the application can answer that: it owns the media pipeline and the
   * permission prompt. See §3.4's "run app media recovery".
   */
  onSlotRecovery?: (role: TrackRole) => void
  /** Which rung this connection is being opened on. Adopted from an incoming
   *  offer's `tier` when a higher generation is adopted. */
  context?: PeerContext
  /** Which slot each published track belongs in. The app knows - it
   *  advertises exactly this role - and `inferRoles` is only the fallback for
   *  a caller that has not been taught to say yet. */
  trackRole?: RoleResolver
  /** How a connection that was up is given the chance to come back. Defaults
   *  to `ICE_RESTART_GRACE_MS` and `ICE_RESTART_TIMEOUT_MS`. */
  iceRestart?: { graceMs?: number; timeoutMs?: number }
  /** Retransmission schedule for the reliable channel. Defaults are the
   *  channel's own; tests shorten them. */
  signalRetry?: {
    intervalMs?: number
    maxIntervalMs?: number
    jitter?: number
    ackDelayMs?: number
    syncMs?: number
    bufferLimit?: number
  }
  random?: () => number
  clock?: ChannelClock
  /** Test seam: where connection ids come from. */
  connectionId?: () => string
}

export class SlotPeer implements NegotiatingPeer {
  readonly polite: boolean

  readonly #opts: SlotPeerOptions
  readonly #clock: ChannelClock
  readonly #newConnectionId: () => string
  readonly #graceMs: number
  readonly #timeoutMs: number

  #pc: RTCPeerConnectionLike | undefined
  #slots: SlotSet | undefined
  /**
   * The generation's mid-to-role map, held beside the slots rather than only
   * inside them.
   *
   * An answerer's `ontrack` fires inside `setRemoteDescription(offer)` - one
   * per receiving m-line, all four of them, whether or not the far end has
   * anything in that slot yet - which is before there is anything to bind the
   * slots to. Read off the offer first, the role is known for every one of
   * those events; read off the transceivers, the first four tracks of every
   * connection would arrive unlabelled and the app would be back to guessing.
   */
  #slotMap: Record<string, TrackRole> | undefined
  #channel: SignalChannel | undefined
  #conn = ''
  #gen = 0
  /** The highest generation ever seen from the far end, whether or not it was
   *  adopted. A rebuild goes above both sides' highest, so a number is never
   *  reused even when the two rebuilt in opposite orders. */
  #lastRemoteGen = 0
  /** Whether this side created the transceivers for the current generation.
   *  Only the opener may, and only once: see amendment A1. */
  #opener = false
  /** The seq of our outstanding offer, and whether it opened the generation.
   *  Together they are the glare column of §3.3's table. */
  #openingOfferSeq: number | undefined
  #tier: RouteTier
  #tracks: MediaStreamTrack[] = []
  #hasRemoteDescription = false
  #pendingCandidates: RTCIceCandidateInit[] = []
  #closed = false
  #downgraded = false
  #operations: Promise<unknown> = Promise.resolve()

  #everConnected = false
  #restarted = false
  #graceTimer: unknown
  #giveUpTimer: unknown
  /** Offers the connection raised `negotiationneeded` for that this class did
   *  not ask for. Expected to stay zero on a profile-2 connection; anything
   *  else is a code path calling `addTrack` and is worth a diagnostic. */
  #unexpectedNegotiations = 0
  /** When each slot was last re-attached because the far end said it was
   *  dead. See `SLOT_REPAIR_MS`. */
  readonly #repairedAt = new Map<TrackRole, number>()

  constructor(opts: SlotPeerOptions) {
    this.#opts = opts
    this.#clock = opts.clock ?? REAL_CLOCK
    this.#newConnectionId = opts.connectionId ?? randomConnectionId
    this.#graceMs = opts.iceRestart?.graceMs ?? ICE_RESTART_GRACE_MS
    this.#timeoutMs = opts.iceRestart?.timeoutMs ?? ICE_RESTART_TIMEOUT_MS
    this.#tier = opts.context?.tier ?? 'direct'
    // Normalised, because the two sides MUST reach opposite answers and `<`
    // is not case-insensitive. Same reasoning as `Peer`.
    this.polite = normaliseHex(opts.localDevice) < normaliseHex(opts.remoteDevice)
  }

  // ------------------------------------------------------------ diagnostics

  /** The generation this pair is currently on. */
  get generation(): number {
    return this.#gen
  }

  /** This side's current connection instance id. */
  get connectionId(): string {
    return this.#conn
  }

  /** The connection object, for a caller that samples stats off it. */
  get connection(): RTCPeerConnectionLike | undefined {
    return this.#pc
  }

  /** How many signals are still waiting to be acknowledged. */
  get queueDepth(): number {
    return this.#channel?.queueDepth ?? 0
  }

  /** `negotiationneeded` firing for something other than an ICE restart. */
  get unexpectedNegotiations(): number {
    return this.#unexpectedNegotiations
  }

  /** The generation's mid-to-role map, for a caller that samples stats off
   *  the connection and has to know which m-line is which slot. */
  get slotMap(): Record<string, TrackRole> | undefined {
    return this.#slotMap
  }

  /** The rung this connection was opened on. */
  get tier(): RouteTier {
    return this.#tier
  }

  /** What each slot is doing. Undefined before a generation is open. */
  slotState(role: TrackRole): 'idle' | 'sending' | 'broken' | undefined {
    return this.#slots?.state(role)
  }

  // ----------------------------------------------------------------- public

  /**
   * Publish this set of tracks to this peer.
   *
   * The first call opens a generation. Every later call is `replaceTrack` into
   * slots that already exist, and emits nothing at all - which is the whole of
   * D1: a camera toggle, a share, a mic pipeline swap and an audience
   * narrowing are all the same act, and none of them is a negotiation.
   */
  async start(tracks: MediaStreamTrack[]): Promise<void> {
    this.#tracks = [...tracks]
    return this.#enqueue(async () => {
      if (this.#closed || this.#downgraded) return
      if (!this.#pc) {
        await this.#openGeneration(nextGeneration(this.#gen, this.#lastRemoteGen))
        return
      }
      await this.#applyTracks()
    })
  }

  async handleSignal(body: SignalBody): Promise<void> {
    return this.#enqueue(() => this.#handleSignal(body))
  }

  /** A publish was rejected outright, so nothing left the device. */
  retransmitNow(): void {
    this.#channel?.retransmitNow()
  }

  /** The relay transport came back after a half-open socket. Everything
   *  unacked goes out at once rather than waiting out a backoff step armed
   *  before the wire existed. */
  reconnected(): void {
    this.#channel?.reconnected()
  }

  /** The caller's watchdog says this negotiation is stuck. ICE is restarted
   *  inside the generation; a rebuild is the ladder's call, not a timer's. */
  healStalledNegotiation(): void {
    void this.#enqueue(async () => {
      if (this.#closed || !this.#pc) return
      this.#restartIce()
    }).catch(() => {})
  }

  /**
   * Throw this connection away and open the next generation.
   *
   * Step 2 and step 3 of §3.4's ladder. Safe to call at any moment because
   * the generation number is what makes it safe: it goes above both sides'
   * highest, so the far end adopts it whatever it was in the middle of, and
   * nothing addressed to the connection this replaces can be mistaken for
   * something addressed to the new one.
   */
  rebuild(tier?: RouteTier): void {
    if (tier) this.#tier = tier
    void this.#enqueue(() => this.#openGeneration(nextGeneration(this.#gen, this.#lastRemoteGen))).catch(() => {})
  }

  /**
   * Tell the far end what this side is receiving from it, per slot.
   *
   * Sent unreliably on purpose: it describes what is happening right now, and
   * a copy of it retransmitted eight seconds later would ask the far end to
   * repair a slot that has since come back. §3.4 sends it only for the one
   * thing RTCP cannot express - a single dead slot on a transport that is
   * otherwise fine.
   */
  reportHealth(rx: Partial<Record<TrackRole, 'ok' | 'dead'>>): void {
    if (this.#closed || !this.#channel) return
    if (Object.keys(rx).length === 0) return
    this.#channel.sendUnreliable({ type: 'health', rx })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#teardownConnection()
  }

  // ------------------------------------------------------------- generations

  /**
   * Open a generation: a fresh connection, four fresh slots, and an offer
   * carrying the map from mid to role.
   *
   * The slots are created **here and only here**. An answerer that created its
   * own could not associate them with the offerer's m-lines - JSEP only reuses
   * `addTrack`-created transceivers - so the browser would raise
   * `negotiationneeded` and offer four more, and glare would double the m-line
   * count for the life of the pair. That is amendment A1, and it is why there
   * is no shared "make the connection" helper between this and `#answer`.
   */
  async #openGeneration(gen: number): Promise<void> {
    this.#teardownConnection()
    if (this.#closed) return
    this.#gen = gen
    this.#opener = true
    this.#conn = this.#newConnectionId()
    const pc = this.#build()
    if (!supportsSlots(pc)) throw new Error('connection cannot carry fixed media slots')
    this.#slots = SlotSet.open(pc as SlotConnection)
    await this.#applyTracks()
    this.#channel = this.#openChannel({})
    await this.#offer({ opening: true })
  }

  /**
   * Answer a generation the far end opened: a fresh connection with **no**
   * local transceivers, the offer applied, the slots bound from its map, and
   * only then an answer.
   */
  async #answer(gen: number, body: SignalBody): Promise<void> {
    const slots = body.slots
    if (!slots) return
    this.#teardownConnection()
    if (this.#closed) return
    this.#gen = gen
    this.#lastRemoteGen = Math.max(this.#lastRemoteGen, gen)
    this.#opener = false
    this.#conn = this.#newConnectionId()
    // The far end said which rung it is on; meeting it there is what stops
    // the two of them chasing each other round the ladder.
    if (body.tier) this.#tier = body.tier
    this.#build()
    this.#channel = this.#openChannel({ peerConn: body.conn, expectedSeq: body.seq })
    // Fed through the channel rather than handled directly, so its seq is
    // acked and counted exactly as every other signal's is.
    this.#channel.receive(body as unknown as ChannelSignal)
  }

  #openChannel(init: { peerConn?: string; expectedSeq?: number }): SignalChannel {
    return new SignalChannel({
      gen: this.#gen,
      conn: this.#conn,
      peerConn: init.peerConn,
      expectedSeq: init.expectedSeq,
      send: (body) => this.#emit(body),
      deliver: (body) => {
        void this.#enqueue(() => this.#deliver(body)).catch(() => {})
      },
      onNewerGeneration: (gen, body) => {
        this.#lastRemoteGen = Math.max(this.#lastRemoteGen, gen)
        // Only an offer can be adopted: it is the only signal that carries a
        // slot map, and without one there is nothing to bind. A `sync` or a
        // stray candidate from a newer generation is remembered - so our own
        // next rebuild goes above it - and otherwise ignored, because the far
        // end is retransmitting its offer and that is what we will act on.
        if (body.type !== 'offer' || !(body as unknown as SignalBody).slots) return
        void this.#enqueue(() => this.#answer(gen, body as unknown as SignalBody)).catch(() => {})
      },
      onForeignConnection: () => {
        // Our generation, a connection we have never heard of, nothing
        // outstanding to explain it. §3.3 calls that a protocol error, and
        // going up is the only repair that cannot be argued with.
        void this.#enqueue(() => this.#openGeneration(nextGeneration(this.#gen, this.#lastRemoteGen))).catch(() => {})
      },
      localDescription: (type) => {
        const local = this.#pc?.localDescription
        return local?.type === type ? local.sdp : undefined
      },
      timing: this.#opts.signalRetry,
      random: this.#opts.random,
      clock: this.#clock,
    })
  }

  #build(): RTCPeerConnectionLike {
    const pc = this.#opts.factory({ tier: this.#tier, remoteDevice: this.#opts.remoteDevice })
    this.#pc = pc
    this.#hasRemoteDescription = false
    this.#pendingCandidates = []

    pc.ontrack = (event) => {
      const mid = event.transceiver?.mid
      const role = (mid === null || mid === undefined ? undefined : this.#slotMap?.[mid]) ?? this.#slots?.roleOf(mid)
      this.#opts.onTrack(event.track, event.receiver, role)
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.#channel?.send({ type: 'ice', candidate: JSON.stringify(event.candidate) })
    }

    // Deliberately not an offer. Every media change on this connection is a
    // `replaceTrack`, which raises nothing; the only negotiation this class
    // ever starts is a generation or an ICE restart, and both are explicit.
    // So a `negotiationneeded` here means some other code path called
    // `addTrack` on a slotted connection, which would grow the m-lines - the
    // risk named in section 9 of the spec. Counted, never acted on.
    //
    // Only once the generation exists, though. Opening one sets the browser's
    // own negotiation-needed flag four times - that is what `addTransceiver`
    // is - and the event for it arrives while the opening offer is still in
    // flight. Counting that would put `unexpected-negotiations=1` on every
    // healthy pair in every bug report, which is a counter that says nothing.
    pc.onnegotiationneeded = () => {
      if (this.#hasRemoteDescription) this.#unexpectedNegotiations += 1
    }

    pc.onconnectionstatechange = () => this.#onConnectionState(pc)
    return pc
  }

  #onConnectionState(pc: RTCPeerConnectionLike): void {
    if (this.#pc !== pc) return
    const state = pc.connectionState
    if (state === 'connected') {
      this.#clearRestartTimers()
      this.#everConnected = true
      this.#restarted = false
    }
    if (state === 'disconnected') {
      this.#opts.onConnectionState?.(state)
      if (this.#everConnected && !this.#restarted && pc.restartIce) {
        this.#clearGraceTimer()
        this.#graceTimer = this.#clock.setTimer(this.#graceMs, () => {
          this.#graceTimer = undefined
          if (this.#pc === pc && pc.connectionState === 'disconnected') this.#restartIce()
        })
      }
      return
    }
    if (state === 'failed' && this.#everConnected && !this.#restarted && pc.restartIce) {
      this.#restartIce()
      return
    }
    this.#opts.onConnectionState?.(state)
    if (state === 'failed' || state === 'closed') this.close()
  }

  /**
   * Gather again on the connection that exists, and say so.
   *
   * Inside the generation: the m-lines, their order and their mids do not
   * move, so the far end applies it to the session it already has. A rebuild
   * at `gen + 1` is a different act with a different cost, and the pair-health
   * ladder (S8) is what decides to take it.
   */
  #restartIce(): void {
    const pc = this.#pc
    if (this.#closed || !pc) return
    this.#restarted = true
    this.#clearRestartTimers()
    pc.restartIce?.()
    void this.#enqueue(() => this.#offer({ restart: true })).catch(() => {})
    this.#giveUpTimer = this.#clock.setTimer(this.#timeoutMs, () => {
      this.#giveUpTimer = undefined
      if (this.#closed || this.#pc !== pc || pc.connectionState === 'connected') return
      this.#opts.onConnectionState?.('failed')
      this.close()
    })
  }

  // -------------------------------------------------------------- signalling

  async #offer(opts: { opening?: boolean; restart?: boolean }): Promise<void> {
    const pc = this.#pc
    const channel = this.#channel
    if (this.#closed || !pc || !channel) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const body: ChannelSignal = { type: 'offer', sdp: offer.sdp, tier: this.#tier }
    if (opts.restart) body.restart = true
    if (opts.opening) {
      // Mids only become real at `setLocalDescription`, which is why the map
      // is read here and not when the slots were created.
      const map = this.#slots?.map()
      if (!map) throw new Error('slot map is incomplete: the connection assigned no mids')
      body.slots = map
      this.#slotMap = map
    }
    const seq = channel.send(body)
    this.#openingOfferSeq = opts.opening ? seq : undefined
  }

  #outstanding(): OutstandingOffer {
    const seq = this.#channel?.outstandingOffer
    if (seq === undefined) return 'none'
    return seq === this.#openingOfferSeq ? 'opening' : 'in-generation'
  }

  async #handleSignal(body: SignalBody): Promise<void> {
    if (this.#closed || this.#downgraded) return

    // §2.3: a profile-1 shaped signal from a device believed to speak profile
    // 2 downgrades the pair. Nothing here can serve it - it has no generation
    // to belong to and no connection id to be addressed at - so this peer
    // stands aside and the caller rebuilds legacy-style.
    if (body.gen === undefined) {
      if (body.type !== 'offer' && body.type !== 'answer' && body.type !== 'ice') return
      this.#downgraded = true
      this.#teardownConnection()
      this.#opts.onDowngrade?.(body)
      return
    }

    this.#lastRemoteGen = Math.max(this.#lastRemoteGen, body.gen)

    if (!this.#pc || !this.#channel) {
      // No connection yet: the far end got its offer out before this side
      // opened anything. Answering it is cheaper and more reliable than
      // opening a generation of our own and resolving the glare.
      if (body.type === 'offer' && body.slots) await this.#answer(body.gen, body)
      return
    }

    if (body.type === 'offer') {
      const action = decideOffer({
        incomingGen: body.gen,
        currentGen: this.#gen,
        incomingConn: body.conn,
        boundConn: this.#channel.peerConn,
        outstanding: this.#outstanding(),
        polite: this.polite,
        opensGeneration: body.slots !== undefined,
      })
      switch (action.do) {
        case 'ignore':
          // Impolite, and our own offer is out. Saying nothing is the
          // answer: the far end is polite and is about to give way.
          return
        case 'rebuild-connection':
          await this.#answer(this.#gen, body)
          return
        case 'rollback': {
          // In-generation glare. Nothing was created for our offer, so
          // A1's reason to discard the connection does not apply and an
          // ordinary rollback is both correct and far cheaper than throwing
          // away a connection that is carrying media.
          const seq = this.#channel.outstandingOffer
          await this.#pc.setLocalDescription({ type: 'rollback' })
          this.#hasRemoteDescription = false
          if (seq !== undefined) this.#channel.drop(seq)
          this.#openingOfferSeq = undefined
          break
        }
        case 'rebuild-generation':
          await this.#openGeneration(action.gen)
          return
        case 'adopt':
          await this.#answer(action.gen, body)
          return
        // 'sync' and 'negotiate' are the channel's to carry out: it rate
        // limits the sync and it owns seq ordering for the negotiation.
        default:
          break
      }
    }

    this.#channel.receive(body as unknown as ChannelSignal)
  }

  /** In-order, deduplicated delivery from the channel. */
  async #deliver(body: ChannelSignal): Promise<void> {
    if (this.#closed || !this.#pc) return
    const signal = body as unknown as SignalBody
    if (signal.type === 'offer') await this.#applyOffer(signal)
    else if (signal.type === 'answer') await this.#applyAnswer(signal)
    else if (signal.type === 'ice') await this.#applyIce(signal)
    else if (signal.type === 'health') await this.#applyHealth(signal)
  }

  /**
   * The far end says a slot of ours is arriving as nothing.
   *
   * It only ever says so about a *single* slot on a transport it is otherwise
   * happy with - everything worse than that is a rebuild it takes itself - so
   * the repair is local and cheap: swap the track out of the slot and back
   * in, which restarts the encode without touching the m-line.
   *
   * Rate limited per slot, because a far end whose decoder is genuinely stuck
   * will keep saying so for as long as it is stuck, and re-keying the encoder
   * every two seconds would be the fault rather than the fix.
   */
  async #applyHealth(body: SignalBody): Promise<void> {
    const rx = body.rx
    if (!rx || !this.#slots) return
    const now = this.#clock.now()
    for (const [role, verdict] of Object.entries(rx) as [TrackRole, 'ok' | 'dead'][]) {
      if (verdict !== 'dead') continue
      const last = this.#repairedAt.get(role)
      if (last !== undefined && now - last < SLOT_REPAIR_MS) continue
      this.#repairedAt.set(role, now)
      const outcome = await this.#slots.refresh(role)
      if (outcome === 'ended') this.#opts.onSlotRecovery?.(role)
      else if (outcome === 'broken') {
        // The only path in §3.1 where a slot change still costs a
        // negotiation, and the answer to it is the same as everywhere else.
        this.rebuild()
        return
      }
    }
  }

  async #applyOffer(body: SignalBody): Promise<void> {
    const pc = this.#pc
    const channel = this.#channel
    if (!pc || !channel) return

    // Before the description, not after: `ontrack` fires inside it.
    if (body.slots && !this.#opener) this.#slotMap = body.slots
    await pc.setRemoteDescription({ type: 'offer', sdp: body.sdp })
    this.#hasRemoteDescription = true

    // The one window in which the slots can still be widened to `sendrecv`:
    // an answer may only ever narrow what it describes, so a slot not bound
    // here is a slot this side can never send on for the life of the
    // generation.
    if (body.slots && !this.#opener && !this.#slots) {
      if (!supportsSlots(pc)) throw new Error('connection cannot carry fixed media slots')
      this.#slots = SlotSet.bind(pc as SlotConnection, body.slots)
      await this.#applyTracks()
    }

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    channel.send({ type: 'answer', sdp: answer.sdp, re: body.seq })
    await this.#drainCandidates()
  }

  async #applyAnswer(body: SignalBody): Promise<void> {
    const pc = this.#pc
    if (!pc) return
    // The channel has already checked this answers the offer we are actually
    // waiting on, so anything that reaches here belongs to it.
    if (pc.signalingState !== 'have-local-offer') return
    await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp })
    this.#openingOfferSeq = undefined
    this.#hasRemoteDescription = true
    await this.#drainCandidates()
  }

  async #applyIce(body: SignalBody): Promise<void> {
    const raw = body.candidates ?? (body.candidate !== undefined ? [body.candidate] : [])
    for (const json of raw) {
      let candidate: RTCIceCandidateInit
      try {
        candidate = JSON.parse(json) as RTCIceCandidateInit
      } catch {
        continue
      }
      if (!this.#hasRemoteDescription) {
        this.#pendingCandidates.push(candidate)
        while (this.#pendingCandidates.length > MAX_PENDING_CANDIDATES) this.#pendingCandidates.shift()
        continue
      }
      await this.#applyCandidate(candidate)
    }
  }

  async #drainCandidates(): Promise<void> {
    const pending = this.#pendingCandidates
    this.#pendingCandidates = []
    for (const candidate of pending) await this.#applyCandidate(candidate)
  }

  /** Never throws: losing one candidate costs a path, letting the rejection
   *  escape costs the negotiation it was inside. Same rule as `Peer`. */
  async #applyCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.#pc?.addIceCandidate(candidate)
    } catch {
      // Deliberately swallowed - see above.
    }
  }

  #emit(body: ChannelSignal): void {
    this.#opts.onSignal({ roomId: '', ...body } as unknown as SignalBody)
  }

  // ------------------------------------------------------------------ slots

  async #applyTracks(): Promise<void> {
    const slots = this.#slots
    if (!slots) return
    const inferred = this.#opts.trackRole ? undefined : inferRoles(this.#tracks)
    const resolve: RoleResolver = this.#opts.trackRole ?? ((track) => inferred?.get(track))
    const broken = await slots.apply(this.#tracks, resolve)
    if (broken.length === 0) return
    // The only path in §3.1 where a slot change still costs a negotiation.
    // Expected never to happen; if it does, a rebuild is the repair, and it
    // goes above both sides' highest generation like every other rebuild.
    void this.#enqueue(() => this.#openGeneration(nextGeneration(this.#gen, this.#lastRemoteGen))).catch(() => {})
  }

  // ------------------------------------------------------------------ plumbing

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(op, op)
    this.#operations = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /**
   * Give up the current connection entirely.
   *
   * The channel goes first and the handlers are unhooked before the close, so
   * nothing that was in flight for the old connection can reach the new one:
   * a retransmission addressed to a `conn` that no longer exists, a candidate
   * for a description nobody holds, or a `closed` state change that would be
   * mistaken for the pair failing. "A rebuild offer never reaches the old
   * connection" is a property of this method.
   */
  #teardownConnection(): void {
    this.#clearRestartTimers()
    this.#channel?.close()
    this.#channel = undefined
    this.#slots = undefined
    this.#slotMap = undefined
    this.#openingOfferSeq = undefined
    this.#hasRemoteDescription = false
    this.#pendingCandidates = []
    this.#everConnected = false
    this.#restarted = false
    this.#repairedAt.clear()
    const pc = this.#pc
    this.#pc = undefined
    if (!pc) return
    pc.ontrack = null
    pc.onicecandidate = null
    pc.onnegotiationneeded = null
    pc.onconnectionstatechange = null
    pc.close()
  }

  #clearGraceTimer(): void {
    if (this.#graceTimer !== undefined) this.#clock.clearTimer(this.#graceTimer)
    this.#graceTimer = undefined
  }

  #clearRestartTimers(): void {
    this.#clearGraceTimer()
    if (this.#giveUpTimer !== undefined) this.#clock.clearTimer(this.#giveUpTimer)
    this.#giveUpTimer = undefined
  }
}
