import { RealtimeForwarder } from './forwarder.js'
import type { RealtimePeer, SignalEvent, SwarmSession, TransportRuntime } from './runtime.js'

const TRANSPORT = 'webrtc-live'
// The public relay route measured 170-200 ms RTT. Keep a finite media
// lifetime which permits acknowledgement/fast loss recovery on that path.
export const REALTIME_PACKET_LIFETIME_MS = 250
const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[0-9a-f]{32}$/
function requestId(): string { return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('') }
function routes(value: unknown, max: number): string[] | null {
  return Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && ID.test(v))
    && new Set(value).size === value.length ? value : null
}
export interface ServiceIce { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; RTCPeerConnectionImpl?: typeof RTCPeerConnection }

/** An operator chooses transport clients, not room membership. Pinned client
 * identities are transport access policy; the host never receives room keys. */
export class RealtimeServiceHost {
  readonly router: RealtimeForwarder
  #links = new Map<string, { peer: RealtimePeer; id: string; publications: string[]; subscriptions: string[];
    started: boolean; readyTimer: ReturnType<typeof setTimeout> }>()
  #unlisten: () => void
  #keyframeAt = new Map<string, number>()
  #bindings = new Map<string, number>()
  #closed = false
  constructor(readonly runtime: TransportRuntime, readonly session: SwarmSession, readonly allowedClients: ReadonlySet<string>, readonly ice: ServiceIce, maxPeers = 16) {
    if (allowedClients.size < 1 || allowedClients.size > 64 || [...allowedClients].some(v => !HEX64.test(v))) throw new Error('Explicit transport client identities required')
    this.router = new RealtimeForwarder(maxPeers)
    this.#unlisten = session.onSignal(event => this.#signal(event))
  }
  announce(): void {
    this.session.announcePresence({ role: 'call-forwarder', transports: [{ type: TRANSPORT, publicKey: this.session.pubkey }],
      open: !this.#closed && this.router.snapshot().peers < this.router.maxPeers })
  }
  #signal(event: SignalEvent): void {
    if (this.#closed || !this.allowedClients.has(event.from) || event.payload.transport !== TRANSPORT) return
    const { type, requestId: id, payload } = event.payload
    if (!ID.test(id)) return
    if (type === 'live-ready') {
      const link = this.#links.get(event.from)
      if (!link || link.id !== id || link.started) return
      link.started = true; clearTimeout(link.readyTimer)
      void link.peer.start().catch(() => {})
      return
    }
    if (type === 'live-keyframe') {
      const link = this.#links.get(event.from), publication = payload.publication
      if (!link || link.id !== id || typeof publication !== 'string' || !link.subscriptions.includes(publication)) return
      const at = performance.now(), previous = this.#keyframeAt.get(publication) ?? -Infinity
      if (at - previous < 500) return
      for (const [owner, connection] of this.#links) if (connection.publications.includes(publication)) {
        this.#keyframeAt.set(publication, at)
        this.session.sendSignal(owner, { type: 'live-keyframe', transport: TRANSPORT, requestId: connection.id, payload: { publication } })
      }
      return
    }
    if (type !== 'live-bind') return
    const publications = routes(payload.publications, 4), subscriptions = routes(payload.subscriptions, 64)
    if (!publications || !subscriptions) return
    const existing = this.#links.get(event.from)
    if (existing?.id === id) return
    const now = performance.now()
    for (const [key, expires] of this.#bindings) if (now >= expires) this.#bindings.delete(key)
    if (this.#bindings.has(id) || this.#bindings.size >= 128) return
    this.#bindings.set(id, now + 180_000)
    // A later authenticated request from the same client replaces its own
    // connection only. No other client's publication can be claimed.
    if (existing) { clearTimeout(existing.readyTimer); this.#links.delete(event.from); this.router.detach(event.from); for (const p of existing.publications) this.#keyframeAt.delete(p) }
    let peer: RealtimePeer | undefined
    try {
      peer = new this.runtime.RealtimePeer({ session: this.session, peerPubkey: event.from, initiator: true, requestId: id,
        ...this.ice, maxPacketLifeTimeMs: REALTIME_PACKET_LIFETIME_MS, onDatagram: bytes => this.router.receive(event.from, bytes), onClose: () => {
          if (this.#links.get(event.from)?.id === id) {
            clearTimeout(this.#links.get(event.from)!.readyTimer)
            this.#links.delete(event.from); this.router.detach(event.from)
            for (const p of publications) this.#keyframeAt.delete(p)
          }
        } })
      this.router.attach(event.from, peer, publications, subscriptions)
    } catch { peer?.close(); return }
    const readyTimer = setTimeout(() => {
      if (this.#links.get(event.from)?.id === id) {
        this.#links.delete(event.from); this.router.detach(event.from)
        for (const p of publications) this.#keyframeAt.delete(p)
      }
    }, 15_000)
    this.#links.set(event.from, { peer, id, publications, subscriptions, started: false, readyTimer })
    this.session.sendSignal(event.from, { type: 'live-bound', transport: TRANSPORT, requestId: id,
      payload: { offerer: 'operator', maxPacketLifeTimeMs: REALTIME_PACKET_LIFETIME_MS } })
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#unlisten()
    for (const link of this.#links.values()) clearTimeout(link.readyTimer)
    this.router.close(); this.#links.clear(); this.#keyframeAt.clear(); this.#bindings.clear()
  }
}

export interface ForwarderConnection extends RealtimePeer { requestKeyFrame(publication: string): void }

/** The caller selects a pinned independent service. The room's trusted
 * control path supplies opaque publications, never a provider directory. */
export async function connectRealtimeService(options: {
  runtime: TransportRuntime; session: SwarmSession; operator: string; publications: string[]; subscriptions: string[];
  ice: ServiceIce; onDatagram: (bytes: Uint8Array) => void; onKeyFrameRequired?: (publication: string) => void; timeoutMs?: number
}): Promise<ForwarderConnection> {
  if (!HEX64.test(options.operator) || !routes(options.publications, 4) || !routes(options.subscriptions, 64)) throw new Error('Invalid selected call service')
  const id = requestId(), timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid call service timeout')
  let unlisten = () => {}, timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Selected call service did not respond')), timeoutMs)
    unlisten = options.session.onSignal(event => {
      if (event.from === options.operator && event.payload.transport === TRANSPORT && event.payload.requestId === id && event.payload.type === 'live-bound') {
        const value = event.payload.payload
        if (value.offerer !== 'operator' || value.maxPacketLifeTimeMs !== REALTIME_PACKET_LIFETIME_MS) reject(new Error('Selected call service uses an unsupported channel policy'))
        else resolve()
      }
    })
  })
  try {
    options.session.sendSignal(options.operator, { type: 'live-bind', transport: TRANSPORT, requestId: id,
      payload: { publications: options.publications, subscriptions: options.subscriptions } })
    await bound
  } finally { clearTimeout(timer); unlisten() }
  const requestedKeys = new Map<string, number>(), incomingKeys = new Map<string, number>()
  let closed = false
  const peer = new options.runtime.RealtimePeer({ session: options.session, peerPubkey: options.operator, initiator: false,
    requestId: id, ...options.ice, timeoutMs, maxPacketLifeTimeMs: REALTIME_PACKET_LIFETIME_MS, onDatagram: options.onDatagram, onClose: () => {
      closed = true; unlisten(); requestedKeys.clear(); incomingKeys.clear()
    } })
  unlisten = options.session.onSignal(event => {
    const publication = event.payload.payload.publication
    if (!closed && event.from === options.operator && event.payload.transport === TRANSPORT && event.payload.requestId === id
      && event.payload.type === 'live-keyframe' && typeof publication === 'string' && options.publications.includes(publication)) {
      const now = performance.now(), previous = incomingKeys.get(publication) ?? -Infinity
      if (now - previous < 1_000) return
      incomingKeys.set(publication, now); options.onKeyFrameRequired?.(publication)
    }
  })
  try {
    const ready = peer.start()
    options.session.sendSignal(options.operator, { type: 'live-ready', transport: TRANSPORT, requestId: id, payload: {} })
    await ready
  } catch (error) { unlisten(); peer.close(); throw error }
  return Object.assign(peer, { requestKeyFrame(publication: string) {
    if (closed || !options.subscriptions.includes(publication)) return
    const now = performance.now(), previous = requestedKeys.get(publication) ?? -Infinity
    if (now - previous < 1_000) return
    requestedKeys.set(publication, now)
    options.session.sendSignal(options.operator, { type: 'live-keyframe', transport: TRANSPORT, requestId: id, payload: { publication } })
  } })
}

/** Signed RelaySwarm presence is an expiring hint. An explicit local
 * allowlist pins operators; announcements never change room membership. */
export function discoverRealtimeServices(session: SwarmSession, operators: ReadonlySet<string>, now = () => Date.now()) {
  if (operators.size < 1 || operators.size > 64 || [...operators].some(v => !HEX64.test(v))) throw new Error('Explicit call service identities required')
  const hints = new Map<string, { expires: number; created: number; open: boolean }>()
  const unsubscribe = session.onPresence(event => {
    const age = Math.floor(now() / 1000) - event.event.created_at
    if (operators.has(event.from) && age >= -30 && age <= 120 && event.payload.role === 'call-forwarder'
      && event.payload.transports.some(t => t.type === TRANSPORT && t.publicKey === event.from)) {
      const previous = hints.get(event.from), created = event.event.created_at
      if (previous && (created < previous.created || created === previous.created && !previous.open)) return
      hints.set(event.from, { created, expires: Math.min(now() + 120_000, (created + 120) * 1000), open: event.payload.open === true })
    }
  })
  return { current(): string[] {
    for (const [key, hint] of hints) if (now() >= hint.expires) hints.delete(key)
    return [...hints].filter(([, hint]) => hint.open).map(([key]) => key)
  }, close(): void { unsubscribe(); hints.clear() } }
}
