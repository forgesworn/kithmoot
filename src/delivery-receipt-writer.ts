import type { Event } from 'nostr-tools/pure'
import type { ChatMessage } from './chat.js'
import { hexEquals } from './hex.js'
import { randomFraction } from './random.js'
import { DELIVERY_RECEIPT_TTL_SECONDS, MAX_DELIVERY_RECEIPT_IDS, deliveryReceiptIdHash } from './delivery-receipt.js'

/**
 * When a device says which messages reached it: the writer half of delivery
 * receipts (see `delivery-receipt.ts` and "Writer rules" in
 * `docs/design/2026-10-28-delivery-ticks.md`).
 *
 * A message is acknowledged once it has been decrypted and accepted here,
 * renders as a row, was written by somebody else, and was sent no earlier
 * than a minute before this device joined the room and no more than seven
 * days ago. A new device of an existing person therefore says nothing about
 * history it read; a device that was away acknowledges its backlog, which is
 * what the sender wants.
 *
 * Per stream, the first message waiting starts a timer of 2 to 6 seconds
 * drawn from the CSPRNG, and the next receipt waits at least 30 seconds
 * after the last, so a busy room costs each reading device at most two
 * receipts a minute per stream. Over 256 waiting ids splits into several
 * receipts in one flush. An id is remembered as acknowledged only after a
 * relay took the receipt naming it, so a receipt that never left is retried
 * on the next visit; a duplicate is harmless.
 */

/** The storage a writer remembers what it acknowledged in. */
export interface ReceiptWriterStore {
  get(key: string): string | null | undefined
  set(key: string, value: string): void
  remove(key: string): void
}

/** What a writer needs from the conversation a message arrived in. A
 *  `ChatLog` is one. */
export interface ReceiptPublisher {
  publishDeliveryReceipt(opts: { d: string; messageIds: readonly string[]; createdAt?: number; index?: number; agent?: boolean }): Promise<Event>
  /** True once the conversation has closed: what waits for it is dropped,
   *  and acknowledged on the next visit instead. */
  readonly closed?: boolean
}

export interface ReceiptContext {
  roomId: string
  /** This device's participant: its own messages are never acknowledged. */
  self: string
  /** When this device joined the room, unix seconds. Unknown, the writer
   *  uses the first time it saw the room and remembers it. */
  joinedAt?: number
  /** A quiet room publishes no receipts. */
  quiet?: boolean
}

export interface DeliveryReceiptWriterOptions {
  store?: ReceiptWriterStore
  /** Key prefix in `store`; the room id is appended. */
  prefix?: string
  /** Milliseconds. */
  now?: () => number
  /** Uniform in [0, 1). Defaults to the CSPRNG. */
  random?: () => number
  /** The person's setting: off sends nothing. Asked at every flush. */
  enabled?: () => boolean
  /** Mark receipts as an agent's. */
  agent?: boolean
  /** Told of every receipt a relay took. */
  onPublished?: (roomId: string, event: Event) => void
}

export const RECEIPT_FIRST_DELAY_MIN_MS = 2_000
export const RECEIPT_FIRST_DELAY_SPAN_MS = 4_000
export const RECEIPT_SPACING_MS = 30_000
/** A message sent this long before this device joined still counts: clocks differ. */
export const RECEIPT_JOIN_SLACK_SECONDS = 60
/** Most acknowledged ids remembered per room. */
export const MAX_ACKNOWLEDGED_KEPT = 4_000
export const DEFAULT_RECEIPT_PREFIX = 'kithmoot.delivery-acks.v1.'

/** A message that renders as a row of its own: not a reaction, an edit, a
 *  retraction, an invitation, a room logo or a shared-work operation. */
export function isReceiptableMessage(message: Pick<ChatMessage, 'reaction' | 'replaces' | 'retracts' | 'invite' | 'roomLogo' | 'assignment'>): boolean {
  return !message.reaction && message.replaces === undefined && message.retracts === undefined &&
    !message.invite && message.roomLogo === undefined && !message.assignment
}

interface Stream {
  roomId: string
  d: string
  publisher: ReceiptPublisher
  /** Waiting ids, by hash, so a message seen twice waits once. */
  pending: Map<string, string>
  timer?: ReturnType<typeof setTimeout>
  /** When the last receipt for this stream was signed, milliseconds. */
  lastAt?: number
  flushing: boolean
}

interface Room {
  firstSeen: number
  /** Hash to unix seconds acknowledged. */
  acked: Map<string, number>
  /** Bumped when the room is dropped, so a flush in flight records nothing. */
  generation: number
}

export class DeliveryReceiptWriter {
  readonly #opts: Required<Pick<DeliveryReceiptWriterOptions, 'prefix' | 'now' | 'random' | 'enabled'>> & DeliveryReceiptWriterOptions
  readonly #rooms = new Map<string, Room>()
  readonly #streams = new Map<string, Stream>()

  constructor(opts: DeliveryReceiptWriterOptions = {}) {
    this.#opts = { prefix: DEFAULT_RECEIPT_PREFIX, now: () => Date.now(), random: randomFraction, enabled: () => true, ...opts }
  }

