import { nip44 } from 'nostr-tools'
import { base64 } from '@scure/base'
import { decode } from 'nostr-tools/nip19'
import { finalizeEvent, generateSecretKey, getEventHash, type Event, type EventTemplate } from 'nostr-tools/pure'
import { latestDmRelayList } from '../../src/dm-relays.js'
import { randomFraction } from '../../src/random.js'
import { verifyEventUncached } from '../../src/verify.js'
import { isSignerTimeout } from './signer-timeout.js'

const HEX = /^[0-9a-f]{64}$/
export const NOSTR_MESSAGE_MAX_BYTES = 4096
export const NOSTR_MESSAGE_LANE = '○ public'
export const NOSTR_MESSAGE_WARNING = 'Start a separate public message? It begins a new conversation and takes nothing from this one. A relay operator could see who it was for and when.'
export interface NostrMessageIdentity {
  readonly pubkey: string
  encrypt(peer: string, text: string, current: () => boolean): Promise<string>
  signEvent(template: EventTemplate, current: () => boolean): Promise<Event>
}
export interface NostrMessageReview {
  readonly recipient: string
  readonly text: string
  readonly recipientRelays: readonly string[]
  readonly senderRelays: readonly string[]
  readonly replyTo?: string
}
interface Delivery { event: Event; relays: readonly string[]; accepted: boolean; unaccepted?: readonly string[] }
type Rumor = EventTemplate & { pubkey: string; id: string }
interface PendingWrap { ciphertext?: string; event?: Event }
interface MessagePreparation { rumor: Rumor; recipient: PendingWrap; sender: PendingWrap }
class MessagePreparationError extends Error {}
interface Options {
  identity: NostrMessageIdentity
  current(): boolean
  blocked(peer: string): boolean
  lookup(authors: string[], current: () => boolean): Promise<Event[]>
  allowsRelay?(url: string): boolean
  // The embedding must use a carrier that checks current at actual socket writes.
  // May name the relays that did not accept, for the status line.
  publish(event: Event, relays: readonly string[], current: () => boolean): Promise<void | { unaccepted: readonly string[] }>
  rememberCopy?(event: Event, current: () => boolean): Promise<void>
  changed(): void
  now?(): number
}
export function nostrMessageRecipient(input: string): string {
  const result = decode(input.trim().replace(/^nostr:/, ''))
  const key = result.type === 'npub' ? result.data : result.type === 'nprofile' ? result.data.pubkey : undefined
  if (!key || !HEX.test(key)) throw Error('Enter their Nostr public key (npub).')
  return key
}

/** Copy bounded wire fields before uncached verification; never trust a
 * library's verification marker or a caller-owned mutable relay statement. */
function signedStatement(value: Event, now: number, kind: number): Event | undefined {
  try {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return
    const copy: Record<string, unknown> = {}
    for (const name of ['id', 'pubkey', 'sig', 'kind', 'created_at', 'tags', 'content']) {
      const field = Object.getOwnPropertyDescriptor(value, name)
      if (!field || !Object.hasOwn(field, 'value')) return
      copy[name] = field.value
    }
    if (copy.kind !== kind || typeof copy.id !== 'string' || !HEX.test(copy.id) ||
        typeof copy.pubkey !== 'string' || !HEX.test(copy.pubkey) || typeof copy.sig !== 'string' || !/^[0-9a-f]{128}$/.test(copy.sig) ||
        !Number.isSafeInteger(copy.created_at) || (copy.created_at as number) < 0 || (copy.created_at as number) > now + 60 ||
        typeof copy.content !== 'string' || copy.content.length > 16384 || !Array.isArray(copy.tags) || copy.tags.length > 64) return
    const tags: string[][] = []
    let units = 0
    for (let i = 0; i < copy.tags.length; i++) {
      const row = Object.getOwnPropertyDescriptor(copy.tags, String(i))
      if (!row || !Object.hasOwn(row, 'value') || !Array.isArray(row.value) || row.value.length > 8) return
      const tag: string[] = []
      for (let j = 0; j < row.value.length; j++) {
        const part = Object.getOwnPropertyDescriptor(row.value, String(j))
        if (!part || !Object.hasOwn(part, 'value') || typeof part.value !== 'string' || (units += part.value.length) > 16384) return
        tag.push(part.value)
      }
      tags.push(tag)
    }
    const event = { ...copy, tags } as unknown as Event
    return verifyEventUncached(event) ? event : undefined
  } catch { return }
}

function validCiphertext(content: unknown): content is string {
  if (typeof content !== 'string' || content.length > 16384) return false
  try {
    const payload = base64.decode(content)
    return payload[0] === 2 && payload.length >= 99
  } catch { return false }
}

/** One explicitly reviewed public message, never a room fallback. Draft and
 * encrypted retry envelopes live only for this view. ACK means relay acceptance,
 * not receipt/read by the person; retries reuse only unconfirmed exact events. */
