import { randomBytes, bytesToHex } from '@noble/hashes/utils'
import { createSignetContactsClient, emptyContactsState, parsePairingAckV2, pairingFromAck, parseProjection,
  type Capability, type ContactsSigner, type ContactsState, type PairingV2, type RelayIo, type SignedNostrEvent, type NostrFilterLike } from '@forgesworn/signet-contacts'
import { verifyEventUncached } from '../../src/verify.js'
import { grantedContactsView, type GrantedContactsView } from './granted-contacts.js'
import type { DeviceStore } from './device-store.js'

export const BASIC_CONTACT_SCOPES: Capability[] = ['signet.contacts.read:directory', 'signet.contacts.blocks.read']
const OPTIONAL_CONTACT_SCOPES: Capability[] = ['signet.contacts.read:tier', 'signet.contacts.read:checks', 'signet.contacts.read:check-records']
const HEX = /^[0-9a-f]{64}$/
interface Options {
  signer: ContactsSigner; relay: RelayIo; store: DeviceStore
  current(): boolean; changed(view: GrantedContactsView): void
  now?(): number; lock?<T>(task: () => Promise<T>): Promise<T>
}
/** Durable account-bound consumer. Each refresh reloads under the same Web Lock
 * before applying relay data, preventing two tabs from lowering each other's
 * replay floor. No SDK background subscription may bypass that transaction. */
