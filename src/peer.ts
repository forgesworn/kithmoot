import { normaliseHex } from './hex.js'
import type { SignalBody } from './signal.js'

/**
 * The subset of `RTCPeerConnection` that `Peer` actually touches. A real
 * `RTCPeerConnection` satisfies this structurally, so a browser factory
 * needs no adapter; a test factory can hand out a double that implements
 * nothing else.
 */
export interface RTCPeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInit>
  createAnswer(): Promise<RTCSessionDescriptionInit>
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>
  addTrack(track: MediaStreamTrack): void
  /** What this connection is currently sending. Optional alongside
   *  `removeTrack`: a device that never turns anything off never needs
   *  either, and a test double is free to model neither. */
  getSenders?(): readonly { readonly track: MediaStreamTrack | null }[]
  removeTrack?(sender: { readonly track: MediaStreamTrack | null }): void
  /** Gather fresh candidates on the connection that exists, rather than
   *  building a new one. Optional: a double that never models a network
   *  blip need not have it, and `Peer` then fails the way it always did. */
  restartIce?(): void
  close(): void
  readonly signalingState: RTCSignalingState
  readonly localDescription: RTCSessionDescriptionInit | null
  readonly connectionState: RTCPeerConnectionState
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null
  onconnectionstatechange: (() => void) | null
  onnegotiationneeded: (() => void) | null
}

/**
 * How a connection is being routed, worst case first in cost to everybody
 * else.
 *
 * The order is the order the mesh tries them in, and it is the whole point of
 * stage 6: most pairs connect directly and cost nobody anything, so a room
 * that starts at TURN has put a server it pays for in the path of a
 * connection that never needed one.
 */
export type RouteTier =
  /** Peer to peer. Always tried first. */
  | 'direct'
  /** Through a member of the room who volunteered to carry it. */
  | 'assist'
  /** Through a forwarder the room descriptor names. */
  | 'forwarder'
  /** Through a TURN server. The floor, not the default. */
  | 'turn'

/** What the mesh is about to open a connection for. */
export interface PeerContext {
  tier: RouteTier
  /** The endpoint being connected to. Not necessarily the device whose media
   *  will arrive on it - at `assist` that is a volunteer carrying somebody
   *  else's. */
  remoteDevice: string
}

/**
 * Builds a connection.
 *
 * The context is what lets an app give a `direct` connection STUN only and a
 * `turn` connection the TURN credentials, which is how the selection order is
 * actually enforced: ICE will happily relay through a TURN server that is in
 * the list, so keeping it out of the list until the last rung is the only way
 * to make the earlier rungs mean anything.
 *
 * Optional, so a factory written before any of this existed still satisfies
 * the type and simply ignores it - at the cost of every rung looking the
 * same to ICE.
 */
export interface PeerFactory {
  (context?: PeerContext): RTCPeerConnectionLike
}

/**
 * How many candidates may be held while waiting for the description they
 * belong to.
 *
 * A remote device that trickles candidates and never sends a description -
 * hostile, or simply broken - would otherwise grow this array for as long as
 * the room is open. Generous enough that a real negotiation never touches it:
 * a dual-stack host with a handful of interfaces gathers a few dozen.
 */
export const MAX_PENDING_CANDIDATES = 64

/**
 * How long a connected peer is given to heal a `disconnected` on its own
 * before ICE is restarted on it.
 *
 * Most disconnections are a router hiccup or a phone changing cell and heal
 * inside a couple of seconds; a restart during that window only adds a
 * negotiation to a path that was about to come back.
 */
export const ICE_RESTART_GRACE_MS = 3_000

/**
 * How long a restarted connection is given to reach `connected` again before
 * the peer gives up on it and lets the route ladder take over.
 */
export const ICE_RESTART_TIMEOUT_MS = 10_000

/**
 * How long an offer waits for its answer before it is sent again.
 *
 * Perfect negotiation assumes the signalling channel delivers. This one does
 * not promise to: a signal is an ephemeral event on a public relay, delivered
 * to whoever is subscribed at the instant it arrives and kept for nobody. An
 * offer that lands a moment before the far end is listening is gone, and the
 * far end has no way to know it was ever sent - so nothing on that side can
 * ask for it again. The offerer is the only one who knows, and it knows only
 * by the silence. Long enough that a slow relay round trip is not mistaken
 * for a lost one; short enough to be over before the route ladder
 * (`DEFAULT_ROUTE_TIMEOUT_MS`) gives up on a rung that would have worked.
 */
