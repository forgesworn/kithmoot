import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayTransport } from '../../src/relay-pool.js'

export type AccountNetworkMode = 'private-invitations' | 'nostr'
export const ACCOUNT_NETWORK_KEY = 'kithmoot.account-network.v1'
export const NOSTR_MODE_REQUIRED = 'This feature uses public Nostr relays and exposes account or contact keys. Open Account network and choose Enable Nostr to use it. Local data and pending sync are kept.'
export const PRIVATE_SYNC_PAUSED = 'Private invitations: public account sync is paused. Local rooms and pending changes are kept. Enable Nostr in Account network to sync them.'
const valid = (value: unknown): value is AccountNetworkMode => value === 'private-invitations' || value === 'nostr'

/** Invalid distribution configuration must fail before account restore or I/O. */
export function accountNetworkDefault(value: unknown): AccountNetworkMode {
  if (value === undefined || value === '') return 'nostr'
  if (!valid(value)) throw new Error('VITE_ACCOUNT_NETWORK_DEFAULT must be private-invitations or nostr')
  return value
}

type Store = Pick<Storage, 'getItem' | 'setItem'>
/** Installation policy, unrelated to development previews or the signer. Read
 * synchronously before constructing services. Storage events are only a wakeup;
 * every permission check reads current storage, never event.newValue. */
export class AccountNetwork {
  #holdPrivate = false
  #mode: AccountNetworkMode
  #generation = 0
  #abort = new AbortController()
  #listeners = new Set<() => void>()
  constructor(private store: Store, private distributionDefault: AccountNetworkMode = 'nostr') {
    this.#mode = this.#read()
  }
  #read(): AccountNetworkMode {
    if (this.#holdPrivate) return 'private-invitations'
    try {
      const value = this.store.getItem(ACCOUNT_NETWORK_KEY)
      // Corrupt or inaccessible policy never authorises public account traffic.
      return value === null ? this.distributionDefault : valid(value) ? value : 'private-invitations'
    } catch { return 'private-invitations' }
  }
  refresh(): void {
    const mode = this.#read()
    if (mode === this.#mode) return
    this.#mode = mode; ++this.#generation
    this.#abort.abort(); this.#abort = new AbortController()
    let failure: unknown
    for (const listener of [...this.#listeners]) { try { listener() } catch (error) { failure ??= error } }
    if (failure) throw failure
  }
  get persisted(): boolean { return !this.#holdPrivate }
  get mode(): AccountNetworkMode { this.refresh(); return this.#mode }
  get nostr(): boolean { return this.mode === 'nostr' }
  get generation(): number { this.refresh(); return this.#generation }
  /** Only an explicit UI choice calls this; restore, URLs and features do not. */
  choose(mode: AccountNetworkMode): void {
    if (!valid(mode)) throw new Error('Invalid account network mode')
    // A failed storage write must not leave existing public services running
    // after the person chose private mode. Hold privately until a successful
    // explicit choice; storage wakeups cannot silently undo that local hold.
    if (mode === 'private-invitations') { this.#holdPrivate = true; this.refresh() }
    try { this.store.setItem(ACCOUNT_NETWORK_KEY, mode) }
    catch { throw new Error('Account network choice could not be saved. Private mode remains held in this tab; retry saving before closing it.') }
    this.#holdPrivate = false
    this.refresh()
    if (this.#mode !== mode) throw new Error('Account network choice could not be saved. Try again.')
  }
  listen(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  current(): () => boolean {
    const generation = this.generation
    return () => this.nostr && generation === this.#generation
  }
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.requireNostr()
    const current = this.current()
    if (!current()) throw new Error(NOSTR_MODE_REQUIRED)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, this.#abort.signal]) : this.#abort.signal })
      .then(response => { if (!current()) throw new Error(NOSTR_MODE_REQUIRED); return response })
  }
  requireNostr(): void { if (!this.nostr) throw new Error(NOSTR_MODE_REQUIRED) }

  /** App composition boundary, before allocating a PUBLIC transport. All
   * writes use the carrier's socket/retry guard. Closing and generations stop
   * retained handles, callbacks, queued writes and reconnects across transitions.
   * Private Link/Bothy transports never pass through this method. */
  publicTransport<T extends RelayTransport>(make: () => T): T {
    this.requireNostr()
    const current = this.current()
    if (!current()) throw new Error(NOSTR_MODE_REQUIRED)
    const transport = make()
    if (!current()) { transport.close(); throw new Error(NOSTR_MODE_REQUIRED) }
    let closed = false
    const live = () => !closed && current()
    const requireLive = () => { if (!live()) throw new Error(NOSTR_MODE_REQUIRED) }
    const close = () => { if (closed) return; closed = true; off(); transport.close() }
    const off = this.listen(() => { if (!current()) close() })
    return new Proxy(transport, {
      get(target, property) {
        if (property === 'close') return close
        if (property === 'closed') return closed || Reflect.get(target, property, target) === true
        if (property === 'publish' || property === 'publishGuarded') return async (event: Event, allowed: () => boolean = () => true) => {
          requireLive()
          if (!target.publishGuarded) throw new Error('A guarded public Nostr transport is required.')
          await target.publishGuarded(event, () => live() && allowed())
          requireLive()
        }
        if (property === 'subscribe') return (filters: Filter[], receive: (event: Event, via?: string) => void, eose?: () => void) => {
          requireLive()
          return target.subscribe(filters, (event, via) => { if (live()) receive(event, via) }, () => { if (live()) eose?.() })
        }
        const value: unknown = Reflect.get(target, property, target)
        if (property === 'health' || property === 'configuration' || property === 'describe' || property === 'settled') return typeof value === 'function' ? value.bind(target) : value
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          requireLive()
          const result: unknown = value.apply(target, args)
          return result instanceof Promise ? result.then(answer => { requireLive(); return answer }) : result
        }
      },
    })
  }
}

/** Local journal placeholder: failure is never presented as a relay success. */
export const pausedAccountTransport: RelayTransport = {
  publish: async () => { throw new Error(PRIVATE_SYNC_PAUSED) },
  subscribe: () => { throw new Error(PRIVATE_SYNC_PAUSED) },
  close: () => {},
}
