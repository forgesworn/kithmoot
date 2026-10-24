import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRealtimeService, discoverRealtimeServices, RealtimeServiceHost } from './service.js'
import type { SignalEvent, SwarmSession, TransportRuntime } from './runtime.js'

const OPERATOR = 'aa'.repeat(32), CLIENT = 'bb'.repeat(32), OTHER = 'cc'.repeat(32), THIRD = 'dd'.repeat(32)
const PUBLICATION = 'a1'.repeat(16), SECOND = 'b2'.repeat(16)
const TRANSPORT = 'webrtc-live'
const BOUND_POLICY = { offerer: 'operator', maxPacketLifeTimeMs: 250 }
const identifier = (n: number) => n.toString(16).padStart(32, '0')
type Presence = Parameters<Parameters<SwarmSession['onPresence']>[0]>[0]
class Session implements SwarmSession {
  pubkey = OPERATOR
  signals = new Set<(event: SignalEvent) => void>()
  presences = new Set<(event: Presence) => void>()
  start = vi.fn()
  close = vi.fn()
  sendSignal = vi.fn<SwarmSession['sendSignal']>()
  announcePresence = vi.fn<SwarmSession['announcePresence']>()
  onSignal(handler: (event: SignalEvent) => void) { this.signals.add(handler); return () => { this.signals.delete(handler) } }
  onPresence(handler: (event: Presence) => void) { this.presences.add(handler); return () => { this.presences.delete(handler) } }
  receive(from: string, type: string, requestId: string, payload: Record<string, unknown>, transport = TRANSPORT) {
    // This is the actual RelaySwarmSession callback shape: the encrypted
    // envelope is nested in payload, with application data nested once more.
    const event: SignalEvent = { from, event: { created_at: Math.floor(Date.now() / 1000) }, payload: { type, transport, requestId, payload } }
    for (const handler of [...this.signals]) handler(event)
  }
  presence(from: string, created_at: number, open: boolean, advertisedKey = from) {
    const event: Presence = { from, event: { created_at }, payload: { role: 'call-forwarder', open,
      transports: [{ type: TRANSPORT, publicKey: advertisedKey }] } }
    for (const handler of [...this.presences]) handler(event)
  }
}
type PeerOptions = ConstructorParameters<TransportRuntime['RealtimePeer']>[0]
class Peer {
  static instances: Peer[] = []
  static nextReady: Promise<unknown> | undefined
  ready: Promise<unknown>
  pc = {} as RTCPeerConnection
  closed = false
  start = vi.fn(() => this.ready)
  send = vi.fn(() => true)
  constructor(readonly options: PeerOptions) { this.ready = Peer.nextReady ?? Promise.resolve(); Peer.nextReady = undefined; Peer.instances.push(this) }
  snapshot() { return { closed: this.closed } }
  close() { if (this.closed) return; this.closed = true; this.options.onClose?.() }
}
const runtime = { RealtimePeer: Peer } as unknown as TransportRuntime
const ice = { iceServers: [], iceTransportPolicy: 'relay' as const }
const hosts: RealtimeServiceHost[] = []
beforeEach(() => { Peer.instances.length = 0; Peer.nextReady = undefined })
afterEach(() => { for (const host of hosts.splice(0)) host.close(); vi.restoreAllMocks(); vi.useRealTimers() })
function host(session = new Session(), maxPeers = 16) {
  const service = new RealtimeServiceHost(runtime, session, new Set([CLIENT, OTHER, THIRD]), ice, maxPeers)
  hosts.push(service); return { service, session }
}
function bind(session: Session, from: string, id: number, publications = [PUBLICATION], subscriptions: string[] = []) {
  session.receive(from, 'live-bind', identifier(id), { publications, subscriptions })
}

