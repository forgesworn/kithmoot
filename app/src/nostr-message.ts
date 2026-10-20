import { nip44 } from 'nostr-tools'
import { base64 } from '@scure/base'
import { decode } from 'nostr-tools/nip19'
import { finalizeEvent, generateSecretKey, getEventHash, type Event, type EventTemplate } from 'nostr-tools/pure'
import { latestDmRelayList } from '../../src/dm-relays.js'
import { randomFraction } from '../../src/random.js'
import { verifyEventUncached } from '../../src/verify.js'

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
}
interface Delivery { event: Event; relays: readonly string[]; accepted: boolean }
interface Options {
  identity: NostrMessageIdentity
  current(): boolean
  blocked(peer: string): boolean
  lookup(authors: string[], current: () => boolean): Promise<Event[]>
  // The embedding must use a carrier that checks current at actual socket writes.
  publish(event: Event, relays: readonly string[], current: () => boolean): Promise<void>
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

async function wrapText(rumor: EventTemplate & { pubkey: string; id: string }, recipient: string,
  identity: NostrMessageIdentity, now: number, current: () => boolean): Promise<Event> {
  const check = () => { if (!current()) throw Error('Public message cancelled.') }
  check()
  const content = await identity.encrypt(recipient, JSON.stringify(rumor), current)
  check()
  if (typeof content !== 'string' || content.length > 16384) throw Error('Invalid encrypted message.')
  const payload = base64.decode(content)
  if (payload[0] !== 2 || payload.length < 99) throw Error('Signer did not return a NIP-44 v2 payload.')
  const template = { kind: 13, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)), tags: [] as string[][], content }
  const supplied = await identity.signEvent(template, current)
  check()
  const seal = signedStatement(supplied, now, 13)
  if (!seal || seal.pubkey !== identity.pubkey || seal.created_at !== template.created_at ||
      seal.content !== content || seal.tags.length !== 0) throw Error('Invalid message seal.')
  const key = generateSecretKey()
  try {
    const outer = nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(key, recipient))
    check()
    const event = finalizeEvent({ kind: 1059, created_at: Math.max(0, now - Math.floor(randomFraction() * 172800)),
      tags: [['p', recipient]], content: outer }, key)
    for (const tag of event.tags) Object.freeze(tag)
    Object.freeze(event.tags)
    return Object.freeze(event)
  } finally { key.fill(0) }
}

/** One explicitly reviewed public message, never a room fallback. Draft and
 * encrypted retry envelopes live only for this view. ACK means relay acceptance,
 * not receipt/read by the person; retries reuse only unconfirmed exact events. */
export class NostrMessage {
  #review?: NostrMessageReview
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
  snapshot(): { review?: NostrMessageReview; busy: boolean; attempted: boolean; retry: boolean; status: string } {
    if (!this.#current()) { this.close(); return { busy: false, attempted: false, retry: false, status: '' } }
    return { review: this.#review, busy: this.#busy, attempted: this.#attempted,
      retry: !this.#busy && this.#deliveries.some(row => !row.accepted), status: this.#status }
  }
  async review(recipient: string, text: string): Promise<void> {
    if (this.#busy || this.#attempted || !this.#current()) return
    this.#review = undefined
    if (!HEX.test(recipient) || recipient === this.options.identity.pubkey || this.options.blocked(recipient) ||
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
      const recipientRelays = latestDmRelayList(verified, recipient), senderRelays = latestDmRelayList(verified, this.options.identity.pubkey)
      if (!recipientRelays.length || !senderRelays.length) {
        this.#status = !recipientRelays.length ? 'No usable published NIP-17 inbox was found for this person. Nothing was sent.'
          : 'Publish your Nostr inbox relays in account settings first, so you retain an encrypted copy. Nothing was sent.'
        return
      }
      this.#review = Object.freeze({ recipient, text, recipientRelays: Object.freeze(recipientRelays), senderRelays: Object.freeze(senderRelays) })
      this.#status = '○ public. This uses ordinary Nostr inbox relays, outside the sheltered conversation. Choose Send public to continue.'
    } catch { if (current()) this.#status = 'Inbox relays could not be checked. Nothing was sent.' }
    finally { this.#busy = false; this.#notify() }
  }
  async send(): Promise<void> {
    if (this.#busy || !this.#review || !this.#current() || this.#attempted && !this.#deliveries.some(row => !row.accepted)) return
    const review = this.#review
    this.#busy = true; this.#status = 'Preparing your separate public message…'; this.#notify()
    try {
      if (!this.#attempted) {
        const now = this.options.now?.() ?? Math.floor(Date.now() / 1000)
        const event = { kind: 14, pubkey: this.options.identity.pubkey, created_at: now, tags: [['p', review.recipient]], content: review.text }
        const rumor = { ...event, id: getEventHash(event) }
        // Prepare both before either leaves the device. A refusal preparing
        // the history copy must not send only the recipient's half silently.
        const recipient = await wrapText(rumor, review.recipient, this.options.identity, now, this.#current)
        const sender = await wrapText(rumor, this.options.identity.pubkey, this.options.identity, now, this.#current)
        if (!this.#current()) return
        this.#deliveries = [{ event: recipient, relays: review.recipientRelays, accepted: false },
          { event: sender, relays: review.senderRelays, accepted: false }]
        this.#attempted = true
      }
      this.#status = '○ public. Sending to the reviewed inbox relays…'; this.#notify()
      for (const delivery of this.#deliveries) {
        if (!this.#current()) return
        if (delivery.accepted) continue
        try { await this.options.publish(delivery.event, delivery.relays, this.#current); if (this.#current()) delivery.accepted = true }
        catch { /* Preserve the exact envelope; never assume no write occurred. */ }
      }
      if (!this.#current()) return
      const [recipient, sender] = this.#deliveries
      this.#status = recipient?.accepted
        ? sender?.accepted ? '○ public. A recipient relay accepted the message and a relay accepted your encrypted copy. This does not confirm that the person received or read it.'
          : '○ public. A recipient relay accepted the message; your encrypted history copy is unconfirmed. Retry sends only the same unconfirmed copy.'
        : '○ public. Recipient relay acceptance is unconfirmed. It may have arrived. Retry sends the same unconfirmed event, not a new message.'
    } catch { if (this.#current()) this.#status = 'Your signer did not prepare this message. Nothing was sent. You can choose Send public to try again.' }
    finally { this.#busy = false; this.#notify() }
  }
  close(): void { this.#closed = true; this.#review = undefined; this.#deliveries = []; this.#status = '' }
}
