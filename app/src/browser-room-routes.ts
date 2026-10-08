import type { ParticipantIdentity } from '../../src/identity.js'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayTransport } from '../../src/relay-pool.js'
import { BrowserRoomConsents, ROOM_READ_KINDS, ROOM_WRITE_KINDS, type RoomConsent } from './browser-room-consent.js'
import { BrowserRoomBarrier } from './browser-room-barrier.js'
import { BrowserRoomPool, type ManagedRelayPool } from './browser-room-pool.js'
import { BrowserLinkRelay } from './browser-link-relay.js'
import type { BrowserLink } from './browser-link.js'
import { guardPublicRoomOperations, PUBLIC_ROOM_OPERATIONS } from './public-room-operation.js'

export class BrowserRoomRoutes {
  readonly store = new BrowserRoomConsents()
  readonly barrier = new BrowserRoomBarrier()
  #pools = new Set<BrowserRoomPool>()
  #enabled = true
  constructor(private identity: () => ParticipantIdentity | undefined, private link: BrowserLink,
    private closePublicSession: (room: string) => Promise<void>) {
    guardPublicRoomOperations(async stop => {
      let invalidated = false
      const unlisten = this.barrier.listen(() => { invalidated = true; stop() })
      const release = await this.barrier.publicLease(PUBLIC_ROOM_OPERATIONS)
      try {
        if (invalidated || (await this.store.all()).some(c => c.phase !== 'retired')) throw new Error('Public history recovery and cleanup are held while Bothy room permissions are selected. Withdraw the room selection first.')
        return async () => { unlisten(); await release() }
      } catch (error) { unlisten(); await release(); throw error }
    })
  }
  async selected(room: string): Promise<RoomConsent | undefined> {
    return (await this.store.all()).find(c => c.room === room && c.phase !== 'retired')
  }
  pool(room: string, publicPool: () => ManagedRelayPool): ManagedRelayPool {
    const pool = new BrowserRoomPool({ room, account: () => this.identity()?.pubkey, store: this.store, barrier: this.barrier, publicPool,
      beforePrivate: async () => {
        const consent = (await this.store.all()).find(c => (c.room === room || c.aliases.includes(`lookup:${room}`)) && c.phase !== 'retired')
        if (consent) await this.closePublicSession(consent.room)
      },
      privatePool: async consent => {
        const identity = this.identity()
        if (!this.#enabled || !identity || identity.pubkey !== consent.account) throw new Error('Sign in as the account that selected this room’s Bothy.')
        // Background watches cannot seize endpoint ownership from the tab
        // the person is reopening. Other tabs hold without public fallback.
        if (!this.link.boxes().some(b => b.routeId === consent.box.routeId && b.eventUrl === consent.box.eventUrl)) throw new Error('Open this room or connect Bothy to resume its saved route.')
        return new TextRoomRelay(this.link, consent, identity)
      },
    })
    this.#pools.add(pool)
    for (const p of this.#pools) if (p.closed) this.#pools.delete(p)
    return pool
  }
  changed(): void { this.barrier.changed() }
  pause(): void { this.#enabled = false; this.changed() }
  resume(): void { this.#enabled = true; this.changed() }
}

/** Text, roster and rekey reads only. Unsupported media/invitation channels
 * remain silent; unsupported writes fail explicitly. No broader filter or
 * public delegate is ever created. Every granted stream has an exact scope. */
export class TextRoomRelay implements RelayTransport {
  #scopes = new Map<string, BrowserLinkRelay>()
  constructor(link: BrowserLink, private consent: RoomConsent, identity: ParticipantIdentity) {
    for (const room of consent.scopes) this.#scopes.set(room, new BrowserLinkRelay(link, consent.box, identity, { room, kinds: [...ROOM_READ_KINDS] }))
  }
  describe() { return [{ url: this.consent.box.eventUrl, read: true, write: true, circle: true }] }
  health() {
    const states = [...this.#scopes.values()].map(p => p.health()[0])
    return [{ ...this.describe()[0], state: states.some(p => p.state === 'connected') ? 'connected' as const : 'disconnected' as const, lastError: states.find(p => p.lastError)?.lastError }]
  }
  async publish(event: Event): Promise<void> {
    const d = event.tags.filter(t => t[0] === 'd')
    if (d.length !== 1 || d[0].length !== 2 || !(ROOM_WRITE_KINDS as readonly number[]).includes(event.kind)) throw new Error('This Bothy route supports text and presence only.')
    const pool = this.#scopes.get(d[0][1])
    if (!pool) throw new Error('This channel or epoch is not granted on Bothy. Room traffic stays held.')
    await pool.publish(event)
  }
  subscribe(filters: Filter[], receive: (e: Event, via?: string) => void, eose?: () => void): () => void {
    const requests: { pool: BrowserLinkRelay; filter: Filter }[] = []
    for (const filter of filters) for (const d of filter['#d'] ?? []) {
      const pool = this.#scopes.get(d)
      const kinds = filter.kinds?.filter(k => (ROOM_READ_KINDS as readonly number[]).includes(k))
      if (pool && kinds?.length) requests.push({ pool, filter: { ...filter, kinds, '#d': [d] } })
    }
    const complete = filters.length > 0 && filters.every(f => !!f.kinds?.length && f.kinds.every(k => (ROOM_READ_KINDS as readonly number[]).includes(k)) && !!f['#d']?.length && f['#d'].every(d => this.#scopes.has(d)))
    const finished = new Set<number>()
    const stops = requests.map(({ pool, filter }, i) => pool.subscribe([filter], receive, () => {
      finished.add(i)
      // Never turn a dropped/unsupported filter into a complete history.
      if (finished.size === requests.length && complete) eose?.()
    }))
    return () => stops.forEach(stop => stop())
  }
  close(): void { for (const pool of this.#scopes.values()) pool.close() }
}