describe('explicit independent transport service admission', () => {
  it('uses the nested authenticated envelope and rejects strangers, downgrade and invalid routes before allocation', () => {
    const { session, service } = host()
    bind(session, 'ee'.repeat(32), 1)
    session.receive(CLIENT, 'live-bind', identifier(1), { publications: [PUBLICATION], subscriptions: [] }, 'webrtc')
    bind(session, CLIENT, 1, [PUBLICATION, PUBLICATION])
    bind(session, CLIENT, 1, ['invalid'])
    bind(session, CLIENT, 1, [PUBLICATION], Array.from({ length: 65 }, (_, i) => identifier(i)))
    expect(Peer.instances).toHaveLength(0)
    bind(session, CLIENT, 1)
    expect(Peer.instances).toHaveLength(1)
    expect(Peer.instances[0].options).toMatchObject({ peerPubkey: CLIENT, initiator: true, requestId: identifier(1), maxPacketLifeTimeMs: 250, ...ice })
    expect(Peer.instances[0].start).not.toHaveBeenCalled()
    expect(service.router.snapshot()).toMatchObject({ peers: 1, routes: 1 })
    expect(session.sendSignal).toHaveBeenCalledWith(CLIENT, { type: 'live-bound', transport: TRANSPORT, requestId: identifier(1), payload: BOUND_POLICY })
  })

  it('creates no SDP before the matching client readiness signal and ignores readiness replays', () => {
    const { session } = host()
    bind(session, CLIENT, 1)
    const peer = Peer.instances[0]
    peer.start.mockImplementation(() => {
      session.sendSignal(CLIENT, { type: 'live-offer', transport: TRANSPORT, requestId: identifier(1), payload: { sdp: 'synthetic fixture' } })
      return peer.ready
    })
    session.sendSignal.mockClear()
    session.receive(OTHER, 'live-ready', identifier(1), {})
    session.receive(CLIENT, 'live-ready', identifier(99), {})
    session.receive(CLIENT, 'live-ready', identifier(1), {}, 'webrtc')
    expect(peer.start).not.toHaveBeenCalled()
    expect(session.sendSignal).not.toHaveBeenCalled()
    session.receive(CLIENT, 'live-ready', identifier(1), {})
    session.receive(CLIENT, 'live-ready', identifier(1), {})
    expect(peer.start).toHaveBeenCalledOnce()
    expect(session.sendSignal).toHaveBeenCalledExactlyOnceWith(CLIENT, {
      type: 'live-offer', transport: TRANSPORT, requestId: identifier(1), payload: { sdp: 'synthetic fixture' },
    })
  })

  it('expires a client that never becomes ready without starting negotiation or retaining route state', async () => {
    vi.useFakeTimers()
    const { session, service } = host()
    bind(session, CLIENT, 1)
    const peer = Peer.instances[0]
    await vi.advanceTimersByTimeAsync(14_999)
    expect(peer.closed).toBe(false)
    expect(peer.start).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(peer.closed).toBe(true)
    expect(peer.start).not.toHaveBeenCalled()
    expect(service.router.snapshot()).toMatchObject({ peers: 0, routes: 0 })
    expect(vi.getTimerCount()).toBe(0)
    session.receive(CLIENT, 'live-ready', identifier(1), {})
    bind(session, CLIENT, 1)
    expect(Peer.instances).toHaveLength(1)
    expect(peer.start).not.toHaveBeenCalled()
  })

  it('cancels the readiness timer when the client becomes ready or its native peer closes', async () => {
    vi.useFakeTimers()
    const { session, service } = host()
    bind(session, CLIENT, 1)
    session.receive(CLIENT, 'live-ready', identifier(1), {})
    expect(Peer.instances[0].start).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(Peer.instances[0].closed).toBe(false)
    bind(session, OTHER, 2, [SECOND])
    expect(vi.getTimerCount()).toBe(1)
    Peer.instances[1].close()
    expect(vi.getTimerCount()).toBe(0)
    expect(service.router.snapshot()).toMatchObject({ peers: 1, routes: 1 })
  })

  it('ignores duplicate and already-retired negotiation IDs while replacing only the same client', () => {
    const { session, service } = host()
    bind(session, CLIENT, 1); bind(session, OTHER, 2, [SECOND])
    bind(session, CLIENT, 1)
    expect(Peer.instances).toHaveLength(2)
    bind(session, CLIENT, 3)
    expect(Peer.instances).toHaveLength(3)
    expect(Peer.instances.map(p => p.closed)).toEqual([true, false, false])
    bind(session, CLIENT, 1)
    expect(Peer.instances).toHaveLength(3)
    expect(service.router.snapshot()).toMatchObject({ peers: 2, routes: 2 })
  })

  it('closes the newly allocated native peer when another client owns its claimed publication', () => {
    const { session, service } = host()
    bind(session, CLIENT, 1); bind(session, OTHER, 2)
    expect(Peer.instances).toHaveLength(2)
    expect(Peer.instances.map(p => p.closed)).toEqual([false, true])
    expect(service.router.snapshot()).toMatchObject({ peers: 1, routes: 1 })
    expect(session.sendSignal).toHaveBeenCalledTimes(1)
  })

  it('closes refused peers at capacity and does not disturb existing native connections', () => {
    const { session, service } = host(new Session(), 2)
    bind(session, CLIENT, 1); bind(session, OTHER, 2, [SECOND]); bind(session, THIRD, 3, ['c3'.repeat(16)])
    expect(Peer.instances.map(p => p.closed)).toEqual([false, false, true])
    expect(service.router.snapshot()).toMatchObject({ peers: 2, routes: 2 })
  })

  it('forwards and rate-limits recovery only for a bound subscriber and clears old publication throttle on replacement', () => {
    const { session } = host()
    vi.spyOn(performance, 'now').mockReturnValue(100)
    bind(session, CLIENT, 1); bind(session, OTHER, 2, [], [PUBLICATION])
    session.sendSignal.mockClear()
    session.receive(OTHER, 'live-keyframe', identifier(9), { publication: PUBLICATION })
    session.receive(OTHER, 'live-keyframe', identifier(2), { publication: SECOND })
    session.receive(THIRD, 'live-keyframe', identifier(2), { publication: PUBLICATION })
    expect(session.sendSignal).not.toHaveBeenCalled()
    session.receive(OTHER, 'live-keyframe', identifier(2), { publication: PUBLICATION })
    session.receive(OTHER, 'live-keyframe', identifier(2), { publication: PUBLICATION })
    expect(session.sendSignal).toHaveBeenCalledExactlyOnceWith(CLIENT, { type: 'live-keyframe', transport: TRANSPORT, requestId: identifier(1), payload: { publication: PUBLICATION } })
    bind(session, CLIENT, 3)
    session.sendSignal.mockClear()
    session.receive(OTHER, 'live-keyframe', identifier(2), { publication: PUBLICATION })
    expect(session.sendSignal).toHaveBeenCalledExactlyOnceWith(CLIENT, { type: 'live-keyframe', transport: TRANSPORT, requestId: identifier(3), payload: { publication: PUBLICATION } })
  })

  it('bounds remembered binding IDs, expires them and frees every peer/listener on shutdown', () => {
    const { session, service } = host()
    let at = 0; vi.spyOn(performance, 'now').mockImplementation(() => at)
    for (let i = 1; i <= 130; i++) bind(session, CLIENT, i)
    expect(Peer.instances).toHaveLength(128)
    expect(Peer.instances.filter(p => !p.closed)).toHaveLength(1)
    at = 180_001; bind(session, CLIENT, 131)
    expect(Peer.instances).toHaveLength(129)
    service.close(); service.close()
    expect(Peer.instances.every(p => p.closed)).toBe(true)
    expect(session.signals.size).toBe(0)
    expect(service.router.snapshot()).toMatchObject({ peers: 0, routes: 0 })
    expect(session.close).not.toHaveBeenCalled()
  })
})

