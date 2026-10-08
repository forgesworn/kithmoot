import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { NostrRelayPool, RelayConfig, RelayHealth, RelayTransport } from '../../src/relay-pool.js'
import type { BrowserRoomBarrier } from './browser-room-barrier.js'
import type { BrowserRoomConsents, RoomConsent } from './browser-room-consent.js'

/** The public surface used by app callers, without the pool's private fields. */
export type ManagedRelayPool = Pick<NostrRelayPool, keyof NostrRelayPool>
type Read = { filters: Filter[]; receive: (e: Event, via?: string) => void; eose?: () => void; stop?: () => void }
type Options = {
  room: string
  account: () => string | undefined
  store: Pick<BrowserRoomConsents, 'all'>
  barrier: Pick<BrowserRoomBarrier, 'publicLease' | 'listen'>
  publicPool: () => ManagedRelayPool
  privatePool: (consent: RoomConsent) => Promise<RelayTransport>
  /** Stop room media and other operations before releasing the public lease. */
  beforePrivate?: () => Promise<void>
  now?: () => number
}

/** Stable caller handle across route changes. Creating the public delegate
 * is asynchronous and happens only under a lifetime shared lease, after a
 * fresh durable-policy read. Every async completion checks its generation.
 * This is deliberately not a URL rewrite: none of the public pool's fixed
 * relays, reconnection paths or probing survives private selection. */
