import type { PeerContext, RtpTransceiverLike, RTCPeerConnectionLike } from '../src/peer.js'

export interface RecordedCall {
  method: string
  args: unknown[]
}

let sdpCounter = 0
let trackCounter = 0

/** The mutable shape behind a fake `MediaStreamTrack`.
 *
 *  `MediaStreamTrack` declares `muted` and `readyState` readonly, which is
 *  true of a real one and useless in a double: the whole point of the fixture
 *  is to script exactly the transitions H5 is about. Tests reach the mutable
 *  view through `trackState()` rather than casting at every call site. */
export interface FakeTrackState {
  kind: 'audio' | 'video'
  id: string
  enabled: boolean
  muted: boolean
  readyState: 'live' | 'ended'
  stop(): void
}

/** A track double good enough for everything `Peer` and the slot machinery
 *  touch: a kind, an id, and the three mutable bits. */
export function fakeTrack(kind: 'audio' | 'video' = 'video', id?: string): MediaStreamTrack {
  const state: FakeTrackState = {
    kind,
    id: id ?? `track-${++trackCounter}`,
    enabled: true,
    muted: false,
    readyState: 'live',
    stop() {
      state.readyState = 'ended'
    },
  }
  return state as unknown as MediaStreamTrack
}

/** The mutable view of a fake track. */
export function trackState(track: MediaStreamTrack): FakeTrackState {
  return track as unknown as FakeTrackState
}

/** What kind of m-line a track belongs on.
 *
 *  Existing tests hand `{}` to `addTrack`, so a missing kind has to mean
 *  something; video is the one that matters for `framesDecoded`. */
function kindOf(track: MediaStreamTrack | null | undefined): 'audio' | 'video' {
  const kind = track ? trackState(track).kind : undefined
  return kind === 'audio' ? 'audio' : 'video'
}

const SENDS = new Set<string>(['sendrecv', 'sendonly'])
const RECEIVES = new Set<string>(['sendrecv', 'recvonly'])

function directionOf(send: boolean, recv: boolean): RTCRtpTransceiverDirection {
  return send ? (recv ? 'sendrecv' : 'sendonly') : recv ? 'recvonly' : 'inactive'
}

/** One `m=` section as this fixture writes and reads it. */
export interface ParsedMedia {
  kind: 'audio' | 'video'
  mid: string
  direction: RTCRtpTransceiverDirection
  /** `a=msid:<stream> <track>` appdata, when the section carries a track. */
  msid?: { stream: string; track: string }
}

/**
 * Read back the m-lines of an SDP this fixture wrote.
 *
 * Returns `null` for an SDP with no m-lines at all - which is every opaque
 * `'remote-offer-sdp'` string the older tests pass around. That is the switch
 * that keeps m-line enforcement, transceiver creation and `ontrack` out of
 * the way of a test that is only driving the negotiation state machine.
 */
export function parseFakeSdp(sdp: string | undefined | null): ParsedMedia[] | null {
  if (!sdp || !sdp.includes('\nm=')) return null
  const out: ParsedMedia[] = []
  let current: ParsedMedia | undefined
  for (const raw of sdp.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('m=')) {
      const kind = line.slice(2).split(' ')[0] === 'audio' ? 'audio' : 'video'
      current = { kind, mid: String(out.length), direction: 'sendrecv' }
      out.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('a=mid:')) current.mid = line.slice('a=mid:'.length)
    else if (line.startsWith('a=msid:')) {
      const [stream, track] = line.slice('a=msid:'.length).split(' ')
      if (stream && track) current.msid = { stream, track }
    } else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) {
      current.direction = line.slice(2) as RTCRtpTransceiverDirection
    }
  }
  return out
}

/** Per-slot counters, keyed by mid. Everything the pair-health sampler of the
 *  spec reads, and nothing else. */
export interface FakeSlotStats {
  inbound: { packetsReceived: number; bytesReceived: number; framesDecoded: number }
  outbound: { packetsSent: number; bytesSent: number; framesEncoded: number; ssrc: number }
  /** What RTCP told us the far end is receiving from us. */
  remoteInbound: { packetsLost: number; roundTripTime: number; roundTripTimeMeasurements: number; timestamp: number }
}

function emptySlotStats(ssrc: number): FakeSlotStats {
  return {
    inbound: { packetsReceived: 0, bytesReceived: 0, framesDecoded: 0 },
    outbound: { packetsSent: 0, bytesSent: 0, framesEncoded: 0, ssrc },
    remoteInbound: { packetsLost: 0, roundTripTime: 0.01, roundTripTimeMeasurements: 0, timestamp: 0 },
  }
}

