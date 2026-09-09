import { SimplePool } from 'nostr-tools/pool'
import { normalizeURL } from 'nostr-tools/utils'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { isSafeRelayUrl, MAX_RELAY_HINTS } from './network-hints.js'

/** The transport seam shared by real relays and the in-process simulator. */
export interface RelayTransport {
  publish(event: Event): Promise<void>
  /** `via` is the relay URL that delivered the event, when the transport
   *  knows it. A consumer works out a message's lane from it and from
   *  nothing on the wire; see `lane.ts`. */
  subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void): () => void
  close(): void
  /** The relays this transport reads from and writes to, when it has any.
   *  Absent on transports that are not relays at all. */
  describe?(): RelayConfig[]
  /** Told the room's epoch key when a session opens on this transport and
   *  on every epoch it moves to. A transport that derives anything from
   *  the key, such as a quiet room's drop keys, implements it; a relay
   *  pool has no use for the key and leaves it out. See `quiet.ts`. */
  rekey?(key: Uint8Array): void
}

/** `circle` marks a relay the client knows to be a box of the person's own
 *  circle, from a contact card or the keeper's claim. Only such a relay is
 *  ever shown as sheltered; see `lane.ts`. */
export interface RelayConfig { url: string; read: boolean; write: boolean; circle?: boolean }
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
    return { url, read: value.read, write: value.write, ...(value.circle === true ? { circle: true } : {}) }
  })
}

type Subscription = {
  filters: Filter[]
  onEvent: (event: Event, via?: string) => void
  onEose?: () => void
  seen: Set<string>
  bindings: Map<string, { stop: () => void }>
  eosed: Set<string>
  eoseSent: boolean
}

export class NostrRelayPool implements RelayTransport {
  #pool: SimplePool
  #relays: RelayConfig[]
  #health = new Map<string, Partial<RelayHealth>>()
  #subscriptions = new Set<Subscription>()
  #generation = 0
  #abort = new AbortController()
  #closed = false
  #attempted = new Map<string, number>()
  #recovery: ReturnType<typeof setInterval>

  constructor(relays: readonly (string | RelayConfig)[]) {
    this.#relays = normaliseRelayConfig(relays)
    this.#pool = this.#createPool()
    this.#recovery = setInterval(() => this.#recoverSubscriptions(), 5_000)
    ;(this.#recovery as unknown as { unref?: () => void }).unref?.()
  }

  #createPool(): SimplePool {
    const generation = this.#generation
    // Own subscription recovery, including failed first connections and
    // stalled reconnect handshakes. Dependency reconnects can wait forever
    // without a timeout and leave a running agent unable to hear the room.
    const pool = new SimplePool({ enableReconnect: false, enablePing: true })
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
    for (const sub of this.#subscriptions) this.#stop(sub)
    this.#pool.destroy()
    this.#relays = next
    this.#health.clear()
    this.#attempted.clear()
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

  describe(): RelayConfig[] {
    return this.#relays.map(relay => ({ ...relay }))
  }

  subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void): () => void {
    if (this.#closed) throw new Error('pool is closed')
    const sub: Subscription = { filters, onEvent, onEose, seen: new Set(), bindings: new Map(), eosed: new Set(), eoseSent: false }
    this.#subscriptions.add(sub)
    this.#start(sub)
    return () => { this.#subscriptions.delete(sub); this.#stop(sub) }
  }

  #stop(sub: Subscription): void {
    for (const binding of sub.bindings.values()) binding.stop()
    sub.bindings.clear()
  }

  #start(sub: Subscription): void {
    sub.eosed.clear()
    sub.eoseSent = false
    for (const relay of this.#relays) if (relay.read) this.#startRelay(sub, relay.url)
  }

  #startRelay(sub: Subscription, url: string): void {
    sub.bindings.get(url)?.stop()
    const generation = this.#generation
    const binding = { stop: () => {} }
    sub.bindings.set(url, binding)
    if (!this.#pool.listConnectionStatus().get(url)) {
      this.#mark(url, { state: 'connecting' })
      this.#attempted.set(url, Date.now())
    }
    const active = () => !this.#closed && generation === this.#generation && this.#subscriptions.has(sub) && sub.bindings.get(url) === binding
    const handle = this.#pool.subscribeMap(sub.filters.map(filter => ({ url, filter: { ...filter } })), {
      abort: this.#abort.signal,
      maxWait: 8_000,
      oneose: () => {
        if (!active()) return
        sub.eosed.add(url)
        if (!sub.eoseSent && this.#relays.filter(relay => relay.read).every(relay => sub.eosed.has(relay.url))) {
          sub.eoseSent = true
          sub.onEose?.()
        }
      },
      onevent: event => {
        if (!active() || sub.seen.has(event.id)) return
        sub.seen.add(event.id)
        sub.onEvent(event, url)
      },
    })
    binding.stop = () => handle.close()
  }

  #recoverSubscriptions(): void {
    if (this.#closed || this.#subscriptions.size === 0) return
    const connected = this.#pool.listConnectionStatus()
    const now = Date.now()
    for (const relay of this.#relays) {
      if (!relay.read || connected.get(relay.url) || now - (this.#attempted.get(relay.url) ?? 0) < 15_000) continue
      // Keep healthy relays and their consumers running. Replaying the
      // original filters catches missed events; each consumer retains its
      // deduplication set across reconnections, including same-second events.
      this.#pool.close([relay.url])
      this.#attempted.set(relay.url, now)
      for (const sub of this.#subscriptions) this.#startRelay(sub, relay.url)
    }
  }

  close(): void {
    this.#closed = true
    clearInterval(this.#recovery)
    this.#generation++
    this.#abort.abort()
    for (const sub of this.#subscriptions) this.#stop(sub)
    this.#subscriptions.clear()
    this.#pool.destroy()
  }
}
