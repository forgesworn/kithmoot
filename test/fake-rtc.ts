import type { PeerContext, RTCPeerConnectionLike } from '../src/peer.js'

export interface RecordedCall {
  method: string
  args: unknown[]
}

let sdpCounter = 0

/**
 * A minimal double for the surface `Peer` actually touches - nothing else.
 * No real ICE, no real SDP, no real network: `signalingState` and
 * `localDescription` just track what a real RTCPeerConnection's would after
 * `setLocalDescription`/`setRemoteDescription`, rollback included, so the
 * perfect-negotiation state machine can be driven and asserted on with no
 * browser. Every call is recorded so tests can assert on ordering.
 */
export class FakeRTCPeerConnection implements RTCPeerConnectionLike {
  /** What the mesh said this connection was for: which rung of the route
   *  ladder, and which endpoint. A real factory uses this to decide whether
   *  to hand ICE the TURN credentials. */
  context?: PeerContext
  calls: RecordedCall[] = []
  signalingState: RTCSignalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  tracks: MediaStreamTrack[] = []
  closed = false
  /** Make every `addIceCandidate` reject, the way a real connection does for
   *  a candidate that does not belong to the current description. */
  rejectIceCandidates = false
  /** Reject the next `setRemoteDescription` only, then behave normally. */
  failNextSetRemoteDescription = false
  /** Set by `block()`: `setRemoteDescription` waits on this, which is what
   *  makes an interleaving observable at all. */
  #gated: Promise<void> | null = null

  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  /** A real connection fires this whenever what it is carrying stops
   *  matching what it should be - after `addTrack`, and after a rollback.
   *  Nothing here fires it by itself; a test calls it to say "the connection
   *  noticed", which is the only part `Peer` is responsible for reacting to. */
  onnegotiationneeded: (() => void) | null = null

  /** One per track handed to `addTrack`, dropped again by `removeTrack` -
   *  enough of a sender for a caller that only ever asks what it is
   *  currently sending. */
  senders: { track: MediaStreamTrack | null }[] = []

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push({ method: 'createOffer', args: [] })
    return { type: 'offer', sdp: `offer-sdp-${++sdpCounter}` }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push({ method: 'createAnswer', args: [] })
    return { type: 'answer', sdp: `answer-sdp-${++sdpCounter}` }
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push({ method: 'setLocalDescription', args: [description] })
    if (description?.type === 'rollback') {
      this.localDescription = null
      this.signalingState = 'stable'
      return
    }
    this.localDescription = description ?? null
    this.signalingState = description?.type === 'offer' ? 'have-local-offer' : 'stable'
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push({ method: 'setRemoteDescription', args: [description] })
    if (this.#gated) await this.#gated
    if (this.failNextSetRemoteDescription) {
      this.failNextSetRemoteDescription = false
      throw new Error('setRemoteDescription rejected')
    }
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
  }

  /** Hold every `setRemoteDescription` until the returned function is called. */
  block(): () => void {
    let release = () => {}
    this.#gated = new Promise<void>((resolve) => {
      release = () => {
        this.#gated = null
        resolve()
      }
    })
    return release
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.calls.push({ method: 'addIceCandidate', args: [candidate] })
    if (this.rejectIceCandidates) throw new Error('candidate does not belong to this description')
  }

  getSenders(): { track: MediaStreamTrack | null }[] {
    return this.senders
  }

  removeTrack(sender: { track: MediaStreamTrack | null }): void {
    this.calls.push({ method: 'removeTrack', args: [sender.track] })
    const index = this.senders.indexOf(sender as never)
    if (index >= 0) this.senders.splice(index, 1)
    if (sender.track) this.tracks = this.tracks.filter((t) => t !== sender.track)
    this.onnegotiationneeded?.()
  }

  addTrack(track: MediaStreamTrack): void {
    this.calls.push({ method: 'addTrack', args: [track] })
    // A real RTCPeerConnection throws InvalidAccessError if a track already
    // has a sender on this connection - this fake must too, or a caller
    // that never de-duplicates before calling addTrack twice would look fine
    // in tests and then throw the first time it runs in a real browser.
    if (this.tracks.includes(track)) throw new Error('track already added to this connection')
    this.tracks.push(track)
    this.senders.push({ track })
    // What this connection is carrying no longer matches what it should be,
    // and a real connection says so. `Peer` has exactly one place that turns
    // that into an offer, so the fake has to raise it or the tests would be
    // exercising a trigger the browser does not use.
    this.onnegotiationneeded?.()
  }

  /** A real connection gathers fresh candidates and raises
   *  `negotiationneeded`; here it is only recorded, so a test can say whether
   *  a restart was asked for. */
  restartIce(): void {
    this.calls.push({ method: 'restartIce', args: [] })
  }

  close(): void {
    this.calls.push({ method: 'close', args: [] })
    this.closed = true
  }
}

/** A `PeerFactory` that hands out fakes and keeps every instance it made, so a test can reach into whichever connection a `Peer` ended up creating. */
export function createFakeFactory(): ((context?: PeerContext) => FakeRTCPeerConnection) & {
  instances: FakeRTCPeerConnection[]
  /** The connection most recently opened to `device`, whatever rung it was
   *  opened on. */
  to(device: string): FakeRTCPeerConnection | undefined
} {
  const instances: FakeRTCPeerConnection[] = []
  const factory = (context?: PeerContext) => {
    const pc = new FakeRTCPeerConnection()
    pc.context = context
    instances.push(pc)
    return pc
  }
  factory.instances = instances
  factory.to = (device: string) =>
    [...instances].reverse().find((pc) => pc.context?.remoteDevice === device && !pc.closed)
  return factory
}