export class FakeRtpSender {
  track: MediaStreamTrack | null
  /** Make the next `replaceTrack` reject, which is the only way into the
   *  spec's `broken` slot state. */
  failReplaceTrack = false
  /** Once a sender has carried a track, `addTrack` may never reuse its
   *  transceiver again - so a camera turned off and on again costs a new
   *  m-line every time, which is H1's root cause and has to be countable. */
  everSent = false

  constructor(track: MediaStreamTrack | null, readonly transceiver: FakeRtpTransceiver) {
    this.track = track
    this.everSent = track !== null
  }

  /**
   * Swap what this slot is sending without touching the m-line.
   *
   * The whole of D1 rests on this not renegotiating: no mid changes, no
   * `negotiationneeded`, no new SDP. The call is recorded on the connection
   * so a test can assert the slot was swapped rather than re-added.
   */
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    const pc = this.transceiver.connection
    pc.calls.push({ method: 'replaceTrack', args: [this.transceiver.mid, track] })
    if (this.failReplaceTrack) {
      this.failReplaceTrack = false
      throw new Error('replaceTrack rejected')
    }
    if (track && this.transceiver.mid !== null && kindOf(track) !== this.transceiver.kind) {
      throw new Error(`cannot replace a ${this.transceiver.kind} slot with a ${kindOf(track)} track`)
    }
    this.track = track
    if (track) this.everSent = true
  }
}

export class FakeRtpReceiver {
  track: MediaStreamTrack | null = null
  constructor(readonly transceiver: FakeRtpTransceiver) {}
}

/** Which call created a transceiver, because JSEP only lets one of them be
 *  reused for an incoming m-line. */
export type TransceiverOrigin = 'addTrack' | 'addTransceiver' | 'remote'

export class FakeRtpTransceiver {
  /** Null until a description that contains this m-line has been applied
   *  locally (offerer) or a remote offer has associated it (answerer). */
  mid: string | null = null
  direction: RTCRtpTransceiverDirection
  /** Null until an answer has been applied in either direction. */
  currentDirection: RTCRtpTransceiverDirection | null = null
  stopped = false
  /** Not readonly: `removeTrack` detaches a sender rather than emptying the
   *  one the caller is holding. See `FakeConnectionOptions.nullTrackOnRemove`. */
  sender: FakeRtpSender
  readonly receiver: FakeRtpReceiver
  /** The mid this transceiver will take when the pending local description
   *  is applied. Real browsers put the mid in the SDP `createOffer` returns
   *  and only associate it at `setLocalDescription`; so does this. */
  pendingMid: string | null = null

  constructor(
    readonly connection: FakeRTCPeerConnection,
    readonly kind: 'audio' | 'video',
    readonly origin: TransceiverOrigin,
    track: MediaStreamTrack | null,
    direction: RTCRtpTransceiverDirection = 'sendrecv',
  ) {
    this.direction = direction
    this.sender = new FakeRtpSender(track, this)
    this.receiver = new FakeRtpReceiver(this)
  }

  stop(): void {
    this.stopped = true
    this.direction = 'stopped'
    this.currentDirection = 'stopped'
    this.sender.track = null
  }
}

export interface FakeConnectionOptions {
  /**
   * Where a receiver's track id comes from.
   *
   * `msid` is Chromium and libwebrtc: the id is lifted out of the remote
   * `a=msid` appdata, so it equals the sender's track id at negotiation time
   * and does not move when the far end calls `replaceTrack`. `local` is the
   * Firefox shape: a locally minted id that never matches anything the far
   * end advertised, which is the ground H5 grows on.
   */
  receiverTrackIds?: 'msid' | 'local'
  /** Write real m-lines even before `addTransceiver` is called. */
  structuredSdp?: boolean
  /**
   * Whether `removeTrack` empties the sender object the caller is holding.
   *
   * A real browser does: the W3C algorithm sets `sender.[[SenderTrack]]` to
   * null synchronously, so `sender.track` reads back as null the instant
   * `removeTrack` returns. This fixture defaults to `false`, which detaches
   * the sender from the transceiver but leaves the caller's object as it was,
   * because `Peer.#start` reads `sender.track` *after* calling `removeTrack`
   * to forget the track it just dropped (`src/peer.ts:507-510`) - with the
   * faithful behaviour it deletes `null` from `#addedTracks` instead, and the
   * same track object coming back is never re-added. Turn this on to see that
   * failure; leave it off to drive the existing negotiation tests.
   */
  nullTrackOnRemove?: boolean
}