  #room(roomId: string): Room {
    let room = this.#rooms.get(roomId)
    if (room) return room
    room = { firstSeen: Math.floor(this.#opts.now() / 1000), acked: new Map(), generation: 0 }
    let fresh = true
    try {
      const raw = this.#opts.store?.get(this.#opts.prefix + roomId)
      const parsed = raw ? JSON.parse(raw) as { s?: unknown; a?: unknown } : undefined
      if (parsed && Number.isSafeInteger(parsed.s)) { room.firstSeen = parsed.s as number; fresh = false }
      if (parsed && Array.isArray(parsed.a)) {
        for (const entry of parsed.a) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && /^[0-9a-f]{16}$/.test(entry[0]) && Number.isSafeInteger(entry[1])) room.acked.set(entry[0], entry[1])
        }
      }
    } catch { /* Unreadable storage: start again. Duplicates are harmless. */ }
    this.#rooms.set(roomId, room)
    if (fresh) this.#save(roomId, room)
    return room
  }

  #save(roomId: string, room: Room): void {
    const cutoff = Math.floor(this.#opts.now() / 1000) - DELIVERY_RECEIPT_TTL_SECONDS
    for (const [hash, at] of room.acked) if (at < cutoff) room.acked.delete(hash)
    const kept = [...room.acked].sort((a, b) => a[1] - b[1]).slice(-MAX_ACKNOWLEDGED_KEPT)
    try { this.#opts.store?.set(this.#opts.prefix + roomId, JSON.stringify({ s: room.firstSeen, a: kept })) } catch { /* Kept for this visit. */ }
  }

  /** A message was accepted in a room this device is in. Never throws. */
  received(ctx: ReceiptContext, message: ChatMessage, d: string, publisher: ReceiptPublisher): void {
    try {
      if (ctx.quiet || !isReceiptableMessage(message) || hexEquals(message.participant, ctx.self)) return
      const now = Math.floor(this.#opts.now() / 1000)
      if (now - message.sentAt > DELIVERY_RECEIPT_TTL_SECONDS) return
      const room = this.#room(ctx.roomId)
      const joinedAt = ctx.joinedAt ?? room.firstSeen
      if (message.sentAt < joinedAt - RECEIPT_JOIN_SLACK_SECONDS) return
      const hash = deliveryReceiptIdHash(message.id)
      if (room.acked.has(hash)) return
      const key = `${ctx.roomId}\n${d.toLowerCase()}`
      let stream = this.#streams.get(key)
      if (!stream) {
        stream = { roomId: ctx.roomId, d: d.toLowerCase(), publisher, pending: new Map(), flushing: false }
        this.#streams.set(key, stream)
      }
      stream.publisher = publisher
      if (stream.pending.has(hash)) return
      stream.pending.set(hash, message.id)
      this.#schedule(key, stream)
    } catch { /* A receipt is never worth a message. */ }
  }

  #schedule(key: string, stream: Stream): void {
    if (stream.timer !== undefined || stream.flushing || stream.pending.size === 0) return
    const jitter = RECEIPT_FIRST_DELAY_MIN_MS + Math.floor(this.#opts.random() * RECEIPT_FIRST_DELAY_SPAN_MS)
    const spacing = stream.lastAt === undefined ? 0 : stream.lastAt + RECEIPT_SPACING_MS - this.#opts.now()
    stream.timer = setTimeout(() => { stream.timer = undefined; void this.#flush(key, stream) }, Math.max(jitter, spacing))
    ;(stream.timer as { unref?: () => void }).unref?.()
  }

  async #flush(key: string, stream: Stream): Promise<void> {
    if (this.#streams.get(key) !== stream || stream.pending.size === 0) return
    if (stream.publisher.closed) { this.#streams.delete(key); return }
    if (!this.#opts.enabled()) { stream.pending.clear(); return }
    const room = this.#room(stream.roomId)
    const generation = room.generation
    const waiting = [...stream.pending]
    stream.pending.clear()
    stream.flushing = true
    stream.lastAt = this.#opts.now()
    const createdAt = Math.floor(stream.lastAt / 1000)
    const failed: Array<[string, string]> = []
    try {
      for (let index = 0; index * MAX_DELIVERY_RECEIPT_IDS < waiting.length; index++) {
        const chunk = waiting.slice(index * MAX_DELIVERY_RECEIPT_IDS, (index + 1) * MAX_DELIVERY_RECEIPT_IDS)
        try {
          const event = await stream.publisher.publishDeliveryReceipt({
            d: stream.d, messageIds: chunk.map(([, id]) => id), createdAt, index, ...(this.#opts.agent ? { agent: true } : {}),
          })
          if (room.generation !== generation || this.#rooms.get(stream.roomId) !== room) return
          for (const [hash] of chunk) room.acked.set(hash, createdAt)
          this.#save(stream.roomId, room)
          try { this.#opts.onPublished?.(stream.roomId, event) } catch { /* Told; nothing to undo. */ }
        } catch {
          failed.push(...chunk)
        }
      }
    } finally {
      stream.flushing = false
    }
    if (this.#streams.get(key) !== stream) return
    if (stream.publisher.closed) { this.#streams.delete(key); return }
    // What did not go waits for the next turn, behind the spacing.
    for (const [hash, id] of failed) if (!room.acked.has(hash)) stream.pending.set(hash, id)
    this.#schedule(key, stream)
  }

  /** Stop everything waiting for a room, including a flush in flight: the
   *  room was closed, left or tidied up. What it had acknowledged is kept. */
  cancel(roomId: string): void {
    for (const [key, stream] of this.#streams) {
      if (stream.roomId !== roomId) continue
      if (stream.timer !== undefined) clearTimeout(stream.timer)
      this.#streams.delete(key)
    }
    const room = this.#rooms.get(roomId)
    if (room) room.generation++
  }

  /** `cancel`, and forget what the room acknowledged, as when it is left
   *  and deleted. */
  forget(roomId: string): void {
    this.cancel(roomId)
    this.#rooms.delete(roomId)
    try { this.#opts.store?.remove(this.#opts.prefix + roomId) } catch { /* Nothing more to forget. */ }
  }

  /** Whether anything is waiting to go for this room. For tests and a status line. */
  waiting(roomId: string): number {
    let n = 0
    for (const stream of this.#streams.values()) if (stream.roomId === roomId) n += stream.pending.size
    return n
  }
}