describe('selected service client handshake', () => {
  it('starts the browser answerer before notifying the selected operator that it can send SDP', async () => {
    const session = new Session()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION], subscriptions: [SECOND], ice, onDatagram() {} })
    const id = session.sendSignal.mock.calls[0][1].requestId
    expect(Peer.instances).toHaveLength(0)
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    const connection = await pending
    try {
      const peer = Peer.instances[0]
      expect(peer.options).toMatchObject({ initiator: false, peerPubkey: OTHER, requestId: id, maxPacketLifeTimeMs: 250 })
      expect(peer.start).toHaveBeenCalledOnce()
      expect(session.sendSignal.mock.calls[1]).toEqual([OTHER, { type: 'live-ready', transport: TRANSPORT, requestId: id, payload: {} }])
      expect(peer.start.mock.invocationCallOrder[0]).toBeLessThan(session.sendSignal.mock.invocationCallOrder[1])
      // A duplicate bound acknowledgement cannot create a second native peer
      // or announce readiness again after the handshake listener is removed.
      session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
      expect(Peer.instances).toHaveLength(1)
      expect(session.sendSignal.mock.calls.filter(([, signal]) => signal.type === 'live-ready')).toHaveLength(1)
    } finally { connection.close() }
  })

  it.each([
    {},
    { offerer: 'client', maxPacketLifeTimeMs: 250 },
    { offerer: 'operator', maxPacketLifeTimeMs: 50 },
    { offerer: 'operator', maxPacketLifeTimeMs: 0 },
    { offerer: 'operator', maxPacketLifeTimeMs: '250' },
    { offerer: 'operator', maxRetransmits: 0 },
  ])('refuses an authenticated bound acknowledgement with unsupported role or lifetime: %j', async policy => {
    vi.useFakeTimers()
    const session = new Session()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [], subscriptions: [], ice, onDatagram() {} })
    const rejection = expect(pending).rejects.toThrow('unsupported channel policy')
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(OTHER, 'live-bound', id, policy)
    await rejection
    expect(Peer.instances).toHaveLength(0)
    expect(session.signals.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(session.sendSignal.mock.calls.filter(([, signal]) => signal.type === 'live-ready')).toHaveLength(0)
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    expect(Peer.instances).toHaveLength(0)
  })

  it('cleans readiness listeners and the answerer when native setup rejects after acknowledgement', async () => {
    let rejectReady!: (error: Error) => void
    Peer.nextReady = new Promise((_resolve, reject) => { rejectReady = reject })
    const session = new Session()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION], subscriptions: [], ice, onDatagram() {} })
    const rejection = expect(pending).rejects.toThrow('synthetic negotiation failure')
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    await vi.waitFor(() => expect(Peer.instances).toHaveLength(1))
    expect(session.sendSignal.mock.calls.filter(([, signal]) => signal.type === 'live-ready')).toHaveLength(1)
    rejectReady(new Error('synthetic negotiation failure'))
    await rejection
    expect(Peer.instances[0].closed).toBe(true)
    expect(session.signals.size).toBe(0)
  })

  it('bounds incoming operator keyframe callback floods independently for each owned publication', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const session = new Session(), recovery = vi.fn()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION, SECOND],
      subscriptions: [], ice, onDatagram() {}, onKeyFrameRequired: recovery })
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    const connection = await pending
    try {
      session.receive(CLIENT, 'live-keyframe', id, { publication: PUBLICATION })
      session.receive(OTHER, 'live-keyframe', identifier(99), { publication: PUBLICATION })
      session.receive(OTHER, 'live-keyframe', id, { publication: identifier(88) })
      expect(recovery).not.toHaveBeenCalled()
      for (let n = 0; n < 30; n++) session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
      expect(recovery).toHaveBeenCalledExactlyOnceWith(PUBLICATION)
      now = 1099; session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
      expect(recovery).toHaveBeenCalledOnce()
      session.receive(OTHER, 'live-keyframe', id, { publication: SECOND })
      expect(recovery).toHaveBeenCalledTimes(2)
      now = 1100
      session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
      session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
      expect(recovery).toHaveBeenCalledTimes(3)
      expect(recovery.mock.calls.map(([publication]) => publication)).toEqual([PUBLICATION, SECOND, PUBLICATION])
    } finally { connection.close() }
  })

  it('fences outgoing and incoming recovery after a native peer closure', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const session = new Session(), recovery = vi.fn()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION],
      subscriptions: [SECOND], ice, onDatagram() {}, onKeyFrameRequired: recovery })
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    const connection = await pending
    try {
      connection.requestKeyFrame(SECOND)
      // Exercise the transport's native onClose path, rather than relying on
      // a caller's orderly shutdown or a monkey-patched connection.close.
      Peer.instances[0].options.onClose?.()
      expect(session.signals.size).toBe(0)
      session.sendSignal.mockClear()
      now = 2100
      connection.requestKeyFrame(SECOND)
      session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
      expect(session.sendSignal).not.toHaveBeenCalled()
      expect(recovery).not.toHaveBeenCalled()
    } finally { connection.close() }
  })

  it('scopes outbound keyframe requests to subscriptions and rate-limits each publication to one per second', async () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const session = new Session(), thirdPublication = identifier(33)
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION],
      subscriptions: [SECOND, thirdPublication], ice, onDatagram() {} })
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    const connection = await pending
    try {
      session.sendSignal.mockClear()
      connection.requestKeyFrame(PUBLICATION)
      connection.requestKeyFrame(identifier(99))
      connection.requestKeyFrame('invalid')
      expect(session.sendSignal).not.toHaveBeenCalled()
      for (let n = 0; n < 20; n++) connection.requestKeyFrame(SECOND)
      expect(session.sendSignal).toHaveBeenCalledExactlyOnceWith(OTHER, {
        type: 'live-keyframe', transport: TRANSPORT, requestId: id, payload: { publication: SECOND },
      })
      now = 1099; connection.requestKeyFrame(SECOND)
      expect(session.sendSignal).toHaveBeenCalledOnce()
      // Distinct subscribed publications have independent bounded feedback.
      connection.requestKeyFrame(thirdPublication)
      expect(session.sendSignal).toHaveBeenCalledTimes(2)
      now = 1100
      connection.requestKeyFrame(SECOND); connection.requestKeyFrame(SECOND)
      expect(session.sendSignal).toHaveBeenCalledTimes(3)
      expect(session.sendSignal.mock.calls[2][1].payload).toEqual({ publication: SECOND })
    } finally { connection.close() }
  })

  it('requires the exact operator, transport and ID before opening a peer and pins recovery directions', async () => {
    const session = new Session(), keyframe = vi.fn()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [PUBLICATION], subscriptions: [SECOND], ice,
      onDatagram() {}, onKeyFrameRequired: keyframe })
    const id = session.sendSignal.mock.calls[0][1].requestId
    session.receive(CLIENT, 'live-bound', id, {})
    session.receive(OTHER, 'live-bound', identifier(99), {})
    session.receive(OTHER, 'live-bound', id, {}, 'webrtc')
    await Promise.resolve(); expect(Peer.instances).toHaveLength(0)
    session.receive(OTHER, 'live-bound', id, BOUND_POLICY)
    const connection = await pending
    expect(Peer.instances[0].options).toMatchObject({ peerPubkey: OTHER, initiator: false, requestId: id, maxPacketLifeTimeMs: 250 })
    session.receive(OTHER, 'live-keyframe', id, { publication: SECOND })
    session.receive(CLIENT, 'live-keyframe', id, { publication: PUBLICATION })
    expect(keyframe).not.toHaveBeenCalled()
    session.receive(OTHER, 'live-keyframe', id, { publication: PUBLICATION })
    expect(keyframe).toHaveBeenCalledExactlyOnceWith(PUBLICATION)
    session.sendSignal.mockClear()
    connection.requestKeyFrame(PUBLICATION); expect(session.sendSignal).not.toHaveBeenCalled()
    connection.requestKeyFrame(SECOND)
    expect(session.sendSignal).toHaveBeenCalledExactlyOnceWith(OTHER, { type: 'live-keyframe', transport: TRANSPORT, requestId: id, payload: { publication: SECOND } })
    connection.close(); expect(session.signals.size).toBe(0)
  })

  it('times out without leaving a handshake listener or allocating a native peer', async () => {
    vi.useFakeTimers()
    const session = new Session()
    const pending = connectRealtimeService({ runtime, session, operator: OTHER, publications: [], subscriptions: [], ice, onDatagram() {}, timeoutMs: 25 })
    const rejection = expect(pending).rejects.toThrow('Selected call service did not respond')
    await vi.advanceTimersByTimeAsync(25); await rejection
    expect(Peer.instances).toHaveLength(0); expect(session.signals.size).toBe(0)
  })
})

describe('pinned expiring service discovery', () => {
  it('requires allowed operator identity, matching advertised key and a fresh signed time', () => {
    let now = 1_000_000
    const session = new Session(), discovery = discoverRealtimeServices(session, new Set([OTHER]), () => now)
    session.presence(CLIENT, 1000, true)
    session.presence(OTHER, 1000, true, CLIENT)
    session.presence(OTHER, 879, true)
    session.presence(OTHER, 1031, true)
    expect(discovery.current()).toEqual([])
    session.presence(OTHER, 1000, true)
    expect(discovery.current()).toEqual([OTHER])
    now = 1_120_000; expect(discovery.current()).toEqual([])
    discovery.close(); expect(session.presences.size).toBe(0)
  })

  it('ignores delayed older announcements after a newer open or closed state', () => {
    const session = new Session(), discovery = discoverRealtimeServices(session, new Set([OTHER]), () => 1_010_000)
    session.presence(OTHER, 1005, true)
    session.presence(OTHER, 1000, false)
    expect(discovery.current()).toEqual([OTHER])
    session.presence(OTHER, 1008, false)
    session.presence(OTHER, 1006, true)
    expect(discovery.current()).toEqual([])
    discovery.close()
  })
})
