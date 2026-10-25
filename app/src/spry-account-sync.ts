import type { SignetSigner } from 'signet-login'
import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { SpryPairing } from '../../src/spry.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { DeviceStore } from './device-store.js'
import { parseAccountSpryPairing } from './spry-pairing.js'

// No endpoint, pairing id or credential appears in public tags. The payload
// is NIP-44 encrypted to the account itself, as private room bookmarks are.
export const SPRY_ACCOUNT_ADDRESS = 'kithmoot.connections.v1'
const KIND = 30078
const tags = () => [['d', SPRY_ACCOUNT_ADDRESS], ['l', 'kithmoot.private-settings.v1']]
const newer = (a: Event, b?: Event) => !b || a.created_at > b.created_at || a.created_at === b.created_at && a.id < b.id

export class SpryAccountSync {
  #closed = false
  #off?: () => void
  #latest?: Event
  #pending?: Event
  #pendingValue?: { v: number; at: number; pairing: SpryPairing | null }
  #removalAt?: number
  #seen = new Set<string>()
  #receiving?: Promise<void>
  #incoming?: Event
  #writes = Promise.resolve()
  #key: string
  #identity: string
  #retrying?: Promise<boolean>
  constructor(private store: DeviceStore, private signer: SignetSigner, private relay: RelayTransport,
    private adopt: (pair: SpryPairing | null) => void, private status: (message: string) => void,
    private current: () => boolean, private now = () => Math.floor(Date.now() / 1000)) {
    this.#identity = signer.pubkey
    this.#key = `kithmoot.spry-sync.${this.#identity}`
  }
  #live(): boolean { return !this.#closed && this.current() && this.signer.pubkey === this.#identity }
  #valid(event: Event): boolean {
    return event?.kind === KIND && event.pubkey === this.#identity &&
      Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= this.now() + 60 &&
      typeof event.content === 'string' && event.content.length <= 16000 &&
      JSON.stringify(event.tags) === JSON.stringify(tags()) && verifyEventUncached(event)
  }
  #persist(): void {
    this.store.set(this.#key, JSON.stringify({ latest: this.#latest, pending: this.#pending, removalAt: this.#removalAt }))
  }
  start(): void {
    if (!this.signer.nip44 || !this.#live()) return
    this.#seen.clear()
    this.#off?.()
    try {
      const text = this.store.get(this.#key)
      if (text && text.length <= 40000) {
        const saved = JSON.parse(text) as { latest?: Event; pending?: Event; removalAt?: number }
        if (Number.isSafeInteger(saved.removalAt) && saved.removalAt! >= 0 && saved.removalAt! <= this.now() + 60) this.#removalAt = saved.removalAt
        if (saved.pending && this.#valid(saved.pending)) this.#pending = saved.pending
        if (saved.latest && this.#valid(saved.latest)) void this.receive(saved.latest)
      }
      if (this.#pending || this.#removalAt !== undefined) void this.retry()
    } catch { this.status('Spry account sync could not be restored. Your local pairing is kept.') }
    try {
      this.#off = this.relay.subscribe([{ kinds: [KIND], authors: [this.#identity], '#d': [SPRY_ACCOUNT_ADDRESS] }], event => { void this.receive(event) }, () => { void this.retry() })
    } catch { this.status('Spry account lookup could not start. Your local pairing is kept; choose Sync Spry to retry.') }
  }
  receive(event: Event): Promise<void> {
    if (!this.#live() || !this.#valid(event) || this.#seen.has(event.id) || !newer(event, this.#latest)) return Promise.resolve()
    if (this.#seen.size >= 64) this.#seen.delete(this.#seen.values().next().value!)
    this.#seen.add(event.id)
    // One decryption and only the newest queued candidate: replayed history
    // cannot create an unbounded signer queue or hide the current record.
    if (!this.#incoming || newer(event, this.#incoming)) this.#incoming = event
    if (this.#receiving) return this.#receiving
    this.#receiving = (async () => {
      while (this.#incoming && this.#live()) {
        const next = this.#incoming
        this.#incoming = undefined
        await this.#apply(next)
      }
    })().finally(() => { this.#receiving = undefined })
    return this.#receiving
  }
  async #apply(event: Event): Promise<void> {
      if (!this.#live() || !newer(event, this.#latest) || this.#pending && event.id !== this.#pending.id && !newer(event, this.#pending)) return
      if (this.#removalAt !== undefined && (event.created_at < this.#removalAt || event.created_at === this.#removalAt && event.id !== this.#pending?.id)) return
      try {
        const plaintext = this.#pending?.id === event.id && this.#pendingValue ? JSON.stringify(this.#pendingValue)
          : await this.signer.nip44!.decrypt(this.signer.pubkey, event.content)
        if (!this.#live() || plaintext.length > 8192 || !newer(event, this.#latest)) return
        if (this.#pending && event.id !== this.#pending.id && !newer(event, this.#pending)) return
        const value = JSON.parse(plaintext)
        if (value.v !== 1 || value.at !== event.created_at || !Object.hasOwn(value, 'pairing')) return
        const pair = value.pairing === null ? null : parseAccountSpryPairing(value.pairing)
        this.adopt(pair)
        this.#latest = event
        if (this.#pending && (this.#pending.id === event.id || newer(event, this.#pending))) { this.#pending = undefined; this.#pendingValue = undefined }
        if (this.#removalAt !== undefined && event.created_at >= this.#removalAt) this.#removalAt = undefined
        this.#persist()
        this.status(pair ? 'Spry loaded from your encrypted Nostr account. Call access is shared automatically.' : 'Spry was unpaired for your Nostr account.')
      } catch { if (this.#live()) this.status('Spry account data could not be opened. Your local pairing is kept.') }
  }
  save(pair: SpryPairing | null, retainedRemovalAt?: number): Promise<boolean> {
    let result = false
    const work = this.#writes.then(async () => {
      if (!this.#live() || !this.signer.nip44) return
      if (retainedRemovalAt !== undefined && this.#removalAt !== retainedRemovalAt) return
      try {
        const normalized = pair ? parseAccountSpryPairing(pair) : null
        const at = retainedRemovalAt ?? Math.max(this.now(), (this.#latest?.created_at ?? -1) + 1, (this.#pending?.created_at ?? -1) + 1)
        if (at > this.now() + 60) throw new Error('Too many changes')
        this.#removalAt = pair === null ? at : undefined
        this.#pending = undefined; this.#pendingValue = undefined
        this.#persist()
        const value = { v: 1, at, pairing: normalized }
        const content = await this.signer.nip44.encrypt(this.signer.pubkey, JSON.stringify(value))
        if (!this.#live()) return
        const template = { kind: KIND, created_at: at, tags: tags(), content }
        const event = await this.signer.signEvent(template)
        if (!this.#live()) return
        if (!this.#valid(event) || event.created_at !== at || event.content !== content) throw new Error('Signer returned another event')
        this.#pending = event
        this.#pendingValue = value
        this.#persist()
        result = await this.retry()
      } catch { if (this.#live()) this.status('Spry account sync needs your signer and relays; choose Sync Spry to retry.') }
    })
    this.#writes = work.catch(() => {})
    return work.then(() => result)
  }
  retry(): Promise<boolean> {
    if (this.#retrying) return this.#retrying
    if (!this.#pending && this.#removalAt !== undefined) return this.save(null, this.#removalAt)
    const run = async () => {
      let event = this.#pending ?? this.#latest
      if (!event || !this.#live()) return !event
      try {
        do {
        await this.relay.publish(event)
        if (!this.#live()) return false
        if (this.#pending?.id === event.id) {
          await this.#apply(event)
          if (this.#pending?.id === event.id) return false
        }
        event = this.#pending
        } while (event && this.#live())
        this.status('Spry settings accepted by your account relays, encrypted to your Nostr key. Your other signed-in devices can load them.')
        return true
      } catch { if (this.#live()) this.status('Spry account sync is waiting for your relays. Choose Sync Spry to retry.'); return false }
    }
    this.#retrying = run().finally(() => { this.#retrying = undefined })
    return this.#retrying
  }
  close(): void { this.#closed = true; this.#off?.(); this.#off = undefined }
}