/**
 * A minimal double for the surface `Peer` actually touches - nothing else.
 * No real ICE, no real SDP, no real network: `signalingState` and
 * `localDescription` just track what a real RTCPeerConnection's would after
 * `setLocalDescription`/`setRemoteDescription`, rollback included, so the
 * perfect-negotiation state machine can be driven and asserted on with no
 * browser. Every call is recorded so tests can assert on ordering.
 *
 * Two modes, and the boundary is deliberate. Left alone it behaves exactly as
 * it always did: `createOffer` returns an opaque `offer-sdp-N`, nothing is
 * parsed, nothing is enforced, and the existing peer and mesh tests see the
 * fixture they were written against. The first `addTransceiver` turns on the
 * structured mode: real m-lines, mids assigned at `setLocalDescription`,
 * m-line order enforced on `setRemoteDescription`, `currentDirection`
 * negotiated, and per-slot `getStats` counters. That is the shape the fixed
 * media slots of the call-reliability spec need, and the only shape in which
 * a generation bug is visible at all.
 */
export class FakeRTCPeerConnection implements RTCPeerConnectionLike {
  /** What the mesh said this connection was for: which rung of the route
   *  ladder, and which endpoint. A real factory uses this to decide whether
   *  to hand ICE the TURN credentials. */
  context?: PeerContext
  calls: RecordedCall[] = []
  signalingState: RTCSignalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  tracks: MediaStreamTrack[] = []
  closed = false
  /** Make every `addIceCandidate` reject, the way a real connection does for
   *  a candidate that does not belong to the current description. */
  rejectIceCandidates = false
  /** Reject the next `setRemoteDescription` only, then behave normally. */
  failNextSetRemoteDescription = false
  /** Set by `FakeRtcLink`: one candidate applied on a connection that has a
   *  remote description takes it to `connected`. Off by default, because the
   *  older tests drive `connectionState` by hand. */
  autoConnectOnCandidate = false
  /** Every candidate this connection has handed out through `onicecandidate`. */
  readonly gathered: RTCIceCandidateInit[] = []
  /** Milliseconds, only ever moved by `advanceStatsClock` or a linked tick. */
  statsClock = 1_000
  readonly options: Required<FakeConnectionOptions>
  /** Set by `block()`: `setRemoteDescription` waits on this, which is what
   *  makes an interleaving observable at all. */
  #gated: Promise<void> | null = null

  #transceivers: FakeRtpTransceiver[] = []
  #structured = false
  #nextMid = 0
  #nextSsrc = 1_000
  #stats = new Map<string, FakeSlotStats>()
  /** The m-line shape of the session as last negotiated: what a later offer
   *  has to keep to. */
  #established: { kind: 'audio' | 'video'; mid: string }[] | null = null
  #pendingRemoteOffer: ParsedMedia[] | null = null
  #pendingLocalOffer: ParsedMedia[] | null = null
  #announced = new Set<string>()
  #streamId = `stream-${++sdpCounter}`

  constructor(options: FakeConnectionOptions = {}) {
    this.options = {
      receiverTrackIds: options.receiverTrackIds ?? 'msid',
      structuredSdp: options.structuredSdp ?? false,
      nullTrackOnRemove: options.nullTrackOnRemove ?? false,
    }
    this.#structured = this.options.structuredSdp
  }

  /** Typed against the library's `RtpTransceiverLike` rather than the
   *  fixture's own class: `ontrack` is a property, so its parameter is
   *  checked contravariantly, and a handler that insisted on the concrete
   *  class could not be given to `RTCPeerConnectionLike`. A test that wants
   *  the fixture's extra fields casts. */
  ontrack:
    | ((event: { track: MediaStreamTrack; receiver?: unknown; transceiver?: RtpTransceiverLike; streams?: unknown[] }) => void)
    | null = null
  onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  /** A real connection fires this whenever what it is carrying stops
   *  matching what it should be - after `addTrack`, and after a rollback.
   *  Nothing here fires it by itself; a test calls it to say "the connection
   *  noticed", which is the only part `Peer` is responsible for reacting to. */
  onnegotiationneeded: (() => void) | null = null