export class NostrMessage {
  #review?: NostrMessageReview
  #preparation?: MessagePreparation
  #retryPreparation = false
  #deliveries: Delivery[] = []
  #closed = false
  #busy = false
  #attempted = false
  #status = 'Enter a recipient and a new message. Nothing from a room is copied.'
  constructor(private readonly options: Options) {
    if (!HEX.test(options.identity.pubkey)) throw Error('A signed-in Nostr account is required.')
  }
  #current = (): boolean => {
    try { return !this.#closed && this.options.current() && (!this.#review || !this.options.blocked(this.#review.recipient)) }
    catch { return false }
  }
  #notify(): void { if (this.#current()) this.options.changed() }
  snapshot(): { review?: NostrMessageReview; busy: boolean; attempted: boolean; retry: boolean; retryPreparation: boolean; status: string } {
    if (!this.#current()) { this.close(); return { busy: false, attempted: false, retry: false, retryPreparation: false, status: '' } }
    return { review: this.#review, busy: this.#busy, attempted: this.#attempted,
      retry: !this.#busy && this.#deliveries.some(row => !row.accepted), retryPreparation: this.#retryPreparation, status: this.#status }
  }
  async review(recipient: string, text: string, replyTo?: string): Promise<void> {
    if (this.#busy || this.#attempted || !this.#current()) return
    this.#review = undefined
    this.#preparation = undefined
    this.#retryPreparation = false
    if (!HEX.test(recipient) || replyTo !== undefined && !HEX.test(replyTo) || recipient === this.options.identity.pubkey || this.options.blocked(recipient) ||
        text.length > NOSTR_MESSAGE_MAX_BYTES || !text.trim() || new TextEncoder().encode(text).byteLength > NOSTR_MESSAGE_MAX_BYTES) {
      this.#status = 'Choose another person and a message of at most 4096 bytes.'; this.#notify(); return
    }
    this.#busy = true; this.#status = 'Checking both accounts’ published inbox relays…'; this.#notify()
    const current = () => this.#current() && !this.options.blocked(recipient)
    try {
      const statements = await this.options.lookup([recipient, this.options.identity.pubkey], current)
      if (!current()) return
      const now = this.options.now?.() ?? Math.floor(Date.now() / 1000)
      const verified = statements.slice(0, 64).map(row => signedStatement(row, now, 10050)).filter((row): row is Event => !!row)
      const routes = (account: string) => latestDmRelayList(verified, account).filter(url => this.options.allowsRelay?.(url) !== false)
      const recipientRelays = routes(recipient), senderRelays = routes(this.options.identity.pubkey)
      if (!recipientRelays.length || !senderRelays.length) {
        this.#status = !recipientRelays.length ? 'No usable published NIP-17 inbox was found for this person. Nothing was sent.'
          : 'Publish your Nostr inbox relays in account settings first, so you retain an encrypted copy. Nothing was sent.'
        return
      }
      this.#review = Object.freeze({ recipient, text, recipientRelays: Object.freeze(recipientRelays), senderRelays: Object.freeze(senderRelays),
        ...(replyTo ? { replyTo } : {}) })
      this.#status = '○ public. This uses ordinary Nostr inbox relays, outside the sheltered conversation. Choose Send public to continue.'
    } catch { if (current()) this.#status = 'Inbox relays could not be checked. Nothing was sent.' }
    finally { this.#busy = false; this.#notify() }
  }

  async #requestSigner<T>(action: 'encrypt' | 'sign', copy: string, request: () => Promise<T>): Promise<T> {
    const task = `${action} ${copy}`
    this.#status = `Waiting for your signer to ${task}… Approve any prompt in your signer.`
    this.#notify()
    if (!this.#current()) throw Error('Public message cancelled.')
    try { return await request() }
    catch (error) {
      // Signer errors can include request contents. Only surface fixed guidance.
      const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
      if (isSignerTimeout(detail) || detail === 'timeout' || /^nip46-[a-z0-9_]+-auth-timeout$/.test(detail)) {
        throw new MessagePreparationError(`Your signer did not answer the request to ${task}. Open or unlock it, then retry.`)
      }
      if (/^nip46-[a-z0-9_]+-publish-failed$/.test(detail)) {
        throw new MessagePreparationError(`KithMoot could not reach your remote signer to ${task}. Check your connection, then retry.`)
      }
      if (/\b(denied|declined|rejected|refused|permission|not allowed|approval required)\b/i.test(detail)) {
        throw new MessagePreparationError(`Your signer refused to ${task}. Check KithMoot’s permissions in your signer, then retry.`)
      }
      throw new MessagePreparationError(`KithMoot could not ${task}. Check your signer and approve any prompt when you retry.`)
    }
  }

  async #prepareWrap(wrap: PendingWrap, rumor: Rumor, peer: string, copy: string, now: number): Promise<Event> {
    const identity = this.options.identity
    const check = () => { if (!this.#current()) throw Error('Public message cancelled.') }
    check()
    if (wrap.event) return wrap.event
    if (wrap.ciphertext === undefined) {
      const encrypted = await this.#requestSigner('encrypt', copy, () => identity.encrypt(peer, JSON.stringify(rumor), this.#current))
      check()
      if (!validCiphertext(encrypted)) throw new MessagePreparationError(`Your signer returned invalid NIP-44 encryption for ${copy}. Check that it supports NIP-44, then retry.`)
      wrap.ciphertext = encrypted
    }
    const content = wrap.ciphertext
    const created_at = Math.max(0, now - Math.floor(randomFraction() * 172800))
    const supplied = await this.#requestSigner('sign', copy, () => identity.signEvent({ kind: 13, created_at, tags: [], content }, this.#current))
    check()
    const seal = signedStatement(supplied, now, 13)
    if (!seal || seal.pubkey !== identity.pubkey || seal.created_at !== created_at ||
        seal.content !== content || seal.tags.length !== 0) {
      wrap.ciphertext = undefined
      throw new MessagePreparationError(`Your signer returned an invalid seal for ${copy}. Check the account selected in your signer, then retry.`)
    }
    const key = generateSecretKey()
    try {
      const outer = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(key, peer))
      check()
      const event = finalizeEvent({ kind: 1059, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)),
        tags: [['p', peer]], content: outer }, key)
      for (const tag of event.tags) Object.freeze(tag)
      Object.freeze(event.tags)
      wrap.event = Object.freeze(event)
      wrap.ciphertext = undefined
      return wrap.event
    } finally { key.fill(0) }
  }

  async #prepare(review: NostrMessageReview): Promise<void> {
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000)
    if (!this.#preparation) {
      const event = { kind: 14, pubkey: this.options.identity.pubkey, created_at: now,
        tags: [['p', review.recipient], ...(review.replyTo ? [['e', review.replyTo]] : [])], content: review.text }
      this.#preparation = { rumor: { ...event, id: getEventHash(event) }, recipient: {}, sender: {} }
    }
    const { rumor, recipient, sender } = this.#preparation
    // Retain completed work for this reviewed draft. Both wraps must be ready
    // and the inbox copy saved before any message envelope leaves the device.
    const recipientEvent = await this.#prepareWrap(recipient, rumor, review.recipient, 'the recipient’s copy', now)
    const senderEvent = await this.#prepareWrap(sender, rumor, this.options.identity.pubkey, 'your inbox copy', now)
    if (!this.#current()) return
    this.#status = 'Saving your encrypted inbox copy on this device…'; this.#notify()
    if (!this.#current()) return
    try { await this.options.rememberCopy?.(senderEvent, this.#current) }
    catch { throw new MessagePreparationError('Your encrypted message copy could not be kept on this device. Check browser storage and close other inbox tabs.') }
    if (!this.#current()) return
    this.#deliveries = [{ event: recipientEvent, relays: review.recipientRelays, accepted: false },
      { event: senderEvent, relays: review.senderRelays, accepted: false }]
    this.#preparation = undefined
    this.#attempted = true
  }

  async send(): Promise<void> {
    if (this.#busy || !this.#review || !this.#current() || this.#attempted && !this.#deliveries.some(row => !row.accepted)) return
    const review = this.#review
    this.#busy = true; this.#retryPreparation = false
    try {
      if (!this.#attempted) {
        try { await this.#prepare(review) }
        catch (error) {
          if (this.#current()) {
            this.#retryPreparation = true
            const reason = error instanceof MessagePreparationError ? error.message : 'KithMoot could not prepare the encrypted message.'
            this.#status = `${reason} Nothing was sent.`
          }
          return
        }
      }
      if (!this.#current()) return
      this.#status = '○ public. Sending to the reviewed inbox relays…'; this.#notify()
      for (const delivery of this.#deliveries) {
        if (!this.#current()) return
        if (delivery.accepted) continue
        try {
          const result = await this.options.publish(delivery.event, delivery.relays, this.#current)
          if (this.#current()) { delivery.accepted = true; delivery.unaccepted = result?.unaccepted ?? [] }
        }
        catch { /* Preserve the exact envelope; never assume no write occurred. */ }
      }
      if (!this.#current()) return
      const [recipient, sender] = this.#deliveries
      const missed = recipient?.accepted && recipient.unaccepted?.length
        ? ` Not accepted by ${recipient.unaccepted.map(url => url.replace(/^wss?:\/\//, '').replace(/\/$/, '')).join(', ')}.` : ''
      this.#status = recipient?.accepted
        ? (sender?.accepted ? '○ public. A recipient relay accepted the message and a relay accepted your encrypted copy. This does not confirm that the person received or read it.'
          : '○ public. A recipient relay accepted the message; your encrypted history copy is unconfirmed. Retry sends only the same unconfirmed copy.') + missed
        : '○ public. Recipient relay acceptance is unconfirmed. It may have arrived. Retry sends the same unconfirmed event, not a new message.'
    } finally { this.#busy = false; this.#notify() }
  }
  close(): void {
    this.#closed = true; this.#review = undefined; this.#preparation = undefined; this.#retryPreparation = false
    this.#deliveries = []; this.#status = ''
  }
}
