import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { DeviceStore } from './device-store.js'
import { OrdinaryMessageHistory, ordinaryHistoryKey, type OrdinaryHistoryLock } from './nostr-message-history.js'
import { captureOrdinaryCopy, captureOrdinarySeal, captureOrdinaryText, ordinaryExpired,
  ORDINARY_MAX_COPIES, ORDINARY_MAX_WIRE_BYTES, type OrdinaryText } from './nostr-message-wire.js'

type ReceiveTransport = Pick<RelayTransport, 'subscribe' | 'close'>
export interface OrdinaryMessageRow {
  copy: string; status: 'sealed' | 'opening' | 'opened' | 'unavailable' | 'refused'; message?: OrdinaryText
}
interface Entry { event: Event; status: OrdinaryMessageRow['status']; message?: OrdinaryText }
interface Options {
  account: string; store: DeviceStore; acquire: OrdinaryHistoryLock
  receive(current: () => boolean): Promise<ReceiveTransport>
  decrypt?: (peer: string, ciphertext: string, current: () => boolean) => Promise<string>
  current(): boolean; blocked(peer: string): boolean; changed(): void; failed?(): void; now?(): number
}

/** An explicit ordinary-text inbox. Original signed ciphertext is retained;
 * plaintext exists only in this view. This grants no room/member authority. */