export const OFFER_RETRY_MS = 3_000

/**
 * How many times an unanswered offer is re-sent before the peer stops
 * asking and leaves the route ladder to decide.
 */
export const MAX_OFFER_RETRIES = 2

export interface PeerOptions {
  factory: PeerFactory
  localDevice: string
  remoteDevice: string
  onSignal: (body: SignalBody) => void
  onTrack: (track: MediaStreamTrack) => void
  /**
   * Whether this side has to open the conversation even with nothing to
   * send.
   *
   * False for an ordinary peer: two devices in a room both offer when they
   * have media, so a device with its camera and microphone off can simply
   * answer and receive. True for a forwarder, which is a server that only
   * ever answers - "only an offer is an arrival" (server/forwarder.mjs) -
   * so a device that stays quiet is a device it never admits.
   */
  mustOfferFirst?: boolean
  /** Passed to the factory, so a caller can vary the ICE configuration by
   *  rung. Omitted for a plain direct connection. */
  context?: PeerContext
  /**
   * Every connection state the underlying connection reports, as it reports
   * it - including the `failed`/`closed` that makes this peer close itself.
   *
   * `Peer` owns `onconnectionstatechange` on the connection, so without this
   * a caller has no way to hear about it. The mesh needs to: promoting a
   * room to a forwarder means keeping the direct peers open until the
   * forwarder is *actually* connected, and `connected` is the only honest
   * signal for that. Optional, because most callers never care.
   */
  onConnectionState?: (state: RTCPeerConnectionState) => void
  /**
   * How a connection that was up is given the chance to come back before it
   * is reported failed. Defaults to `ICE_RESTART_GRACE_MS` and
   * `ICE_RESTART_TIMEOUT_MS`; tests shorten them.
   */
  iceRestart?: { graceMs?: number; timeoutMs?: number }
  /**
   * How long an offer waits for its answer before it is sent again, and how
   * many times. Defaults to `OFFER_RETRY_MS` and `MAX_OFFER_RETRIES`; tests
   * shorten them.
   */
  offerRetry?: { intervalMs?: number; max?: number }
}

/**
 * One `RTCPeerConnection` to one remote device, negotiated with the
 * "perfect negotiation" pattern.
 *
 * In a mesh, every pair of devices can offer at the same instant. Without a
 * tie-break the two offers collide ("glare") and the connection wedges for
 * good. Politeness resolves the tie: it is decided purely by comparing
 * device pubkeys, so both sides reach an answer - and reach OPPOSITE answers
 * - without exchanging a single message about it. The polite side backs off
 * (rolls back its own pending offer and answers the incoming one instead);
 * the impolite side ignores the incoming offer and expects its own to win.
 *
 * Room id and wire delivery are deliberately not this class's job: `onSignal`
 * emits bare bodies, and the caller (the mesh) is what knows which room and
 * how to address and encrypt them.
 */
