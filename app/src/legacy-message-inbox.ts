import { base64 } from '@scure/base'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'

export const LEGACY_MESSAGE_WARNING = 'Legacy NIP-04 encryption. Relays can see the sender and recipient. Use a modern private conversation for sensitive messages.'
const HEX = /^[0-9a-f]{64}$/
const MAX_CONTENT = 32 * 1024, MAX_MESSAGES = 128, MAX_CANDIDATES = 512
const MAX_WIRE = 48 * 1024, MAX_WIRE_TOTAL = MAX_MESSAGES * MAX_WIRE
const MAX_PLAIN_TOTAL = MAX_MESSAGES * MAX_CONTENT, encoder = new TextEncoder()
type MessageStatus = 'sealed' | 'opening' | 'opened' | 'unavailable' | 'refused'
export interface LegacyMessage {
  id: string; author: string; sentAt: number; status: MessageStatus; warning: string; text?: string
}
interface Entry { event: Event; status: MessageStatus; wireBytes: number; plainBytes: number; text?: string }
interface Options {
  account: string
  // The embedding must apply current as a restriction at the SDK's actual
  // provider-start hook as well as handoff. It supplies no native authority.
  decrypt?: (peer: string, ciphertext: string, current: () => boolean) => Promise<string>
  transport: Pick<RelayTransport, 'subscribe' | 'close'>
  current(): boolean
  blocked(peer: string): boolean
  changed(): void
}

/** Capture the signed wire statement without trusting a verification cache,
 * aliases or getters supplied by its caller. Nothing here dispatches a signer. */
export function captureLegacyMessage(input: unknown, account: string): Event | undefined {
  try {
    if (!HEX.test(account) || !input || typeof input !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return
    const fields = ['id', 'pubkey', 'sig', 'kind', 'created_at', 'content', 'tags']
    const names = Object.getOwnPropertyNames(input)
    if (names.length !== fields.length || names.some(name => !fields.includes(name))) return
    const value: Record<string, unknown> = {}
    for (const name of fields) {
      const field = Object.getOwnPropertyDescriptor(input, name)
      if (!field || !Object.hasOwn(field, 'value')) return
      value[name] = field.value
    }
    if (typeof value.id !== 'string' || !HEX.test(value.id) || typeof value.pubkey !== 'string' || !HEX.test(value.pubkey) ||
        typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig) || value.kind !== 4 ||
        !Number.isSafeInteger(value.created_at) || (value.created_at as number) < 0 ||
        typeof value.content !== 'string' || value.content.length > MAX_CONTENT || !Array.isArray(value.tags) || value.tags.length > 128) return
    let units = 0
    const tags: string[][] = []
    for (let index = 0; index < value.tags.length; index++) {
      const row = Object.getOwnPropertyDescriptor(value.tags, String(index))
      if (!row || !Object.hasOwn(row, 'value') || !Array.isArray(row.value) || row.value.length > 16) return
      const tag: string[] = []
      for (let part = 0; part < row.value.length; part++) {
        const field = Object.getOwnPropertyDescriptor(row.value, String(part))
        if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' ||
            field.value.length > 1024 || (units += field.value.length) > 4096) return
        tag.push(field.value)
      }
      tags.push(tag)
    }
    if (!tags.some(tag => tag[0] === 'p' && tag[1] === account)) return
    const parts = value.content.split('?iv=')
    if (parts.length !== 2) return
    const ciphertext = base64.decode(parts[0]!), iv = base64.decode(parts[1]!)
    if (!ciphertext.length || ciphertext.length % 16 !== 0 || iv.length !== 16) return
    const event: Event = { id: value.id, pubkey: value.pubkey, sig: value.sig, kind: 4,
      created_at: value.created_at as number, content: value.content, tags }
    // verifyEvent may cache on this new object, never on the caller's object.
    if (!verifyEvent(event)) return
    for (const tag of tags) Object.freeze(tag)
    Object.freeze(tags)
    return Object.freeze(event)
  } catch { return undefined }
}

/** Receive-only, account-scoped and memory-only. A caller supplies only the
 * selected signer's decrypt callback; no signing, encryption or sending
 * capability is accepted. SDK/native custody remains the signer's duty. */
