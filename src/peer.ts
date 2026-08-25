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
  close(): void
  readonly signalingState: RTCSignalingState
  readonly localDescription: RTCSessionDescriptionInit | null
  readonly connectionState: RTCPeerConnectionState
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null
  onconnectionstatechange: (() => void) | null
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

export interface PeerOptions {
  factory: PeerFactory
  localDevice: string
  remoteDevice: string
  onSignal: (body: SignalBody) => void
  onTrack: (track: MediaStreamTrack) => void
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

  constructor(opts: PeerOptions) {
    // Normalised here, once, because this decides politeness and the two
    // sides of a connection MUST land on opposite answers - see the class
    // doc comment. `hexEquals` protects an equality check from a case
    // difference; it does nothing for this `<`, which is why the tiebreak is
    // normalised at the one place a device pubkey enters this class rather
    // than trusted to already be canonical by the time it gets here.
    this.polite = normaliseHex(opts.localDevice) < normaliseHex(opts.remoteDevice)
    this.#onSignal = opts.onSignal
    this.#onTrack = opts.onTrack
    this.#pc = opts.factory(opts.context ?? { tier: 'direct', remoteDevice: opts.remoteDevice })

    this.#pc.ontrack = (event) => this.#onTrack(event.track)

    this.#pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.#onSignal({ type: 'ice', roomId: '', candidate: JSON.stringify(event.candidate) })
    }

    this.#pc.onconnectionstatechange = () => {
      const state = this.#pc.connectionState
      // Reported before the close, so a caller watching for a failure hears
      // about it rather than inferring it from a peer that has gone quiet.
      opts.onConnectionState?.(state)
      if (state === 'failed' || state === 'closed') this.close()
    }
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

    this.#makingOffer = true
    try {
      const offer = await this.#pc.createOffer()
      await this.#pc.setLocalDescription(offer)
      this.#onSignal({ type: 'offer', roomId: '', sdp: offer.sdp })
    } finally {
      this.#makingOffer = false
    }
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
    this.#pc.close()
  }
}