export class Peer {
  readonly polite: boolean
  readonly #pc: RTCPeerConnectionLike
  readonly #onSignal: (body: SignalBody) => void
  readonly #onTrack: (track: MediaStreamTrack) => void
  readonly #mustOfferFirst: boolean
  #makingOffer = false
  #hasRemoteDescription = false
  #pendingCandidates: RTCIceCandidateInit[] = []
  #closed = false
  /** The operations queue.
   *
   *  Every negotiation step - our own offer as much as an inbound signal -
   *  reads and writes `#makingOffer`, `#ignoreOffer` and
   *  `#hasRemoteDescription` across `await` points. Signals arrive from a
   *  relay subscription, which happily delivers an offer and a candidate in
   *  the same tick, so without a queue two chains interleave and each judges
   *  collision, politeness and rollback from a state the other is still
   *  writing. Chaining them makes every step atomic with respect to the
   *  others, which is what every perfect-negotiation reference implementation
   *  does and for exactly this reason. */
  #operations: Promise<unknown> = Promise.resolve()
  /** Tracks already handed to this connection's `addTrack`, so a repeat
   *  `start()` call - the mesh re-publishes the participant's whole current
   *  set on every toggle, not just what changed - never re-adds one. A real
   *  `RTCPeerConnection` throws if the same track is added twice. */
  #addedTracks = new Set<MediaStreamTrack>()
  readonly #opts: PeerOptions
  readonly #graceMs: number
  readonly #timeoutMs: number
  /** Whether this connection has ever reached `connected`. A restart is
   *  only ever for a path that existed; one that never came up belongs to
   *  the route ladder. */
  #everConnected = false
  /** One restart per episode, an episode ending at the next `connected`. */
  #restarted = false
  #graceTimer?: ReturnType<typeof setTimeout>
  #giveUpTimer?: ReturnType<typeof setTimeout>
  readonly #retryMs: number
  readonly #maxRetries: number
  /** Armed whenever an offer goes out, and cleared by the answer to it. See
   *  `OFFER_RETRY_MS`. */
  #retryTimer?: ReturnType<typeof setTimeout>
  /** How many more times the offer currently outstanding may be re-sent. */
  #retriesLeft = 0

