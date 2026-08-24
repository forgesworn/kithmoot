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

export interface PeerFactory {
  (): RTCPeerConnectionLike
}

export interface PeerOptions {
  factory: PeerFactory
  localDevice: string
  remoteDevice: string
  onSignal: (body: SignalBody) => void
  onTrack: (track: MediaStreamTrack) => void
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
  #ignoreOffer = false
  #hasRemoteDescription = false
  #pendingCandidates: RTCIceCandidateInit[] = []
  #closed = false
  /** Tracks already handed to this connection's `addTrack`, so a repeat
   *  `start()` call - the mesh re-publishes the participant's whole current
   *  set on every toggle, not just what changed - never re-adds one. A real
   *  `RTCPeerConnection` throws if the same track is added twice. */
  #addedTracks = new Set<MediaStreamTrack>()

  constructor(opts: PeerOptions) {
    this.polite = opts.localDevice < opts.remoteDevice
    this.#onSignal = opts.onSignal
    this.#onTrack = opts.onTrack
    this.#pc = opts.factory()

    this.#pc.ontrack = (event) => this.#onTrack(event.track)

    this.#pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.#onSignal({ type: 'ice', roomId: '', candidate: JSON.stringify(event.candidate) })
    }

    this.#pc.onconnectionstatechange = () => {
      const state = this.#pc.connectionState
      if (state === 'failed' || state === 'closed') this.close()
    }
  }

  /** Add tracks and make an offer. Either side may call this first - in a mesh
   *  both sides typically do, which is exactly the glare case perfect
   *  negotiation exists to handle. Safe to call again later with an overlapping
   *  or larger track list - to publish a newly toggled-on track - since only
   *  tracks this connection has not already been given are actually added. */
  async start(tracks: MediaStreamTrack[]): Promise<void> {
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

  /** Feed in a signal received from the remote device. */
  async handleSignal(body: SignalBody): Promise<void> {
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
    this.#ignoreOffer = !this.polite && collision
    if (this.#ignoreOffer) return

    if (collision) {
      // Only the polite side reaches here: give up its own pending offer so
      // the incoming one can be answered instead.
      await this.#pc.setLocalDescription({ type: 'rollback' })
    }

    await this.#pc.setRemoteDescription({ type: 'offer', sdp })
    this.#hasRemoteDescription = true
    await this.#drainCandidates()

    const answer = await this.#pc.createAnswer()
    await this.#pc.setLocalDescription(answer)
    this.#onSignal({ type: 'answer', roomId: '', sdp: answer.sdp })
  }

  async #handleIce(candidateJson: string | undefined): Promise<void> {
    if (!candidateJson) return
    const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit

    if (!this.#hasRemoteDescription) {
      // Trickle ICE routinely delivers candidates before the description
      // they belong to. Hold them rather than drop them.
      this.#pendingCandidates.push(candidate)
      return
    }

    await this.#applyCandidate(candidate)
  }

  async #drainCandidates(): Promise<void> {
    const pending = this.#pendingCandidates
    this.#pendingCandidates = []
    for (const candidate of pending) await this.#applyCandidate(candidate)
  }

  async #applyCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.#pc.addIceCandidate(candidate)
    } catch (err) {
      // A candidate for an offer we deliberately ignored (glare, impolite
      // side) is expected to be rejected; anything else is a real problem.
      if (!this.#ignoreOffer) throw err
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#pc.close()
  }
}
