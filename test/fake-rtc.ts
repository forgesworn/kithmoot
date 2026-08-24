import type { RTCPeerConnectionLike } from '../src/peer.js'

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
  calls: RecordedCall[] = []
  signalingState: RTCSignalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  tracks: MediaStreamTrack[] = []
  closed = false

  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

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
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.calls.push({ method: 'addIceCandidate', args: [candidate] })
  }

  addTrack(track: MediaStreamTrack): void {
    this.calls.push({ method: 'addTrack', args: [track] })
    this.tracks.push(track)
  }

  close(): void {
    this.calls.push({ method: 'close', args: [] })
    this.closed = true
  }
}

/** A `PeerFactory` that hands out fakes and keeps every instance it made, so a test can reach into whichever connection a `Peer` ended up creating. */
export function createFakeFactory(): (() => FakeRTCPeerConnection) & { instances: FakeRTCPeerConnection[] } {
  const instances: FakeRTCPeerConnection[] = []
  const factory = () => {
    const pc = new FakeRTCPeerConnection()
    instances.push(pc)
    return pc
  }
  factory.instances = instances
  return factory
}
