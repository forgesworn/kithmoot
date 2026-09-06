import { SimplePool } from 'nostr-tools/pool'
import { normalizeURL } from 'nostr-tools/utils'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { isSafeRelayUrl, MAX_RELAY_HINTS } from './network-hints.js'

/** The transport seam shared by real relays and the in-process simulator. */
export interface RelayTransport {
  publish(event: Event): Promise<void>
  subscribe(filters: Filter[], onEvent: (event: Event) => void, onEose?: () => void): () => void
  close(): void
}

export interface RelayConfig { url: string; read: boolean; write: boolean }
export interface RelayHealth extends RelayConfig {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed'
  lastConnectedAt?: number
  lastPublishedAt?: number
  publishLatencyMs?: number
  lastError?: string
}

export function normaliseRelayConfig(entries: readonly (string | RelayConfig)[]): RelayConfig[] {
  if (entries.length === 0) throw new Error('at least one relay is required')
  if (entries.length > MAX_RELAY_HINTS) throw new Error(`use at most ${MAX_RELAY_HINTS} relays`)
  const seen = new Set<string>()
  return entries.map(entry => {
    const value = typeof entry === 'string' ? { url: entry, read: true, write: true } : entry
    if (!value || typeof value.url !== 'string' || !isSafeRelayUrl(value.url.trim())) throw new Error('use a wss:// relay URL (ws:// is allowed only on localhost)')
    const parsed = new URL(value.url.trim())
    if (parsed.username || parsed.password || parsed.hash) throw new Error('relay URLs cannot contain credentials or fragments')
    if (typeof value.read !== 'boolean' || typeof value.write !== 'boolean' || (!value.read && !value.write)) throw new Error('each relay must allow reading or writing')
    const url = normalizeURL(value.url.trim())
    if (seen.has(url)) throw new Error('that relay is already in the list')
    seen.add(url)
    return { url, read: value.read, write: value.write }
  })
}

type Subscription = {
  filters: Filter[]
  onEvent: (event: Event) => void
  onEose?: () => void
  seen: Set<string>
  stop?: () => void
}

export class NostrRelayPool implements RelayTransport {
  #pool: SimplePool
  #relays: RelayConfig[]
  #health = new Map<string, Partial<RelayHealth>>()
  #subscriptions = new Set<Subscription>()
  #generation = 0
  #abort = new AbortController()
  #closed = false

  constructor(relays: readonly (string | RelayConfig)[]) {
    this.#relays = normaliseRelayConfig(relays)
    this.#pool = this.#createPool()
  }

  #createPool(): SimplePool {
    const generation = this.#generation
    // Reconnect long-lived room subscriptions after sleep/network changes;
    // ping notices sockets that are dead without being closed. A failed first
    // connection needs the explicit reconnect action (nostr-tools limitation).
    const pool = new SimplePool({ enableReconnect: true, enablePing: true })
    pool.onRelayConnectionSuccess = url => {
      if (generation === this.#generation) this.#mark(url, { state: 'connected', lastConnectedAt: Date.now(), lastError: undefined })
    }
    pool.onRelayConnectionFailure = url => {
      if (generation === this.#generation) this.#mark(url, { state: 'disconnected', lastError: 'Connection failed' })
    }
    return pool
  }

  #mark(url: string, update: Partial<RelayHealth>): void {
    const key = normalizeURL(url)
    this.#health.set(key, { ...this.#health.get(key), ...update })
  }

  get closed(): boolean { return this.#closed }
  configuration(): RelayConfig[] { return this.#relays.map(relay => ({ ...relay })) }

  health(): RelayHealth[] {
    const connections = this.#pool.listConnectionStatus()
    return this.#relays.map(relay => {
      const previous = this.#health.get(relay.url)
      const connected = connections.get(relay.url)
      const state = this.#closed ? 'closed' : connected === true ? 'connected'
        : previous?.state === 'connected' ? 'disconnected' : previous?.state ?? 'idle'
      return { ...previous, ...relay, state }
    })
  }

  /** Rebind existing consumers without leaving the room or replaying history. */
  setRelays(entries: readonly (string | RelayConfig)[]): void {
    if (this.#closed) throw new Error('pool is closed')
    const next = normaliseRelayConfig(entries)
    this.#generation++
    this.#abort.abort()
    for (const sub of this.#subscriptions) sub.stop?.()
    this.#pool.destroy()
    this.#relays = next
    this.#health.clear()
    this.#abort = new AbortController()
    this.#pool = this.#createPool()
    for (const sub of this.#subscriptions) this.#start(sub)
  }

  reconnect(): void { this.setRelays(this.#relays) }

  async publish(event: Event): Promise<void> {
    if (this.#closed) throw new Error('pool is closed')
    const urls = this.#relays.filter(relay => relay.write).map(relay => relay.url)
    if (!urls.length) throw new Error('no writable relay is configured')
    const generation = this.#generation
    const start = Date.now()
    for (const url of urls) if (!this.#pool.listConnectionStatus().get(url)) this.#mark(url, { state: 'connecting' })
    // Every writable relay receives the event; success still means at least
    // one acknowledged it, not that every relay saved it.
    const results = await Promise.allSettled(this.#pool.publish(urls, event, { abort: this.#abort.signal }).map(async (result, i) => {
      try {
        await result
        if (generation === this.#generation) this.#mark(urls[i]!, { state: 'connected', lastPublishedAt: Date.now(), publishLatencyMs: Date.now() - start, lastError: undefined })
      } catch (error) {
        if (generation === this.#generation) this.#mark(urls[i]!, { lastError: 'Last publish failed or was rejected' })
        throw error
      }
    }))
    if (!results.some(result => result.status === 'fulfilled')) throw new Error('every relay rejected the event')
  }

  subscribe(filters: Filter[], onEvent: (event: Event) => void, onEose?: () => void): () => void {
    if (this.#closed) throw new Error('pool is closed')
    const sub: Subscription = { filters, onEvent, onEose, seen: new Set() }
    this.#subscriptions.add(sub)
    this.#start(sub)
    return () => { this.#subscriptions.delete(sub); sub.stop?.() }
  }

  #start(sub: Subscription): void {
    const generation = this.#generation
    const urls = this.#relays.filter(relay => relay.read).map(relay => relay.url)
    if (!urls.length) { sub.stop = undefined; return }
    for (const url of urls) if (!this.#pool.listConnectionStatus().get(url)) this.#mark(url, { state: 'connecting' })
    // subscribeMap groups multiple filters into one OR request per relay.
    const requests = urls.flatMap(url => sub.filters.map(filter => ({ url, filter })))
    const active = () => !this.#closed && generation === this.#generation && this.#subscriptions.has(sub)
    const handle = this.#pool.subscribeMap(requests, {
      abort: this.#abort.signal,
      oneose: () => { if (active()) sub.onEose?.() },
      onevent: event => {
        if (!active() || sub.seen.has(event.id)) return
        sub.seen.add(event.id)
        sub.onEvent(event)
      },
    })
    sub.stop = () => handle.close()
  }

  close(): void {
    this.#closed = true
    this.#generation++
    this.#abort.abort()
    for (const sub of this.#subscriptions) sub.stop?.()
    this.#subscriptions.clear()
    this.#pool.destroy()
  }
}