  /** One per track handed to `addTrack`, dropped again by `removeTrack` -
   *  enough of a sender for a caller that only ever asks what it is
   *  currently sending.
   *
   *  A real connection keeps the sender with a null track after
   *  `removeTrack`; this one drops it, as it always has, and `Peer` skips
   *  null-track senders anyway. The transceiver survives either way, which
   *  is the part that matters for m-line counting. */
  senders: { track: MediaStreamTrack | null }[] = []

  // ---------------------------------------------------------------- slots

  getTransceivers(): FakeRtpTransceiver[] {
    return [...this.#transceivers]
  }

  transceiverByMid(mid: string): FakeRtpTransceiver | undefined {
    return this.#transceivers.find((t) => t.mid === mid)
  }

  /**
   * Open a slot with no track in it, which is what D1's fixed slots are.
   *
   * Turns on structured SDP for this connection: from here on the
   * descriptions it writes carry real m-lines and the ones it is handed are
   * checked against them.
   */
  addTransceiver(
    kindOrTrack: 'audio' | 'video' | MediaStreamTrack,
    init?: { direction?: RTCRtpTransceiverDirection },
  ): FakeRtpTransceiver {
    if (this.closed) throw new Error('connection is closed')
    this.#structured = true
    const track = typeof kindOrTrack === 'string' ? null : kindOrTrack
    const kind = typeof kindOrTrack === 'string' ? kindOrTrack : kindOf(kindOrTrack)
    this.calls.push({ method: 'addTransceiver', args: [kind, init] })
    const transceiver = new FakeRtpTransceiver(this, kind, 'addTransceiver', track, init?.direction ?? 'sendrecv')
    this.#transceivers.push(transceiver)
    return transceiver
  }

  // ------------------------------------------------------------ the SDP

  #sdpFor(type: 'offer' | 'answer'): string {
    const version = ++sdpCounter
    if (!this.#structured) return `${type}-sdp-${version}`
    const lines = [
      'v=0',
      `o=- 4611731400430051336 ${version} IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
    ]
    const mids: string[] = []
    const sections: string[] = []
    for (const transceiver of this.#transceivers) {
      const mid = transceiver.mid ?? transceiver.pendingMid ?? String(this.#nextMid++)
      transceiver.pendingMid = mid
      mids.push(mid)
      const remote = this.#pendingRemoteOffer?.find((m) => m.mid === mid)
      // An answer can only ever narrow what the offer proposed.
      const direction =
        type === 'answer' && remote
          ? directionOf(
              SENDS.has(transceiver.direction) && RECEIVES.has(remote.direction),
              RECEIVES.has(transceiver.direction) && SENDS.has(remote.direction),
            )
          : transceiver.direction
      sections.push(`m=${transceiver.kind} 9 UDP/TLS/RTP/SAVPF 111`)
      sections.push('c=IN IP4 0.0.0.0')
      sections.push(`a=mid:${mid}`)
      sections.push(`a=${direction}`)
      // Fixed at negotiation, exactly as a browser does it: `replaceTrack`
      // never rewrites appdata, so whatever track was in the slot when this
      // description was written is the name the far end will carry for ever.
      if (transceiver.sender.track) sections.push(`a=msid:${this.#streamId} ${trackState(transceiver.sender.track).id}`)
      sections.push(`a=ssrc:${this.#slotStats(mid).outbound.ssrc} cname:fake`)
    }
    if (mids.length > 0) lines.push(`a=group:BUNDLE ${mids.join(' ')}`)
    return [...lines, ...sections, ''].join('\n')
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push({ method: 'createOffer', args: [] })
    return { type: 'offer', sdp: this.#sdpFor('offer') }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push({ method: 'createAnswer', args: [] })
    return { type: 'answer', sdp: this.#sdpFor('answer') }
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push({ method: 'setLocalDescription', args: [description] })
    if (description?.type === 'rollback') {
      this.localDescription = null
      this.#pendingLocalOffer = null
      this.signalingState = 'stable'
      return
    }
    const parsed = parseFakeSdp(description?.sdp)
    if (parsed) this.#associateLocal(parsed)
    this.localDescription = description ?? null
    if (description?.type === 'offer') {
      this.#pendingLocalOffer = parsed
      this.signalingState = 'have-local-offer'
    } else {
      // An answer applied locally completes the exchange, so this is where
      // `currentDirection` first becomes real for the answerer.
      if (parsed && this.#pendingRemoteOffer) this.#settleDirections(parsed, this.#pendingRemoteOffer)
      if (parsed) this.#establish()
      this.#pendingRemoteOffer = null
      this.signalingState = 'stable'
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push({ method: 'setRemoteDescription', args: [description] })
    if (this.#gated) await this.#gated
    if (this.failNextSetRemoteDescription) {
      this.failNextSetRemoteDescription = false
      throw new Error('setRemoteDescription rejected')
    }
    const parsed = parseFakeSdp(description.sdp)
    // A far end that speaks m-lines drags this connection into structured
    // mode too: the answer it writes has to name the same mids back.
    if (parsed) this.#structured = true
    if (parsed) this.#enforceMLineOrder(parsed)
    this.remoteDescription = description
    if (description.type === 'offer') {
      if (parsed) {
        this.#pendingRemoteOffer = parsed
        this.#associateRemote(parsed)
      }
      this.signalingState = 'have-remote-offer'
    } else {
      if (parsed && this.#pendingLocalOffer) this.#settleDirections(this.#pendingLocalOffer, parsed)
      if (parsed) {
        this.#associateRemote(parsed)
        this.#establish()
      }
      this.#pendingLocalOffer = null
      this.signalingState = 'stable'
    }
    if (parsed) this.#announceTracks(parsed)
  }

  /**
   * What Chromium does to an offer that renumbers the session.
   *
   * Once a session has been negotiated its m-lines are fixed: the same kinds,
   * in the same order, with the same mids, and never fewer. A connection
   * rebuilt at a new generation writes its slots from scratch, so its offer
   * lands on the far end's *old* session and is rejected here exactly as it
   * would be in a browser. Without this the H2 bugs are invisible to a unit
   * test, because a fake that accepts anything makes a rebuild look fine.
   */
  #enforceMLineOrder(parsed: ParsedMedia[]): void {
    const established = this.#established
    if (!established) return
    if (parsed.length < established.length) {
      throw new Error(
        `Failed to set remote description: m-lines removed from the session (had ${established.length}, offered ${parsed.length})`,
      )
    }
    for (const [index, expected] of established.entries()) {
      const actual = parsed[index]!
      if (actual.kind !== expected.kind || actual.mid !== expected.mid) {
        throw new Error(
          `Failed to set remote description: the order of m-lines in subsequent offer doesn't match order from previous offer/answer ` +
            `(index ${index}: expected ${expected.kind}/${expected.mid}, got ${actual.kind}/${actual.mid})`,
        )
      }
    }
  }

  /** Commit the mids the pending description claimed. */
  #associateLocal(parsed: ParsedMedia[]): void {
    for (const media of parsed) {
      const transceiver =
        this.#transceivers.find((t) => t.mid === media.mid) ?? this.#transceivers.find((t) => t.pendingMid === media.mid)
      if (!transceiver) continue
      transceiver.mid = media.mid
      transceiver.pendingMid = null
    }
  }

  /**
   * Bind the remote m-lines to local transceivers, creating what is missing.
   *
   * The reuse rule is JSEP's and is the whole of amendment A1: an m-line may
   * adopt an unassociated transceiver only if that transceiver came from
   * `addTrack`. Four slots opened with `addTransceiver` on the answering side
   * cannot absorb the offerer's four m-lines, so the fake creates four more -
   * which is precisely the doubling the amendment exists to prevent, and now
   * it is countable in a test.
   */
  #associateRemote(parsed: ParsedMedia[]): void {
    for (const media of parsed) {
      let transceiver = this.#transceivers.find((t) => t.mid === media.mid)
      if (!transceiver) {
        transceiver = this.#transceivers.find(
          (t) => t.mid === null && t.pendingMid === null && t.kind === media.kind && t.origin === 'addTrack',
        )
        if (transceiver) transceiver.mid = media.mid
      }
      if (!transceiver) {
        transceiver = new FakeRtpTransceiver(this, media.kind, 'remote', null, 'recvonly')
        transceiver.mid = media.mid
        this.#transceivers.push(transceiver)
      }
      this.#nextMid = Math.max(this.#nextMid, Number(media.mid) + 1 || this.#nextMid)
      if (SENDS.has(media.direction)) {
        const id =
          this.options.receiverTrackIds === 'msid' && media.msid
            ? media.msid.track
            : `remote-${media.kind}-${media.mid}-${++trackCounter}`
        // Chromium keeps the receiver track for the life of the m-line; the
        // id only ever changes when the far end renegotiates a new msid.
        if (!transceiver.receiver.track || (this.options.receiverTrackIds === 'msid' && trackState(transceiver.receiver.track).id !== id)) {
          const track = fakeTrack(media.kind, id)
          trackState(track).muted = true
          transceiver.receiver.track = track
        }
      }
    }
  }

  /** `currentDirection` is the intersection, and it only becomes real when an
   *  answer has been applied. */
  #settleDirections(local: ParsedMedia[], remote: ParsedMedia[]): void {
    for (const media of local) {
      const transceiver = this.#transceivers.find((t) => t.mid === media.mid || t.pendingMid === media.mid)
      if (!transceiver || transceiver.stopped) continue
      const far = remote.find((m) => m.mid === media.mid)
      if (!far) {
        transceiver.currentDirection = 'inactive'
        continue
      }
      transceiver.currentDirection = directionOf(
        SENDS.has(media.direction) && RECEIVES.has(far.direction),
        RECEIVES.has(media.direction) && SENDS.has(far.direction),
      )
    }
  }

  #establish(): void {
    this.#established = this.#transceivers
      .filter((t) => t.mid !== null)
      .map((t) => ({ kind: t.kind, mid: t.mid! }))
  }

  #announceTracks(parsed: ParsedMedia[]): void {
    for (const media of parsed) {
      if (!SENDS.has(media.direction)) continue
      const transceiver = this.#transceivers.find((t) => t.mid === media.mid)
      const track = transceiver?.receiver.track
      if (!transceiver || !track) continue
      const key = `${media.mid}:${trackState(track).id}`
      if (this.#announced.has(key)) continue
      this.#announced.add(key)
      this.ontrack?.({ track, receiver: transceiver.receiver, transceiver, streams: [] })
    }
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
    if (this.autoConnectOnCandidate && this.remoteDescription && this.connectionState !== 'connected') {
      this.setConnectionState('connected')
    }
  }

  /** Hand out one candidate, the way a gathering connection would. */
  emitCandidate(candidate?: RTCIceCandidateInit): RTCIceCandidateInit {
    const value = candidate ?? {
      candidate: `candidate:${this.gathered.length + 1} 1 udp 2130706431 127.0.0.1 ${9000 + this.gathered.length} typ host`,
      sdpMid: this.#transceivers.find((t) => t.mid !== null)?.mid ?? '0',
      sdpMLineIndex: 0,
    }
    this.gathered.push(value)
    this.onicecandidate?.({ candidate: value })
    return value
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    if (this.connectionState === state) return
    this.connectionState = state
    this.iceConnectionState = state === 'connected' ? 'connected' : state === 'new' ? 'new' : (state as RTCIceConnectionState)
    this.onconnectionstatechange?.()
  }

  getSenders(): { track: MediaStreamTrack | null }[] {
    return this.senders
  }

  removeTrack(sender: { track: MediaStreamTrack | null }): void {
    this.calls.push({ method: 'removeTrack', args: [sender.track] })
    const index = this.senders.indexOf(sender as never)
    if (index >= 0) this.senders.splice(index, 1)
    if (sender.track) this.tracks = this.tracks.filter((t) => t !== sender.track)
    // The m-line stays; a real connection keeps it for the life of the
    // session and only narrows the direction. That is why toggling a camera
    // off and on again costs an extra m-line every time.
    const transceiver = this.#transceivers.find((t) => t.sender === sender)
    if (transceiver) {
      if (this.options.nullTrackOnRemove) transceiver.sender.track = null
      // Detached: the transceiver stops sending, but the object the caller
      // is holding keeps the track it can still read back afterwards.
      else transceiver.sender = new FakeRtpSender(null, transceiver)
      transceiver.sender.everSent = true
      transceiver.direction = RECEIVES.has(transceiver.direction) ? 'recvonly' : 'inactive'
    }
    this.onnegotiationneeded?.()
  }

  addTrack(track: MediaStreamTrack): { track: MediaStreamTrack | null } {
    this.calls.push({ method: 'addTrack', args: [track] })
    // A real RTCPeerConnection throws InvalidAccessError if a track already
    // has a sender on this connection - this fake must too, or a caller
    // that never de-duplicates before calling addTrack twice would look fine
    // in tests and then throw the first time it runs in a real browser.
    if (this.tracks.includes(track)) throw new Error('track already added to this connection')
    this.tracks.push(track)
    // A real `addTrack` reuses a transceiver of the right kind only while
    // that transceiver's sender has never carried anything. Once it has, the
    // connection opens a new m-line - which is why every camera toggle grows
    // the SDP for the life of the call.
    const reusable = this.#transceivers.find(
      (t) => !t.stopped && !t.sender.everSent && t.sender.track === null && t.kind === kindOf(track),
    )
    const transceiver = reusable ?? new FakeRtpTransceiver(this, kindOf(track), 'addTrack', null)
    if (!reusable) this.#transceivers.push(transceiver)
    transceiver.sender.track = track
    transceiver.sender.everSent = true
    transceiver.direction = RECEIVES.has(transceiver.direction) ? 'sendrecv' : 'sendonly'
    const sender = transceiver.sender
    this.senders.push(sender)
    // What this connection is carrying no longer matches what it should be,
    // and a real connection says so. `Peer` has exactly one place that turns
    // that into an offer, so the fake has to raise it or the tests would be
    // exercising a trigger the browser does not use.
    this.onnegotiationneeded?.()
    return sender
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

  // --------------------------------------------------------------- stats

  #slotStats(mid: string): FakeSlotStats {
    let stats = this.#stats.get(mid)
    if (!stats) {
      stats = emptySlotStats(this.#nextSsrc++)
      this.#stats.set(mid, stats)
    }
    return stats
  }

  /** The mutable counters for one slot, so a test can script any history it
   *  likes without a linked pair. */
  statsFor(mid: string): FakeSlotStats {
    return this.#slotStats(mid)
  }

  /** Add to a slot's counters, which is what a sample interval does. */
  scriptStats(
    mid: string,
    delta: Partial<{ packetsReceived: number; framesDecoded: number; packetsSent: number; framesEncoded: number; packetsLost: number; roundTripTimeMeasurements: number }>,
  ): void {
    const stats = this.#slotStats(mid)
    stats.inbound.packetsReceived += delta.packetsReceived ?? 0
    stats.inbound.bytesReceived += (delta.packetsReceived ?? 0) * 1_200
    stats.inbound.framesDecoded += delta.framesDecoded ?? 0
    stats.outbound.packetsSent += delta.packetsSent ?? 0
    stats.outbound.bytesSent += (delta.packetsSent ?? 0) * 1_200
    stats.outbound.framesEncoded += delta.framesEncoded ?? 0
    stats.remoteInbound.packetsLost += delta.packetsLost ?? 0
    stats.remoteInbound.roundTripTimeMeasurements += delta.roundTripTimeMeasurements ?? 0
    if (delta.roundTripTimeMeasurements) stats.remoteInbound.timestamp = this.statsClock
  }

  advanceStatsClock(ms: number): void {
    this.statsClock += ms
  }

  /**
   * The stats a browser would report for these slots.
   *
   * An `inbound-rtp` appears only where the slot is actually receiving, an
   * `outbound-rtp` only where a track is attached and the slot is sending,
   * and `remote-inbound-rtp` only beside an outbound one - so a test that
   * reads the report sees the same absences a real sampler has to cope with.
   */
  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    const report = new Map<string, Record<string, unknown>>()
    for (const transceiver of this.#transceivers) {
      const mid = transceiver.mid
      if (mid === null) continue
      const stats = this.#slotStats(mid)
      const receiving = transceiver.currentDirection !== null && RECEIVES.has(transceiver.currentDirection)
      const sending = transceiver.currentDirection !== null && SENDS.has(transceiver.currentDirection) && transceiver.sender.track !== null
      if (receiving && transceiver.receiver.track) {
        report.set(`inbound-${mid}`, {
          id: `inbound-${mid}`,
          type: 'inbound-rtp',
          kind: transceiver.kind,
          mid,
          ssrc: stats.outbound.ssrc + 10_000,
          timestamp: this.statsClock,
          packetsReceived: stats.inbound.packetsReceived,
          bytesReceived: stats.inbound.bytesReceived,
          ...(transceiver.kind === 'video' ? { framesDecoded: stats.inbound.framesDecoded } : {}),
        })
      }
      if (sending) {
        report.set(`outbound-${mid}`, {
          id: `outbound-${mid}`,
          type: 'outbound-rtp',
          kind: transceiver.kind,
          mid,
          ssrc: stats.outbound.ssrc,
          timestamp: this.statsClock,
          packetsSent: stats.outbound.packetsSent,
          bytesSent: stats.outbound.bytesSent,
          ...(transceiver.kind === 'video' ? { framesEncoded: stats.outbound.framesEncoded } : {}),
        })
        report.set(`remote-inbound-${mid}`, {
          id: `remote-inbound-${mid}`,
          type: 'remote-inbound-rtp',
          kind: transceiver.kind,
          ssrc: stats.outbound.ssrc,
          localId: `outbound-${mid}`,
          timestamp: stats.remoteInbound.timestamp,
          packetsLost: stats.remoteInbound.packetsLost,
          roundTripTime: stats.remoteInbound.roundTripTime,
          roundTripTimeMeasurements: stats.remoteInbound.roundTripTimeMeasurements,
        })
      }
    }
    return report
  }
}

/**
 * Two fakes wired to each other.
 *
 * `negotiate()` runs a whole exchange - offer, answer, one candidate each way
 * - and both ends end up `connected`, because the candidate is what completes
 * it, not a flag a test sets. `tick()` then moves media: per slot, per
 * direction, a counter advances only while a track is attached on the sending
 * side and the negotiated direction actually carries it. A slot with
 * `replaceTrack(null)` in it goes quiet immediately, with no renegotiation,
 * which is the behaviour D1 is betting the call on.
 */
export class FakeRtcLink {
  constructor(
    readonly a: FakeRTCPeerConnection,
    readonly b: FakeRTCPeerConnection,
    readonly opts: {
      /** The answerer's chance to bind the offerer's slots before answering,
       *  which is what amendment A1 requires it to do. */
      onRemoteOffer?: (answerer: FakeRTCPeerConnection) => void | Promise<void>
    } = {},
  ) {
    a.autoConnectOnCandidate = true
    b.autoConnectOnCandidate = true
  }