export class LegacyMessageInbox {
  readonly #options: Options
  #entries = new Map<string, Entry>()
  #off?: () => void
  #started = false
  #ready = false
  #closed = false
  #opening = false
  #limited = false
  #candidates = 0
  #wireBytes = 0
  #plainBytes = 0
  #error?: string
  constructor(options: Options) {
    if (!HEX.test(options.account)) throw Error('A legacy inbox requires a valid account.')
    this.#options = { ...options }
  }
  #current(): boolean {
    if (this.#closed) return false
    const current = this.#options.current()
    return current && !this.#closed
  }
  #notify(): void { if (this.#current()) this.#options.changed() }
  #remove(id: string, entry: Entry): void {
    if (this.#entries.get(id) !== entry) return
    this.#wireBytes -= entry.wireBytes
    this.#plainBytes -= entry.plainBytes
    delete entry.text
    this.#entries.delete(id)
  }
  #limit(): void { if (!this.#limited) { this.#limited = true; this.#notify() } }
  snapshot(): { ready: boolean; busy: boolean; limited: boolean; messages: LegacyMessage[]; error?: string } {
    if (!this.#current()) return { ready: false, busy: false, limited: false, messages: [] }
    const messages: LegacyMessage[] = []
    for (const [id, entry] of this.#entries) {
      if (this.#options.blocked(entry.event.pubkey)) { this.#remove(id, entry); continue }
      messages.push({ id, author: entry.event.pubkey, sentAt: entry.event.created_at, status: entry.status,
        warning: LEGACY_MESSAGE_WARNING, ...(entry.text !== undefined ? { text: entry.text } : {}) })
    }
    messages.sort((a, b) => b.sentAt - a.sentAt || a.id.localeCompare(b.id))
    if (!this.#current()) return { ready: false, busy: false, limited: false, messages: [] }
    return { ready: this.#ready, busy: this.#opening, limited: this.#limited, messages,
      ...(this.#error ? { error: this.#error } : {}) }
  }
  open(): void {
    if (this.#started || !this.#current()) return
    this.#started = true
    this.#ready = true
    try {
      const off = this.#options.transport.subscribe([{ kinds: [4], '#p': [this.#options.account], limit: MAX_MESSAGES }], input => {
        if (!this.#current()) return
        // Bound verification work as well as retained payload. Relays may
        // ignore LIMIT or flood malformed/duplicate events. Refresh is manual.
        let id: PropertyDescriptor | undefined
        try { id = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'id') : undefined }
        catch { return }
        if (id && Object.hasOwn(id, 'value') && typeof id.value === 'string' && id.value.length === 64 && this.#entries.has(id.value)) return
        if (this.#candidates >= MAX_CANDIDATES) { this.#limit(); return }
        this.#candidates++
        const event = captureLegacyMessage(input, this.#options.account)
        if (!event || this.#options.blocked(event.pubkey) || this.#entries.has(event.id)) return
        const wireBytes = encoder.encode(JSON.stringify(event)).byteLength
        if (wireBytes > MAX_WIRE || this.#wireBytes + wireBytes > MAX_WIRE_TOTAL || this.#entries.size >= MAX_MESSAGES) { this.#limit(); return }
        if (!this.#current()) return
        this.#wireBytes += wireBytes
        this.#entries.set(event.id, { event, status: this.#options.decrypt ? 'sealed' : 'unavailable', wireBytes, plainBytes: 0 })
        this.#notify()
      })
      if (this.#current()) this.#off = off
      else off()
    } catch {
      this.#ready = false
      this.#error = 'Legacy messages could not be loaded. Check your account and relay connection.'
      try { this.#options.transport.close() } catch { /* An error cannot grant a usable inbox. */ }
    }
    this.#notify()
  }
  async openMessage(id: string): Promise<void> {
    const entry = this.#entries.get(id), decrypt = this.#options.decrypt
    if (!entry || !this.#ready || !this.#current() || this.#opening || entry.status === 'opened' || this.#options.blocked(entry.event.pubkey)) return
    if (!decrypt) { entry.status = 'unavailable'; this.#notify(); return }
    this.#opening = true
    entry.status = 'opening'
    const current = () => {
      if (!this.#current() || this.#entries.get(id) !== entry || this.#options.blocked(entry.event.pubkey)) return false
      return this.#current() && this.#entries.get(id) === entry
    }
    try {
      this.#notify()
      if (!current()) return
      let text: string
      try { text = await decrypt(entry.event.pubkey, entry.event.content, current) }
      catch { if (current()) entry.status = 'refused'; return }
      if (!current()) { this.#remove(id, entry); return }
      if (typeof text !== 'string' || text.length > MAX_CONTENT) { entry.status = 'refused'; return }
      const plainBytes = encoder.encode(text).byteLength
      if (plainBytes > MAX_CONTENT || this.#plainBytes + plainBytes > MAX_PLAIN_TOTAL) { entry.status = 'refused'; return }
      this.#plainBytes += plainBytes
      entry.plainBytes = plainBytes
      entry.text = text
      entry.status = 'opened'
    } finally {
      this.#opening = false
      this.#notify()
    }
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true; this.#ready = false
    try { this.#off?.() } catch { /* Continue clearing the view even if transport cleanup fails. */ }
    try { this.#options.transport.close() } catch { /* No retained message is needed for cleanup. */ }
    this.#off = undefined
    for (const entry of this.#entries.values()) delete entry.text
    this.#entries.clear()
    this.#wireBytes = 0; this.#plainBytes = 0
  }
}
