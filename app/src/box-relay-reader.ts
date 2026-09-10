import type { Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { normaliseRelayConfig, type RelayConfig, type RelayTransport } from '../../src/relay-pool.js'

type Request = { filters: Filter[]; receive: (event: Event) => void; ready?: () => void; eosed: Set<string>; timer?: ReturnType<typeof setTimeout> }
/** Bounded, read-only discovery subscriptions. Unlike SimplePool's completion
 * callback, only actual EOSE frames complete history. A disconnect or timeout
 * removes trust and restarts the entire read, including keeper retirement. */
export class BoxRelayReader implements RelayTransport {
  #urls: string[]
  #sockets = new Map<string, WebSocket>()
  #requests = new Map<string, Request>()
  #serial = 0
  #generation = 0
  #closed = false
  #retry?: ReturnType<typeof setTimeout>
  #connectTimers: ReturnType<typeof setTimeout>[] = []
  #window = Date.now()
  #frames = 0
  constructor(relays: RelayConfig[], private unavailable: () => void, private socket: (url: string) => WebSocket = url => new WebSocket(url)) {
    this.#urls = normaliseRelayConfig(relays).filter(r => r.read).map(r => r.url)
    if (!this.#urls.length) throw new Error('No default read relay is configured.')
  }
  async publish(): Promise<void> { throw new Error('Box discovery is read-only.') }
  subscribe(filters: Filter[], receive: (event: Event) => void, ready?: () => void): () => void {
    if (this.#closed) throw new Error('Box discovery is closed.')
    if (this.#requests.size >= 3) throw new Error('Too many box discovery requests.')
    const id = 'box-' + ++this.#serial
    const request: Request = { filters, receive, ready, eosed: new Set() }
    this.#requests.set(id, request)
    if (!this.#sockets.size && !this.#retry) this.#connect()
    else for (const ws of this.#sockets.values()) if (ws.readyState === 1) this.#send(ws, id, request)
    return () => {
      clearTimeout(request.timer); this.#requests.delete(id)
      for (const ws of this.#sockets.values()) if (ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', id]))
    }
  }
  #send(ws: WebSocket, id: string, request: Request): void {
    ws.send(JSON.stringify(['REQ', id, ...request.filters]))
    request.timer ??= setTimeout(() => this.#failed(), 15_000)
  }
  #connect(): void {
    const generation = this.#generation
    try {
      for (const url of this.#urls) {
        const ws = this.socket(url); this.#sockets.set(url, ws)
        const active = () => !this.#closed && generation === this.#generation
        const timer = setTimeout(() => { if (active()) this.#failed() }, 15_000)
        this.#connectTimers.push(timer)
        ws.onopen = () => {
          if (!active()) return
          clearTimeout(timer)
          for (const [id, request] of this.#requests) this.#send(ws, id, request)
        }
        ws.onclose = ws.onerror = () => { if (active()) this.#failed() }
        ws.onmessage = message => {
          if (!active()) return
          if (Date.now() - this.#window >= 10_000) { this.#window = Date.now(); this.#frames = 0 }
          if (++this.#frames > 256 || typeof message.data !== 'string' || message.data.length > 33_000) { this.#failed(30_000); return }
          try {
            const frame: unknown = JSON.parse(message.data)
            if (!Array.isArray(frame) || typeof frame[1] !== 'string') return
            const request = this.#requests.get(frame[1]); if (!request) return
            if (frame[0] === 'EOSE' && frame.length === 2) {
              const complete = this.#urls.every(u => request.eosed.has(u))
              request.eosed.add(url)
              if (!complete && this.#urls.every(u => request.eosed.has(u))) { clearTimeout(request.timer); request.timer = undefined; request.ready?.() }
            } else if (frame[0] === 'CLOSED') this.#failed()
            else if (frame[0] === 'EVENT' && frame.length === 3 && matchFilters(request.filters, frame[2] as Event)) request.receive(frame[2] as Event)
          } catch { /* Malformed input never completes history or grants trust. */ }
        }
      }
    } catch { this.#failed() }
  }
  #reset(): void {
    this.#generation++
    for (const timer of this.#connectTimers) clearTimeout(timer)
    this.#connectTimers = []
    for (const request of this.#requests.values()) { clearTimeout(request.timer); request.timer = undefined; request.eosed.clear() }
    for (const ws of this.#sockets.values()) { try { ws.close() } catch { /* Already closed. */ } }
    this.#sockets.clear()
  }
  #failed(delay = 5_000): void {
    if (this.#closed || this.#retry) return
    this.#reset()
    this.#retry = setTimeout(() => { this.#retry = undefined; if (!this.#closed) this.#connect() }, delay)
    this.unavailable()
  }
  close(): void { this.#closed = true; clearTimeout(this.#retry); this.#reset(); this.#requests.clear() }
}