export class NostrMessageInbox {
  #entries = new Map<string, Entry>()
  #history?: OrdinaryMessageHistory
  #release?: () => void
  #transport?: ReceiveTransport
  #off?: () => void
  #timer?: ReturnType<typeof setTimeout>
  #expirationTimer?: ReturnType<typeof setTimeout>
  #started = false
  #closed = false
  #ready = false
  #loading = false
  #reading = false
  #opening = false
  #candidates = 0
  #accepted = 0
  #limited = false
  #status = ''
  constructor(private readonly options: Options) {}
  #now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000) }
  #current = (): boolean => {
    if (this.#closed) return false
    let current = false
    try { current = this.options.current() } catch { /* Missing lifetime refuses use. */ }
    if (!current) this.close()
    return current && !this.#closed
  }
  #blocked(peer: string): boolean { try { return this.options.blocked(peer) } catch { return true } }
  #allowed(message: OrdinaryText): boolean {
    return message.members.every(peer => peer === this.options.account || !this.#blocked(peer))
  }
  #notify(): void {
    if (!this.#current()) return
    try { this.options.changed() }
    catch {
      // A failed view cannot keep plaintext, the writer hold or a relay alive.
      // Do not call changed again, or report a rendering error as cache damage.
      this.close()
      try { this.options.failed?.() } catch { /* Lifetime is already revoked. */ }
      return
    }
    clearTimeout(this.#expirationTimer)
    if (this.#current()) {
      const expirations = [...this.#entries.values()].flatMap(entry => [entry.message?.expiresAt,
        ...entry.event.tags.filter(tag => tag[0] === 'expiration').map(tag => Number(tag[1]))])
        .filter((value): value is number => value !== undefined && Number.isSafeInteger(value) && value > this.#now())
      if (expirations.length) this.#expirationTimer = setTimeout(() => this.#notify(),
        Math.max(1, Math.min(2_147_000_000, (Math.min(...expirations) - this.#now()) * 1000)))
    }
  }
  #stopRead(): void {
    this.#reading = false
    clearTimeout(this.#timer); this.#timer = undefined
    const off = this.#off, transport = this.#transport
    this.#off = undefined; this.#transport = undefined
    try { off?.() } catch { /* Always close the borrowed read transport too. */ }
    try { transport?.close() } catch { /* This read is already revoked. */ }
  }
  #limitRead(): void {
    this.#limited = true
    this.#stopRead()
    this.#status = 'The inbox input limit was reached. Relay reading stopped; saved copies remain available. This is not a complete inbox history.'
  }
  snapshot(): { ready: boolean; loading: boolean; busy: boolean; limited: boolean; status: string; messages: OrdinaryMessageRow[] } {
    if (!this.#current()) return { ready: false, loading: false, busy: false, limited: false, status: '', messages: [] }
    const messages: OrdinaryMessageRow[] = [], rumors = new Set<string>()
    for (const [copy, entry] of this.#entries) {
      if (ordinaryExpired(entry.event, this.#now()) || entry.message && (!this.#allowed(entry.message) ||
          entry.message.expiresAt !== undefined && entry.message.expiresAt <= this.#now())) {
        entry.message = undefined; this.#entries.delete(copy); continue
      }
      if (entry.message && rumors.has(entry.message.id)) continue
      if (entry.message) rumors.add(entry.message.id)
      messages.push({ copy, status: entry.status, ...(entry.message ? { message: { ...entry.message } } : {}) })
    }
    return { ready: this.#ready, loading: this.#loading, busy: this.#opening, limited: this.#limited, status: this.#status, messages }
  }
  async open(): Promise<void> {
    if (this.#started || !this.#current()) return
    this.#started = true; this.#loading = true; this.#status = 'Opening saved encrypted copies…'
    try {
      this.#notify()
      if (!this.#current()) return
      const release = await this.options.acquire(ordinaryHistoryKey(this.options.account))
      if (!this.#current()) { release(); return }
      this.#release = release
      this.#history = new OrdinaryMessageHistory(this.options.store, this.options.account, () => this.#now())
      for (const event of this.#history.copies()) this.#entries.set(event.id, { event, status: this.options.decrypt ? 'sealed' : 'unavailable' })
      this.#ready = true
      this.#status = 'Saved copies are available. Reading your published Nostr inbox relays…'; this.#notify()
      if (!this.#current()) return
      const transport = await this.options.receive(this.#current)
      if (!this.#current()) { transport.close(); return }
      this.#transport = transport; this.#reading = true
      this.#timer = setTimeout(() => {
        if (!this.#current() || !this.#reading) return
        this.#stopRead()
        this.#status = 'Relay reading stopped after 30 seconds. Inbox completeness and authenticated-relay access are not confirmed. Saved copies remain available; refresh to read again.'
        this.#notify()
      }, 30_000)
      const off = transport.subscribe([{ kinds: [1059], '#p': [this.options.account], limit: ORDINARY_MAX_COPIES }], input => {
        if (!this.#reading || !this.#current()) return
        let descriptor: PropertyDescriptor | undefined
        try { descriptor = Object.getOwnPropertyDescriptor(input, 'id') } catch { return }
        if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && this.#entries.has(descriptor.value)) return
        if (++this.#candidates > 512 || this.#accepted >= ORDINARY_MAX_COPIES) { this.#limitRead(); this.#notify(); return }
        const event = captureOrdinaryCopy(input, this.options.account, this.#now())
        if (!event) return
        try {
          const saved = this.#history!.append(event, this.#current)
          if (!this.#current()) return
          this.#accepted++; this.#limited ||= saved.limited
          const retained = new Set(saved.retained.map(row => row.id))
          for (const [id, entry] of this.#entries) if (!retained.has(id)) { entry.message = undefined; this.#entries.delete(id) }
          this.#entries.set(event.id, { event, status: this.options.decrypt ? 'sealed' : 'unavailable' })
          if (this.#accepted >= ORDINARY_MAX_COPIES) this.#limitRead()
        } catch {
          this.#status = 'A message copy could not be kept. No saved history was replaced. Close this view and check browser storage before refreshing.'
          this.#stopRead()
        }
        this.#notify()
      }, () => {
        if (!this.#reading || !this.#current()) return
        // RelayTransport also calls this on timeout/close. It is not proof
        // that every inbox relay answered or accepted authentication.
        this.#status = 'The relay query ended or timed out. This does not confirm that all inbox relays answered. Saved copies remain available; choose Open message to ask your signer.'
        this.#notify()
      })
      if (this.#current() && this.#reading) this.#off = off
      else { try { off() } catch { /* A synchronous callback already stopped the read. */ } }
    } catch {
      if (this.#current()) this.#status = this.#history
        ? 'Your published inbox relays could not be read. Saved copies remain available. Check your account inbox settings before refreshing.'
        : 'Saved message copies could not be opened. They were not overwritten. Close other inbox tabs and check this browser’s storage.'
      if (!this.#history) { this.#release?.(); this.#release = undefined }
      this.#stopRead()
    } finally { this.#loading = false; this.#notify() }
  }
  async openMessage(copy: string): Promise<void> {
    const entry = this.#entries.get(copy), decrypt = this.options.decrypt
    if (!entry || !this.#ready || this.#opening || entry.status === 'opened' || !this.#current()) return
    if (!decrypt) { entry.status = 'unavailable'; this.#notify(); return }
    const current = () => this.#current() && this.#entries.get(copy) === entry && !ordinaryExpired(entry.event, this.#now())
    this.#opening = true; entry.status = 'opening'
    try {
      this.#notify()
      if (!current()) return
      const outerText = await decrypt(entry.event.pubkey, entry.event.content, current)
      if (!current()) return
      if (typeof outerText !== 'string' || outerText.length > ORDINARY_MAX_WIRE_BYTES || new TextEncoder().encode(outerText).byteLength > ORDINARY_MAX_WIRE_BYTES) throw Error('Invalid seal size.')
      const seal = captureOrdinarySeal(JSON.parse(outerText), this.#now())
      if (!seal || seal.pubkey !== this.options.account && this.#blocked(seal.pubkey)) throw Error('Unavailable message author.')
      const authorCurrent = () => current() && (seal.pubkey === this.options.account || !this.#blocked(seal.pubkey))
      const text = await decrypt(seal.pubkey, seal.content, authorCurrent)
      if (!authorCurrent()) return
      if (typeof text !== 'string' || text.length > ORDINARY_MAX_WIRE_BYTES || new TextEncoder().encode(text).byteLength > ORDINARY_MAX_WIRE_BYTES) throw Error('Invalid message size.')
      const message = captureOrdinaryText(JSON.parse(text), seal, this.options.account, this.#now())
      if (!message || !this.#allowed(message)) throw Error('Unavailable ordinary text.')
      if (!authorCurrent()) return
      entry.message = message; entry.status = 'opened'
    } catch { if (current()) { entry.message = undefined; entry.status = 'refused' } }
    finally {
      if (entry.status === 'opening') entry.status = 'refused'
      this.#opening = false; this.#notify()
    }
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#ready = false
    clearTimeout(this.#expirationTimer)
    this.#stopRead()
    for (const entry of this.#entries.values()) entry.message = undefined
    this.#entries.clear(); this.#history = undefined
    try { this.#release?.() } catch { /* No cleanup failure may retain displayed plaintext. */ }
    this.#release = undefined; this.#status = ''
  }
}