export class BrowserRoomPool implements ManagedRelayPool {
  #delegate?: RelayTransport
  #public?: ManagedRelayPool
  #release?: () => Promise<void>
  #opening?: Promise<void>
  #closing: Promise<void> = Promise.resolve()
  #closed = false
  #generation = 0
  #reads = new Set<Read>()
  #writes = new Set<Promise<void>>()
  #unlisten: () => void
  #consent?: RoomConsent
  #error?: string
  #expiry?: ReturnType<typeof setTimeout>
  constructor(private opts: Options) {
    this.#unlisten = opts.barrier.listen(() => { void this.#refresh() })
    void this.#open().catch(() => {})
  }
  get closed(): boolean { return this.#closed }
  get publishing(): boolean { return this.#writes.size > 0 }
  #now(): number { return this.opts.now?.() ?? Math.floor(Date.now() / 1000) }
  async #refresh(): Promise<void> {
    if (this.#closed) return
    // Invalidate immediately, before opening encrypted storage or awaiting
    // session shutdown. Late callbacks from old delegates do nothing.
    this.#invalidate()
    try { await this.#open() } catch { /* Held until an explicit retry/change. */ }
  }
  #invalidate(): void {
    ++this.#generation
    clearTimeout(this.#expiry)
    for (const r of this.#reads) { r.stop?.(); r.stop = undefined }
    const delegate = this.#delegate, release = this.#release, wasPublic = !!this.#public
    this.#delegate = undefined; this.#public = undefined; this.#release = undefined; this.#opening = undefined
    delegate?.close()
    this.#closing = this.#closing.then(async () => {
      // close() invalidates sockets synchronously in NostrRelayPool; no
      // signed publication or reconnect may escape after releasing lease.
      try { if (wasPublic && !this.#closed) await this.opts.beforePrivate?.() }
      finally { await release?.() }
    })
  }
  #open(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Room connection is closed.'))
    if (this.#delegate) return Promise.resolve()
    if (this.#opening) return this.#opening
    const generation = this.#generation
    const current = () => !this.#closed && generation === this.#generation
    const opening = (async () => {
      await this.#closing
      if (!current()) throw new Error('Room route changed.')
      let release: (() => Promise<void>) | undefined = await this.opts.barrier.publicLease(this.opts.room)
      try {
        const entries = await this.opts.store.all()
        if (!current()) throw new Error('Room route changed.')
        // Another account never turns a saved private selection back into
        // public traffic. It must explicitly withdraw with the owner first.
        const selected = entries.filter(c => (c.room === this.opts.room || c.aliases.includes(`lookup:${this.opts.room}`)) && c.phase !== 'retired')
        if (selected.length > 1) throw new Error('Conflicting Bothy room permissions require recovery.')
        this.#consent = selected[0]
        let delegate: RelayTransport
        if (this.#consent) {
          await release(); release = undefined
          if (!current()) throw new Error('Room route changed.')
          if (this.#consent.account !== this.opts.account()) throw new Error('This room’s Bothy route belongs to another account.')
          if (this.#consent.phase !== 'active') throw new Error('This room is held while its Bothy permission change finishes.')
          if (this.#consent.expires <= this.#now()) throw new Error('This room’s Bothy permission has expired.')
          delegate = await this.opts.privatePool(this.#consent)
          if (!current()) { delegate.close(); throw new Error('Room route changed.') }
          this.#expiry = setTimeout(() => { void this.#refresh() }, Math.min(2_147_483_647, Math.max(1, (this.#consent.expires - this.#now()) * 1000)))
        } else {
          this.#public = this.opts.publicPool()
          delegate = this.#public
          this.#release = release; release = undefined
        }
        this.#delegate = delegate; this.#error = undefined
        for (const r of this.#reads) this.#bind(r, generation)
      } finally { await release?.() }
    })().catch(error => { if (current()) this.#error = error instanceof Error ? error.message : 'Room route unavailable.'; throw error })
    this.#opening = opening
    void opening.finally(() => { if (this.#opening === opening) this.#opening = undefined }).catch(() => {})
    return opening
  }
  #bind(read: Read, generation: number): void {
    const current = () => !this.#closed && generation === this.#generation && this.#reads.has(read)
    read.stop = this.#delegate!.subscribe(read.filters, (e, via) => { if (current()) read.receive(e, via) }, () => { if (current()) read.eose?.() })
  }
  subscribe(filters: Filter[], receive: Read['receive'], eose?: () => void): () => void {
    if (this.#closed || this.#reads.size >= 128) throw new Error('Room subscription unavailable.')
    const read: Read = { filters: structuredClone(filters), receive, eose }
    this.#reads.add(read)
    if (this.#delegate) this.#bind(read, this.#generation)
    else void this.#open().catch(() => {})
    return () => { this.#reads.delete(read); read.stop?.() }
  }
  async publish(event: Event): Promise<void> {
    const generation = this.#generation
    await this.#open()
    if (generation !== this.#generation || this.#closed || !this.#delegate) throw new Error('Room route changed before publication. Retry from the current room.')
    if (this.#consent && (this.#consent.account !== this.opts.account() || this.#consent.expires <= this.#now())) throw new Error('Bothy room permission is unavailable.')
    const write = this.#delegate.publish(event)
    this.#writes.add(write)
    try { await write } finally { this.#writes.delete(write) }
  }
  async settled(timeoutMs = 20_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...this.#writes]), new Promise<void>(r => { timer = setTimeout(r, timeoutMs) })]); await this.#public?.settled(timeoutMs) }
    finally { clearTimeout(timer) }
  }
  configuration(): RelayConfig[] { return this.describe() }
  describe(): RelayConfig[] { return this.#delegate?.describe?.() ?? [] }
  health(): RelayHealth[] {
    if (this.#public) return this.#public.health()
    const observable = this.#delegate as (RelayTransport & { health?: () => RelayHealth[] }) | undefined
    return observable?.health?.() ?? (this.#consent ? [{ url: this.#consent.box.eventUrl, read: true, write: true, circle: true, state: 'disconnected', lastError: this.#error }] : [])
  }
  setRelays(entries: readonly (string | RelayConfig)[]): void { this.#public?.setRelays(entries) }
  setAuthentication(entries: Parameters<NostrRelayPool['setAuthentication']>[0]): void { this.#public?.setAuthentication(entries) }
  reconnect(): void { if (this.#public) this.#public.reconnect(); else void this.#refresh() }
  async probe(timeoutMs?: number): Promise<void> { await this.#public?.probe(timeoutMs) }
  async query(url: string, filters: Filter[], timeoutMs = 8_000): Promise<{ events: Event[]; complete: boolean }> {
    await this.#open()
    if (this.#public) return this.#public.query(url, filters, timeoutMs)
    if (url !== this.#consent?.box.eventUrl) throw new Error('Public history is unavailable for this Bothy room.')
    return new Promise(resolve => {
      const events: Event[] = []; let stop: (() => void) | undefined, finished = false
      const done = (complete: boolean) => { finished = true; clearTimeout(timer); stop?.(); resolve({ events, complete }) }
      const timer = setTimeout(() => done(false), timeoutMs)
      stop = this.subscribe(filters, e => { if (events.length < 4096) events.push(e) }, () => done(true))
      if (finished) stop()
    })
  }
  async publishQuietly(url: string, event: Event): Promise<void> {
    await this.#open()
    if (this.#public) return this.#public.publishQuietly(url, event)
    if (url !== this.#consent?.box.eventUrl) throw new Error('Public publication is unavailable for this Bothy room.')
    await this.publish(event)
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#unlisten(); this.#invalidate(); this.#reads.clear() }
}