  /** Offer from `a`, answer from `b`, a candidate each way. */
  async negotiate(): Promise<void> {
    const offer = await this.a.createOffer()
    await this.a.setLocalDescription(offer)
    await this.b.setRemoteDescription(this.a.localDescription!)
    await this.opts.onRemoteOffer?.(this.b)
    const answer = await this.b.createAnswer()
    await this.b.setLocalDescription(answer)
    await this.a.setRemoteDescription(this.b.localDescription!)
    await this.b.addIceCandidate(this.a.emitCandidate())
    await this.a.addIceCandidate(this.b.emitCandidate())
  }

  /** One sampling interval of media in both directions. */
  tick(times = 1): void {
    for (let i = 0; i < times; i++) {
      this.#flow(this.a, this.b)
      this.#flow(this.b, this.a)
      this.a.advanceStatsClock(1_000)
      this.b.advanceStatsClock(1_000)
    }
  }

  #flow(from: FakeRTCPeerConnection, to: FakeRTCPeerConnection): void {
    if (from.connectionState !== 'connected' || to.connectionState !== 'connected') return
    for (const sender of from.getTransceivers()) {
      const mid = sender.mid
      if (mid === null || sender.stopped) continue
      if (!sender.sender.track) continue
      if (trackState(sender.sender.track).readyState === 'ended') continue
      if (!sender.currentDirection || !SENDS.has(sender.currentDirection)) continue
      const receiver = to.transceiverByMid(mid)
      if (!receiver || !receiver.currentDirection || !RECEIVES.has(receiver.currentDirection)) continue
      const packets = 50
      const frames = sender.kind === 'video' ? 30 : 0
      from.scriptStats(mid, { packetsSent: packets, framesEncoded: frames, roundTripTimeMeasurements: 1 })
      to.scriptStats(mid, { packetsReceived: packets, framesDecoded: frames })
      if (receiver.receiver.track) trackState(receiver.receiver.track).muted = false
    }
  }

  /** Both ends lose the transport, as a network blip does. */
  disconnect(): void {
    this.a.setConnectionState('disconnected')
    this.b.setConnectionState('disconnected')
  }
}

/** A `PeerFactory` that hands out fakes and keeps every instance it made, so a test can reach into whichever connection a `Peer` ended up creating. */
export function createFakeFactory(options: FakeConnectionOptions = {}): ((context?: PeerContext) => FakeRTCPeerConnection) & {
  instances: FakeRTCPeerConnection[]
  /** The connection most recently opened to `device`, whatever rung it was
   *  opened on. */
  to(device: string): FakeRTCPeerConnection | undefined
} {
  const instances: FakeRTCPeerConnection[] = []
  const factory = (context?: PeerContext) => {
    const pc = new FakeRTCPeerConnection(options)
    pc.context = context
    instances.push(pc)
    return pc
  }
  factory.instances = instances
  factory.to = (device: string) =>
    [...instances].reverse().find((pc) => pc.context?.remoteDevice === device && !pc.closed)
  return factory
}
