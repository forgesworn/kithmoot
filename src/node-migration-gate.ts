import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from './verify.js'
import { NostrRelayPool, type NostrRelayPoolOptions, type RelayTransport } from './relay-pool.js'
import type { WebSocketFrame } from './guarded-websocket.js'
const wire = (event: Event): string => JSON.stringify([event.id, event.pubkey, event.created_at, event.kind, event.tags, event.content, event.sig])

/** Both a synchronous application fence and the socket's last write check.
 * Register only prepared encrypted migration control events or the room's
 * own necessary presence, never arbitrary messages from a remote sender. */
export class NodeMigrationPublicationGate {
  #phase: 'open' | 'frozen' | 'retired' = 'open'
  readonly #permits = new Map<string, { wire: string; users: number }>()
  freeze(): void { if (this.#phase !== 'retired') this.#phase = 'frozen' }
  reopen(): void { if (this.#phase === 'retired') throw Error('The source route is retired'); this.#phase = 'open' }
  retire(): void { this.#phase = 'retired'; this.#permits.clear() }
  get phase(): 'open' | 'frozen' | 'retired' { return this.#phase }
  permit(event: Event): () => void {
    if (this.#phase === 'retired' || this.#permits.size >= 512 || !verifyEventUncached(event)) throw Error('Migration publication cannot be permitted')
    const value = wire(event), prior = this.#permits.get(event.id)
    if (prior && prior.wire !== value) throw Error('Migration publication changed')
    const entry = prior ?? { wire: value, users: 0 }; entry.users++
    this.#permits.set(event.id, entry)
    let released = false
    return () => { if (released) return; released = true; if (--entry.users === 0 && this.#permits.get(event.id) === entry) this.#permits.delete(event.id) }
  }
  allowed(event: Event): boolean {
    if (this.#phase === 'open') return true
    return this.#phase === 'frozen' && this.#permits.get(event.id)?.wire === wire(event)
  }
  readonly frameAllowed = (data: WebSocketFrame): boolean => {
    if (this.#phase === 'open') return true
    if (typeof data !== 'string' || data.length > 140_000) return false
    try {
      const frame: unknown = JSON.parse(data)
      if (!Array.isArray(frame)) return false
      if (['REQ', 'CLOSE', 'AUTH'].includes(frame[0])) return this.#phase !== 'retired' || frame[0] === 'CLOSE'
      if (frame[0] !== 'EVENT' || frame.length !== 2 || !frame[1] || typeof frame[1] !== 'object'
        || Object.keys(frame[1]).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags') return false
      return this.allowed(frame[1] as Event)
    } catch { return false }
  }
  wrap(base: RelayTransport): RelayTransport {
    const current = (event: Event): boolean => this.allowed(event)
    return {
      publish: (event, options) => {
        if (!current(event)) return Promise.reject(Error('Room writes are paused for migration'))
        if (options?.allRelays) {
          if (!base.publishGuarded) return Promise.reject(Error('Migration needs acknowledged relay publication'))
          return base.publishGuarded(event, () => current(event), options)
        }
        return base.publish(event)
      },
      ...(base.publishGuarded ? { publishGuarded: (event: Event, allowed: () => boolean, options?: { allRelays?: boolean }) => {
        if (!current(event)) return Promise.reject(Error('Room writes are paused for migration'))
        return base.publishGuarded!(event, () => allowed() && current(event), options)
      } } : {}),
      subscribe: (filters, onEvent, onEose) => base.subscribe(filters, onEvent, onEose),
      close: () => { this.retire(); base.close() },
      ...(base.describe ? { describe: () => base.describe!() } : {}),
      ...(base.setRelays ? { setRelays: entries => base.setRelays!(entries) } : {}),
      ...(base.rekey ? { rekey: key => base.rekey!(key) } : {}),
    }
  }
}

/** Install both halves together. A wrapper alone cannot cancel a publication
 * already queued inside a relay library before the source was frozen. */
export function createMigratableRelayPool(relays: ConstructorParameters<typeof NostrRelayPool>[0],
  circleAtUse?: ConstructorParameters<typeof NostrRelayPool>[1], options: NostrRelayPoolOptions = {}) {
  const gate = new NodeMigrationPublicationGate(), parent = options.frameGuard
  const pool = new NostrRelayPool(relays, circleAtUse, { ...options, frameGuard: data => gate.frameAllowed(data) && (parent?.(data) ?? true) })
  return { pool, gate, transport: gate.wrap(pool) }
}