  constructor(opts: PeerOptions) {
    this.#opts = opts
    this.#graceMs = opts.iceRestart?.graceMs ?? ICE_RESTART_GRACE_MS
    this.#timeoutMs = opts.iceRestart?.timeoutMs ?? ICE_RESTART_TIMEOUT_MS
    this.#retryMs = opts.offerRetry?.intervalMs ?? OFFER_RETRY_MS
    this.#maxRetries = opts.offerRetry?.max ?? MAX_OFFER_RETRIES
    // Normalised here, once, because this decides politeness and the two
    // sides of a connection MUST land on opposite answers - see the class
    // doc comment. `hexEquals` protects an equality check from a case
    // difference; it does nothing for this `<`, which is why the tiebreak is
    // normalised at the one place a device pubkey enters this class rather
    // than trusted to already be canonical by the time it gets here.
    this.polite = normaliseHex(opts.localDevice) < normaliseHex(opts.remoteDevice)
    this.#onSignal = opts.onSignal
    this.#onTrack = opts.onTrack
    this.#mustOfferFirst = opts.mustOfferFirst ?? false
    this.#pc = opts.factory(opts.context ?? { tier: 'direct', remoteDevice: opts.remoteDevice })

    this.#pc.ontrack = (event) => this.#onTrack(event.track)

    /**
     * The other half of perfect negotiation, and the half this class was
     * missing.
     *
     * `#handleOffer` resolves glare by having the POLITE side roll its own
     * offer back and answer the incoming one instead. Rolling back does not
     * discard what that side wanted to send - its tracks are still attached,
     * still unnegotiated - and the whole design assumes the connection will
     * say so and be re-offered. Without anybody listening, those tracks were
     * simply lost for the life of the call: measured in a browser, a person
     * with a microphone and no camera never saw the other side's video at
     * all, and two people with cameras sometimes saw nothing, depending
     * purely on which offer happened to win.
     *
     * Queued like every other negotiation step, and skipped unless the
     * connection is idle - a change that arrives mid-negotiation is
     * re-reported when the connection returns to `stable`, so skipping one
     * loses nothing and offering into a half-applied state loses plenty.
     *
     * "Idle" is judged HERE, in the event handler, and not inside the
     * queued operation. `negotiationneeded` is delivered as a queued task,
     * so it routinely arrives describing a moment that has already passed:
     * the flag was raised while the connection was `stable`, and by delivery
     * the connection is `have-local-offer` because our own `addTrack` offer
     * already went out. Judging that from inside the queue means judging it
     * against a state that has moved on again - by then the whole glare
     * dance has run, the connection is back at `stable`, and a stale event
     * becomes a real, unnecessary offer.
     *
     * That offer is not free. It starts a second negotiation on a connection
     * whose ICE and DTLS are already up, and `connectionState` does not
     * report `connected` while one is outstanding - so the mesh's route
     * timer (`DEFAULT_ROUTE_TIMEOUT_MS`) times out a rung that is *carrying
     * media*, tears the peer down, and escalates towards TURN. Measured in a
     * browser: two people who both had a camera and a microphone on could
     * neither see nor hear each other, for the whole call, because both
     * sides offered at once - and the one-sided case, where only one of them
     * had anything to send and no glare could happen, worked perfectly.
     */
    this.#pc.onnegotiationneeded = () => {
      if (this.#closed || this.#makingOffer) return
      if (this.#pc.signalingState !== 'stable') return
      void this.#enqueue(async () => {
        if (this.#closed || this.#makingOffer) return
        if (this.#pc.signalingState !== 'stable') return
        await this.#offer()
      }).catch(() => {})
    }

    this.#pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.#onSignal({ type: 'ice', roomId: '', candidate: JSON.stringify(event.candidate) })
    }

    this.#pc.onconnectionstatechange = () => {
      const state = this.#pc.connectionState
      if (state === 'connected') {
        // Back, or up for the first time. Either way the episode is over:
        // the next blip gets its own restart.
        this.#clearRestartTimers()
        this.#everConnected = true
        this.#restarted = false
      }
      if (state === 'disconnected') {
        opts.onConnectionState?.(state)
        // A phone crossing from Wi-Fi to mobile, a laptop lid, a router
        // hiccup. Given a moment to heal itself; if it does not, ICE is
        // restarted on the connection that exists rather than the peer torn
        // down and the route ladder walked for a path that would have come
        // back. The route ladder still owns a connection that never came up.
        if (this.#everConnected && !this.#restarted && this.#pc.restartIce) {
          this.#clearGraceTimer()
          this.#graceTimer = this.#after(this.#graceMs, () => {
            this.#graceTimer = undefined
            if (this.#pc.connectionState === 'disconnected') this.#restartIce()
          })
        }
        return
      }
      if (state === 'failed' && this.#everConnected && !this.#restarted && this.#pc.restartIce) {
        // One restart before the failure is believed. Not reported: the
        // caller would escalate on it, and it has not failed yet.
        this.#restartIce()
        return
      }
      // Reported before the close, so a caller watching for a failure hears
      // about it rather than inferring it from a peer that has gone quiet.
      opts.onConnectionState?.(state)
      if (state === 'failed' || state === 'closed') this.close()
    }
  }

  #restartIce(): void {
    if (this.#closed) return
    this.#restarted = true
    this.#clearRestartTimers()
    this.#pc.restartIce?.()
    // The browser raises `negotiationneeded` and the offer that follows
    // carries the restart. If nothing comes of it, the failure is real.
    this.#giveUpTimer = this.#after(this.#timeoutMs, () => {
      this.#giveUpTimer = undefined
      if (this.#closed || this.#pc.connectionState === 'connected') return
      this.#opts.onConnectionState?.('failed')
      this.close()
    })
  }

  #after(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(run, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  }

  #clearGraceTimer(): void {
    if (this.#graceTimer !== undefined) clearTimeout(this.#graceTimer)
    this.#graceTimer = undefined
  }

  #clearRestartTimers(): void {
    this.#clearGraceTimer()
    if (this.#giveUpTimer !== undefined) clearTimeout(this.#giveUpTimer)
    this.#giveUpTimer = undefined
  }

  /** Add tracks and make an offer. Either side may call this first - in a mesh
   *  both sides typically do, which is exactly the glare case perfect
   *  negotiation exists to handle. Safe to call again later with an overlapping
   *  or larger track list - to publish a newly toggled-on track - since only
   *  tracks this connection has not already been given are actually added. */
  async start(tracks: MediaStreamTrack[]): Promise<void> {
    return this.#enqueue(() => this.#start(tracks))
  }

  async #start(tracks: MediaStreamTrack[]): Promise<void> {
    if (this.#closed) return
    for (const track of tracks) {
      if (this.#addedTracks.has(track)) continue
      this.#pc.addTrack(track)
      this.#addedTracks.add(track)
    }

    // Anything dropped from the published set stops being sent. Silence is
    // not a message: a sender left in place after its track was stopped
    // tells the far end nothing, so the far end holds the last frame it
    // decoded and shows it for the rest of the call. Removing the sender is
    // what makes turning a camera off look off to everybody else; the
    // re-offer that has to follow comes from `onnegotiationneeded`.
    if (this.#pc.getSenders && this.#pc.removeTrack) {
      const published = new Set(tracks)
      for (const sender of [...this.#pc.getSenders()]) {
        if (!sender.track || published.has(sender.track)) continue
        this.#pc.removeTrack(sender)
        // Forgotten, so the same track coming back is added again rather
        // than skipped as already-present.
        this.#addedTracks.delete(sender.track)
      }
    }

    // Nothing to send, so nothing to propose. `createOffer()` on a
    // connection with no transceivers produces an offer with no m-lines:
    // it negotiates nothing, gathers no candidates, and leaves a connection
    // that never comes up - which the route ladder then escalates all the
    // way to TURN before giving up on a pair that was never going to
    // connect. Somebody with their camera and microphone off is still in the
    // room and still has to see and hear everybody else, and they do: the
    // other side has media, so the other side offers, and this one answers.
    // A forwarder is the exception - it only ever answers, so somebody has
    // to open that conversation. See `mustOfferFirst`.
    // No offer is made from here. Adding or removing a track raises
    // `negotiationneeded`, and that is the single place an offer comes from
    // - two triggers for the same change means two offers racing each other
    // through glare, which is how a camera that had just been turned off
    // stayed on the other person's screen about a third of the time.
    //
    // A forwarder is the exception, and only when there is nothing to send:
    // it never offers and never raises anything, so with no track to add
    // there is nothing to react to and this side has to speak first.
    if (this.#mustOfferFirst && this.#addedTracks.size === 0) await this.#offer()
  }

  /**
   * Make an offer and send it.
   *
   * Shared by `start()` and `onnegotiationneeded`, because the two are the
   * same act for different reasons: one is "I have something new to send",
   * the other is "the connection says what it is carrying no longer matches
   * what it should be".
   */
  async #offer(): Promise<void> {
    if (this.#closed) return
    this.#makingOffer = true
    this.#clearOfferRetry()
    try {
      const offer = await this.#pc.createOffer()
      await this.#pc.setLocalDescription(offer)
      this.#onSignal({ type: 'offer', roomId: '', sdp: offer.sdp })
    } finally {
      this.#makingOffer = false
    }
    this.#retriesLeft = this.#maxRetries
    this.#armOfferRetry()
  }

  /**
   * Send the outstanding offer again if nothing has answered it.
   *
   * The signalling channel is an ephemeral event on a public relay, and it
   * delivers to whoever is subscribed at the instant the event arrives -
   * nobody else, and never later. An offer that lands a moment before the far
   * end is listening is simply gone, and only the offerer can tell, because
   * only the offerer is waiting for something. Left alone, it waits for ever:
   * the far end, when it does have something to send, offers in turn, and if
   * this side is the impolite one it ignores that offer in favour of its own
   * - which nobody has. On a real call over public relays that was two people
   * in a room, one of whom could see and hear the other, and the other of
   * whom could not: whatever the route ladder eventually built carried media
   * one way only.
   *
   * What is re-sent is the connection's own current local description, not
   * a fresh offer: the same session, the same ICE credentials, and by now
   * carrying every candidate gathered so far. To a far end that never heard
   * it, it is the offer. To one that did and whose answer was what went
   * missing, it is a renegotiation that changes nothing and prompts the
   * answer again. To one that has its own offer out, it is the glare that
   * perfect negotiation already resolves. And to one that is polite and
   * waiting on ours, it is what it was waiting for.
   *
   * Bounded, because a peer that never answers is a peer that has gone, and
   * that is the route ladder's call rather than this one's.
   */
  #armOfferRetry(): void {
    this.#clearOfferRetry()
    if (this.#retriesLeft <= 0) return
    this.#retryTimer = this.#after(this.#retryMs, () => {
      this.#retryTimer = undefined
      void this.#enqueue(() => this.#resendOffer()).catch(() => {})
    })
  }

  async #resendOffer(): Promise<void> {
    if (this.#closed || this.#makingOffer) return
    // Answered, rolled back or superseded since the timer was armed: there
    // is nothing outstanding to ask about again.
    if (this.#pc.signalingState !== 'have-local-offer') return
    const local = this.#pc.localDescription
    if (!local || local.type !== 'offer') return
    this.#retriesLeft -= 1
    this.#onSignal({ type: 'offer', roomId: '', sdp: local.sdp })
    this.#armOfferRetry()
  }

  #clearOfferRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  /** Feed in a signal received from the remote device. Queued behind whatever
   *  this peer is already doing - see `#operations`. */
  async handleSignal(body: SignalBody): Promise<void> {
    return this.#enqueue(() => this.#handleSignal(body))
  }

  /** Run `op` once every operation queued before it has settled. A rejection
   *  is handed to this caller and never poisons the queue for the next one. */
  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(op, op)
    this.#operations = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async #handleSignal(body: SignalBody): Promise<void> {
    if (this.#closed) return

    if (body.type === 'offer') {
      await this.#handleOffer(body.sdp)
    } else if (body.type === 'answer') {
      await this.#pc.setRemoteDescription({ type: 'answer', sdp: body.sdp })
      // The offer has been answered, so it is no longer anything to re-send.
      this.#clearOfferRetry()
      this.#hasRemoteDescription = true
      await this.#drainCandidates()
    } else if (body.type === 'ice') {
      await this.#handleIce(body.candidate)
    }
  }

  async #handleOffer(sdp: string | undefined): Promise<void> {
    const collision = this.#makingOffer || this.#pc.signalingState !== 'stable'
    // A local, not a field: whether we ignored *this* offer governs nothing
    // beyond this call, and holding it across `await` points was one of the
    // three pieces of state two interleaved chains used to tear.
    const ignoreOffer = !this.polite && collision
    if (ignoreOffer) return

    if (collision) {
      // Only the polite side reaches here: give up its own pending offer so
      // the incoming one can be answered instead.
      await this.#pc.setLocalDescription({ type: 'rollback' })
      // The offer we gave up on must not come back from a timer.
      this.#clearOfferRetry()
      // We are renegotiating from `stable` now. Candidates still arriving
      // belong to the description that has not landed yet, so they go back to
      // being buffered - applying them against the previous description gets
      // them rejected, and a rejected host candidate is a call that falls
      // back to TURN or does not connect at all.
      this.#hasRemoteDescription = false
    }

    await this.#pc.setRemoteDescription({ type: 'offer', sdp })
    this.#hasRemoteDescription = true

    // The answer comes first, and only then the buffered candidates. Nothing
    // to do with a candidate may stand between an offer and its answer: an
    // answer that is never emitted wedges the connection silently for good,
    // where a candidate that is never applied costs one path.
    const answer = await this.#pc.createAnswer()
    await this.#pc.setLocalDescription(answer)
    this.#onSignal({ type: 'answer', roomId: '', sdp: answer.sdp })

    await this.#drainCandidates()
  }

  async #handleIce(candidateJson: string | undefined): Promise<void> {
    if (!candidateJson) return
    const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit

    if (!this.#hasRemoteDescription) {
      // Trickle ICE routinely delivers candidates before the description
      // they belong to. Hold them rather than drop them - but only so many:
      // see `MAX_PENDING_CANDIDATES`. The oldest goes, because the newest
      // candidate is the one most likely still to work.
      this.#pendingCandidates.push(candidate)
      while (this.#pendingCandidates.length > MAX_PENDING_CANDIDATES) this.#pendingCandidates.shift()
      return
    }

    await this.#applyCandidate(candidate)
  }

  async #drainCandidates(): Promise<void> {
    const pending = this.#pendingCandidates
    this.#pendingCandidates = []
    for (const candidate of pending) await this.#applyCandidate(candidate)
  }

  /**
   * Never throws.
   *
   * A candidate is one possible path to the remote device, and a connection
   * negotiates several. Losing one costs a path; letting the rejection escape
   * costs the whole negotiation, because the caller is either the offer
   * handler - which would then never emit its answer - or a relay
   * subscription handler that has nowhere to put the error. A candidate for
   * an offer we deliberately ignored (glare, impolite side) is *expected* to
   * be rejected, and a stale or malformed one buffered before its
   * description is the routine case the buffer exists for.
   */
  async #applyCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.#pc.addIceCandidate(candidate)
    } catch {
      // Deliberately swallowed - see above.
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearRestartTimers()
    this.#clearOfferRetry()
    this.#pc.close()
  }
}
