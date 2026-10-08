import type { Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { authenticatedWebSocket } from '../../src/relay-auth.js'
import { boundedEventVerifier } from '../../src/verify.js'
import type { BrowserLink, PairedBox } from './browser-link.js'
import type { LinkSocket } from './browser-link-types.js'

/** The callback WebSocket subset used by our existing NIP-42 gate. Every
 * address is pinned; the browser's native WebSocket is never a fallback. */
export function linkWebSocket(link: Pick<BrowserLink, 'openSocket'>, box: PairedBox): typeof WebSocket {
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    readyState = 0
    onopen: ((event: { type: string }) => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((event: { type: string }) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null
    #socket?: LinkSocket
    constructor(readonly url: string) {
      if (url !== box.eventUrl) throw new Error('Unpaired Link event address.')
      const waiting: string[] = []
      void link.openSocket(url, box.routeId, {
        onText: text => {
          if (this.readyState === 3) return
          if (text.length > 1_048_576) { this.close(); return }
          if (this.readyState === 1) this.onmessage?.({ data: text })
          else if (waiting.length < 8) waiting.push(text)
          else this.close()
        },
        onClosed: () => this.close(),
      }).then(socket => {
        if (this.readyState === 3) { socket.disconnect(); return }
        this.#socket = socket; this.readyState = 1; this.onopen?.({ type: 'open' })
        for (const data of waiting) { if (this.readyState === 1) this.onmessage?.({ data }) }
      }, () => { if (this.readyState !== 3) { this.onerror?.({ type: 'error' }); this.close() } })
    }
    send(text: string): void {
      if (this.readyState !== 1 || !this.#socket) throw new Error('Bothy is disconnected.')
      if (typeof text !== 'string' || text.length > 1_048_576) throw new Error('Link accepts bounded text frames only.')
      this.#socket.sendText(text)
    }
    close(): void {
      if (this.readyState === 3) return
      this.readyState = 3
      try { this.#socket?.disconnect() } finally { this.onclose?.({ code: 1000, reason: 'Bothy connection closed.' }) }
    }
  }
  return Socket as unknown as typeof WebSocket
}

export interface LinkRoomScope { room: string; kinds: readonly number[] }
type Subscription = { filters: Filter[]; receive: (event: Event, via?: string) => void; eose?: () => void; seen: Set<string> }

/** One authenticated box, one explicit room scope. Grant installation uses a
 * separate keeper connection; a room cannot broaden its granted filters.
 * Disconnect rejects pending writes. Reads resume over the same paired route. */
export class BrowserLinkRelay implements RelayTransport {
  #socket?: WebSocket
  #closed = false
  #retry?: ReturnType<typeof setTimeout>
  #connecting?: Promise<void>
  #requests = new Map<string, Subscription>()
  #writes = new Map<string, { finish: (error?: Error) => void }>()
  #verify = boundedEventVerifier()
  #serial = 0
  #backoff = 1000
  #authFailed = false
  #failure?: string
  #generation = 0
  readonly #Base: typeof WebSocket
  constructor(link: Pick<BrowserLink, 'openSocket'>, readonly box: PairedBox, identity: ParticipantIdentity, private scope: LinkRoomScope) {
    if (!/^[0-9a-f]{64}$/.test(scope.room) || !scope.kinds.length || scope.kinds.length > 16 || scope.kinds.some(k => !Number.isSafeInteger(k) || k < 0)) throw new Error('Invalid Bothy room scope.')
    this.scope = { room: scope.room, kinds: [...scope.kinds] }
    const grant = { pubkey: identity.pubkey, sign: identity.signEvent.bind(identity) }
    this.#Base = authenticatedWebSocket(linkWebSocket(link, box), () => grant, () => !this.#closed && !this.#authFailed,
      (_url, reason) => { this.#failure = reason; this.#authFailed = !reason.includes('timed out') }, 30_000)
  }
  describe() { return [{ url: this.box.eventUrl, read: true, write: true, circle: true }] }
  health() { return this.describe().map(r => ({ ...r, state: this.#closed ? 'closed' as const : this.#socket?.readyState === 1 ? 'connected' as const : 'disconnected' as const, lastError: this.#failure })) }
  async publish(event: Event): Promise<void> {
    const rooms = event.tags.filter(t => t[0] === 'd')
    if (!this.scope.kinds.includes(event.kind) || rooms.length !== 1 || rooms[0].length !== 2 || rooms[0][1] !== this.scope.room || !this.#verify(event)) throw new Error('Event is outside this Bothy room scope.')
    await this.#connect()
    if (this.#closed || this.#socket?.readyState !== 1) throw new Error('Bothy is disconnected.')
    if (this.#writes.size >= 64 || this.#writes.has(event.id)) throw new Error('Bothy publication is already pending or full.')
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Bothy publication timed out.')), 30_000)
      const finish = (error?: Error) => { clearTimeout(timer); this.#writes.delete(event.id); error ? reject(error) : resolve() }
      this.#writes.set(event.id, { finish })
      try { this.#socket!.send(JSON.stringify(['EVENT', event])) } catch { finish(new Error('Bothy publication failed.')) }
    })
  }
  subscribe(filters: Filter[], receive: Subscription['receive'], eose?: () => void): () => void {
    if (this.#closed || this.#requests.size >= 64 || !filters.length || filters.length > 16) throw new Error('Bothy subscription unavailable.')
    for (const f of filters) if (!f.kinds?.length || !f.kinds.every(k => this.scope.kinds.includes(k)) || f['#d']?.length !== 1 || f['#d'][0] !== this.scope.room) throw new Error('Filter is outside this Bothy room scope.')
    const id = `link-${++this.#serial}`
    const request: Subscription = { filters: structuredClone(filters), receive, eose, seen: new Set() }
    this.#requests.set(id, request)
    if (this.#socket?.readyState === 1) this.#send(id, request)
    else void this.#connect().catch(() => {})
    return () => { this.#requests.delete(id); if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(['CLOSE', id])) }
  }
  #send(id: string, request: Subscription): void { this.#socket!.send(JSON.stringify(['REQ', id, ...request.filters])) }
  #connect(): Promise<void> {
    if (this.#closed || this.#authFailed) return Promise.reject(new Error('Bothy is closed or authentication was refused.'))
    if (this.#socket?.readyState === 1) return Promise.resolve()
    if (this.#connecting) return this.#connecting
    clearTimeout(this.#retry); this.#retry = undefined
    const generation = ++this.#generation
    const work = new Promise<void>((resolve, reject) => {
      const socket = new this.#Base(this.box.eventUrl); this.#socket = socket
      const timer = setTimeout(() => socket.close(), 45_000)
      socket.onopen = () => {
        if (generation !== this.#generation || this.#closed) { socket.close(); return }
        clearTimeout(timer)
        this.#failure = undefined
        for (const [id, request] of this.#requests) this.#send(id, request)
        resolve()
      }
      socket.onclose = () => {
        clearTimeout(timer)
        if (generation !== this.#generation) return
        this.#socket = undefined
        for (const write of this.#writes.values()) write.finish(new Error('Bothy disconnected before confirming publication.'))
        reject(new Error('Bothy is unavailable.'))
        if (!this.#closed && !this.#authFailed && this.#requests.size) {
          this.#retry = setTimeout(() => { this.#retry = undefined; void this.#connect().catch(() => {}) }, this.#backoff)
          this.#backoff = Math.min(30_000, this.#backoff * 2)
        }
      }
      socket.onmessage = message => {
        if (generation !== this.#generation || this.#closed || typeof message.data !== 'string' || message.data.length > 1_048_576) return
        try {
          const f = JSON.parse(message.data)
          if (!Array.isArray(f)) return
          if (f[0] === 'OK' && f.length === 4 && typeof f[2] === 'boolean') {
            if (f[2] && this.#writes.has(f[1])) this.#backoff = 1000
            if (!f[2] && this.#writes.has(f[1])) this.#failure = 'Bothy refused this message. Its room grant may have expired or been withdrawn.'
            this.#writes.get(f[1])?.finish(f[2] ? undefined : new Error('every relay rejected the event: Bothy refused publication.'))
          }
          const request = this.#requests.get(f[1]); if (!request) return
          if (f[0] === 'EVENT' && f.length === 3 && this.#verify(f[2]) && matchFilters(request.filters, f[2]) && !request.seen.has(f[2].id)) {
            if (request.seen.size >= 4096) request.seen.clear()
            this.#backoff = 1000
            request.seen.add(f[2].id); request.receive(f[2], this.box.eventUrl)
          } else if (f[0] === 'EOSE' && f.length === 2) { this.#backoff = 1000; request.eose?.() }
          else if (f[0] === 'CLOSED') socket.close()
        } catch { /* Malformed frames cannot acknowledge a write or finish history. */ }
      }
    })
    this.#connecting = work
    void work.finally(() => { if (this.#connecting === work) this.#connecting = undefined }).catch(() => {})
    return work
  }
  close(): void {
    this.#closed = true; clearTimeout(this.#retry); this.#requests.clear()
    this.#socket?.close()
    for (const write of this.#writes.values()) write.finish(new Error('Bothy connection closed.'))
  }
}