export class GrantedContactsClient {
  readonly #options: Options
  readonly #prefix: string
  readonly #now: () => number
  #pairing: PairingV2 | null = null
  #state: ContactsState = emptyContactsState()
  #healthy = true
  #stopped = false
  #started = false
  #generation = 0
  #pairAbort: AbortController | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #expiryTimer: ReturnType<typeof setTimeout> | undefined
  constructor(options: Options) {
    if (!HEX.test(options.signer.pubkey)) throw new Error('Invalid contacts account')
    this.#options = options; this.#prefix = `kithmoot.contacts.v2.${options.signer.pubkey}.`
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }
  #current(): void { if (this.#stopped || !this.#options.current()) throw new Error('Contacts account changed') }
  #emit(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer)
    if (this.#stopped || !this.#options.current()) return
    const view = this.view()
    this.#options.changed(view)
    // A manual refresh may shorten expiry while the polling timer is still
    // waiting. Hide expired data independently of that network schedule.
    if (this.#started && view.status === 'ready' && this.#state.projection) {
      this.#expiryTimer = setTimeout(() => this.#emit(), Math.max(1, (this.#state.projection.expiresAt - this.#now()) * 1000))
    }
  }
  view(): GrantedContactsView {
    if (!this.#healthy && !this.#stopped && this.#options.current()) return { status: 'unavailable', contacts: [], blocked: new Set(this.#state.blockedPubkeys), truncated: false }
    return grantedContactsView({ account: !this.#stopped && this.#options.current() ? this.#options.signer.pubkey : undefined,
      binding: this.#pairing ? { account: this.#options.signer.pubkey, pairing: this.#pairing } : null,
      state: this.#state, now: this.#now(), storageHealthy: this.#healthy })
  }
  #readPairing(): PairingV2 | null {
    const raw = this.#options.store.get(this.#prefix + 'pairing')
    if (raw === null) return null
    if (raw.length > 8192) throw new Error('Invalid saved contacts pairing')
    const stored = JSON.parse(raw) as PairingV2
    const ack = parsePairingAckV2(JSON.stringify({ ...stored, v: 2, challenge: 'stored' }), 'stored')
    if (!ack || !Number.isSafeInteger(stored.pairedAt) || stored.pairedAt < 0
      || JSON.stringify(ack.grantedCapabilities) !== JSON.stringify(stored.grantedCapabilities)
      || ack.maxStalenessSeconds !== stored.maxStalenessSeconds) throw new Error('Invalid saved contacts pairing')
    return pairingFromAck(ack, stored.pairedAt)
  }
  #write(key: string, value: string): void {
    this.#current()
    try {
      this.#options.store.set(this.#prefix + key, value)
      if (this.#options.store.get(this.#prefix + key) !== value) throw new Error('Could not save contacts')
    } catch (error) { this.#healthy = false; throw error }
  }
  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => { this.#current(); return task() }
    if (this.#options.lock) return this.#options.lock(run)
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate contacts across tabs')
    return navigator.locks.request(this.#prefix, { mode: 'exclusive' }, run)
  }
  #client(pairing?: PairingV2, generation?: number) {
    const current = () => { this.#current(); if (generation !== undefined && generation !== this.#generation) throw new Error('Pairing cancelled') }, signer = this.#options.signer, relay = this.#options.relay
    const valid = (event: SignedNostrEvent | null, filter: NostrFilterLike): event is SignedNostrEvent => {
      if (!event || !verifyEventUncached(event)) return false
      if (filter.kinds && !filter.kinds.includes(event.kind)) return false
      if (filter.authors && !filter.authors.includes(event.pubkey)) return false
      return Object.entries(filter).every(([key, values]) => !key.startsWith('#') || (Array.isArray(values)
        && event.tags.some(tag => tag[0] === key.slice(1) && values.includes(tag[1]))))
    }
    const io: RelayIo = {
      fetchNewest: async (filter, relays, author) => {
        current(); const event = await relay.fetchNewest(filter, relays, author); current()
        return valid(event, filter) ? event : null
      },
      publish: async (event, relays) => { current(); return relay.publish(event, relays) },
      // Only pairing has a live listener. Projection refreshes must stay inside
      // the read/reload/write lock rather than the SDK's background subscriber.
      ...(generation !== undefined && relay.subscribe ? { subscribe: (filter: NostrFilterLike, relays: string[], onEvent: (event: SignedNostrEvent) => void) => {
        current()
        return relay.subscribe!(filter, relays, event => {
          try { current(); if (valid(event, filter)) onEvent(event) } catch { /* Pairing ended. */ }
        })
      } } : {}),
      ...(relay.fetchMany ? { fetchMany: async (filter: NostrFilterLike, relays: string[], author?: string) => {
        current(); const events = await relay.fetchMany!(filter, relays, author); current()
        return events.filter(event => valid(event, filter))
      } } : {}),
    }
    return createSignetContactsClient({ now: this.#now, relay: io,
      signer: { pubkey: signer.pubkey,
        nip44Encrypt: async (peer, text) => { current(); const result = await signer.nip44Encrypt(peer, text); current(); return result },
        nip44Decrypt: async (peer, text) => { current(); const result = await signer.nip44Decrypt(peer, text); current(); return result },
        signEvent: async event => { current(); const result = await signer.signEvent(event); current(); return result } },
      storage: {
        get: async key => {
          current()
          try {
            const raw = this.#options.store.get(this.#prefix + key)
            if (raw && key.startsWith('signet-contacts:state:')) {
              if (raw.length > 4 * 1024 * 1024) throw new Error('Contact cache too large')
              const value = JSON.parse(raw) as ContactsState
              const projection = value.projection === null ? null : parseProjection(JSON.stringify(value.projection))
              if (!pairing || value.grantId !== pairing.grantId || !Array.isArray(value.blockedPubkeys)
                || value.blockedPubkeys.some(pubkey => !HEX.test(pubkey)) || typeof value.revoked !== 'boolean'
                || (value.projection !== null && (!projection || projection.grantId !== pairing.grantId))) throw new Error('Contact cache is corrupt')
            }
            return raw
          } catch (error) { this.#healthy = false; throw error }
        },
        set: async (key, value) => { this.#write(key, value) },
      },
    })
  }
  async refresh(): Promise<void> {
    this.#emit() // Expiry applies before waiting for a slow/offline relay.
    try {
      await this.#locked(async () => {
        this.#healthy = true; this.#pairing = this.#readPairing()
        if (!this.#pairing) { this.#state = emptyContactsState(); return }
        const client = this.#client(this.#pairing)
        await client.load(this.#pairing.grantId)
        if (!this.#healthy) throw new Error('Saved contacts need attention')
        await client.fetchProjection(this.#pairing)
        this.#current()
        if (!this.#healthy) throw new Error('Contacts could not be saved')
        this.#state = client.getState()
      })
    } catch { this.#healthy = false }
    this.#emit()
  }
  /** Explicit pairing only. Caller shows this URI and starts wait() while it is
   * visible; cancel() prevents a late ack from changing the saved grant. */
  beginPairing(relay: string, extras: Capability[] = []): { uri: string; wait(): Promise<boolean>; cancel(): void } {
    this.#current()
    if (extras.some(scope => !OPTIONAL_CONTACT_SCOPES.includes(scope))) throw new Error('Unsupported contact permission')
    this.#pairAbort?.abort()
    const abort = new AbortController(); this.#pairAbort = abort
    const generation = ++this.#generation, challenge = bytesToHex(randomBytes(16))
    const scopes = [...new Set([...BASIC_CONTACT_SCOPES, ...extras])]
    const client = this.#client(undefined, generation)
    const uri = client.buildPairingUri({ appName: 'KithMoot', directory: 'owner', relay, capabilities: scopes, challenge, nowSec: this.#now() })
    let waited = false
    return { uri, cancel: () => { abort.abort(); if (this.#generation === generation) this.#generation++ }, wait: async () => {
      if (waited) throw new Error('This pairing is already waiting')
      waited = true
      const pairing = await client.awaitPairingAck({ challenge, relays: [relay], requestedCapabilities: scopes, timeoutMs: 120000, signal: abort.signal })
      this.#current()
      if (!pairing || this.#generation !== generation) return false
      if (BASIC_CONTACT_SCOPES.some(scope => !pairing.grantedCapabilities.includes(scope))) throw new Error('Names, keys and blocks are required to use these contacts')
      await this.#locked(async () => {
        if (this.#generation !== generation) return
        this.#write('pairing', JSON.stringify(pairing)); this.#pairing = pairing
      })
      if (this.#generation !== generation) return false
      await this.refresh(); return true
    } }
  }
  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    const run = async () => {
      if (this.#stopped || !this.#options.current()) return
      await this.refresh()
      if (!this.#stopped && this.#options.current()) {
        const untilExpiry = (this.#state.projection?.expiresAt ?? 0) - this.#now()
        this.#timer = setTimeout(() => { void run() }, untilExpiry > 0 ? Math.min(30000, untilExpiry * 1000) : 30000)
      }
    }
    void run()
  }
  stop(): void {
    this.#stopped = true; this.#generation++; this.#pairAbort?.abort()
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer)
    this.#state = emptyContactsState(); this.#pairing = null
  }
}
