/**
 * Who has confirmed this device's person's messages: the two ticks.
 *
 * Receipts (kind 1465, `src/delivery-receipt.ts`) name messages by a short
 * hash of their id. This keeps, per room, which of this person's own
 * messages each other person's device has confirmed, and when; matches a
 * receipt only against this person's own messages (anything else in it is
 * somebody else's business and dropped); and works out what the tick says.
 *
 * Delivery is per person: a person counts once whichever of their devices
 * confirmed. This person's own devices never count. An agent is listed but
 * lights the second tick only when nobody but agents is known in the room
 * (a person and their own agent). "of N" is shown only where the room has a
 * fixed member list; in a link room nobody holds the guest list, so there is
 * no honest denominator.
 *
 * Kept on the device for seven days, as long as a receipt lives on a relay.
 * No DOM, so the rules can be tested without a browser.
 */
import type { ChatMessage } from '../../src/chat.js'
import { deliveryReceiptIdHash, DELIVERY_RECEIPT_TTL_SECONDS, type DeliveryReceipt } from '../../src/delivery-receipt.js'
import type { DeviceStore } from './device-store.js'

export interface DeliveredBy {
  participant: string
  /** The receipt's `created_at`, unix seconds: when that device confirmed. */
  at: number
  agent: boolean
}

export interface DeliveredLedgerOptions {
  store: DeviceStore
  /** Milliseconds. */
  now?: () => number
  onChange?: (roomId: string) => void
}

const PREFIX = 'kithmoot.delivered.v1.'
/** Most own messages whose confirmations are kept for a room. */
export const MAX_DELIVERED_KEPT = 200
/** Slack on the receipts asked for again after a visit: relays are not instant. */
export const RECEIPT_REFETCH_SLACK_SECONDS = 600
/** Most unmatched hashes held in memory while this person's own messages load. */
const MAX_UNMATCHED = 2_000

interface Room {
  /** Own message hash to id and send time, rebuilt from the log each visit. */
  own: Map<string, { id: string; sentAt: number }>
  /** Own message id to who confirmed it. Persisted. */
  delivered: Map<string, { sentAt: number; by: Map<string, DeliveredBy> }>
  /** Confirmations for hashes not (yet) known to be our own. Memory only. */
  unmatched: Map<string, DeliveredBy[]>
  /** The newest receipt read, unix seconds. Persisted: the next visit asks relays from here. */
  newest?: number
  /** The oldest of this person's messages seen in the last seven days, unix
   *  seconds. Persisted: before any receipt has been read, the next visit
   *  asks relays from here. */
  oldestOwn?: number
}

interface Stored { t?: number; o?: number; m: Array<[string, number, Array<[string, number, 1?]>]> }

export class DeliveredLedger {
  readonly #opts: Required<DeliveredLedgerOptions>
  readonly #rooms = new Map<string, Room>()

  constructor(opts: DeliveredLedgerOptions) {
    this.#opts = { now: () => Date.now(), onChange: () => {}, ...opts }
  }

  #room(roomId: string): Room {
    let room = this.#rooms.get(roomId)
    if (room) return room
    room = { own: new Map(), delivered: new Map(), unmatched: new Map() }
    this.#rooms.set(roomId, room)
    try {
      const raw = this.#opts.store.get(PREFIX + roomId)
      const parsed = raw ? JSON.parse(raw) as Stored : undefined
      if (parsed && Number.isSafeInteger(parsed.t)) room.newest = parsed.t
      if (parsed && Number.isSafeInteger(parsed.o)) room.oldestOwn = parsed.o
      if (parsed && Array.isArray(parsed.m)) {
        for (const entry of parsed.m) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Number.isSafeInteger(entry[1]) || !Array.isArray(entry[2])) continue
          const by = new Map<string, DeliveredBy>()
          for (const who of entry[2]) {
            if (Array.isArray(who) && typeof who[0] === 'string' && /^[0-9a-f]{64}$/.test(who[0]) && Number.isSafeInteger(who[1])) {
              by.set(who[0], { participant: who[0], at: who[1], agent: who[2] === 1 })
            }
          }
          if (by.size) room.delivered.set(entry[0], { sentAt: entry[1], by })
        }
      }
    } catch { /* Unreadable storage: what relays still hold comes back. */ }
    return room
  }

  #save(roomId: string, room: Room): void {
    const cutoff = Math.floor(this.#opts.now() / 1000) - DELIVERY_RECEIPT_TTL_SECONDS
    for (const [id, entry] of room.delivered) if (entry.sentAt < cutoff) room.delivered.delete(id)
    if (room.oldestOwn !== undefined && room.oldestOwn < cutoff) room.oldestOwn = undefined
    const kept = [...room.delivered].sort((a, b) => a[1].sentAt - b[1].sentAt).slice(-MAX_DELIVERED_KEPT)
    const stored: Stored = {
      ...(room.newest !== undefined ? { t: room.newest } : {}),
      ...(room.oldestOwn !== undefined ? { o: room.oldestOwn } : {}),
      m: kept.map(([id, entry]) => [id, entry.sentAt, [...entry.by.values()].map(w => (w.agent ? [w.participant, w.at, 1] : [w.participant, w.at]) as [string, number, 1?])]),
    }
    try {
      if (stored.m.length || stored.t !== undefined || stored.o !== undefined) this.#opts.store.set(PREFIX + roomId, JSON.stringify(stored))
      else this.#opts.store.remove(PREFIX + roomId)
    } catch { /* Shown for this visit. */ }
  }

  /** One of this person's own messages, from any of their devices, as the log accepts it. */
  own(roomId: string, message: Pick<ChatMessage, 'id' | 'sentAt'>): void {
    const room = this.#room(roomId)
    const hash = deliveryReceiptIdHash(message.id)
    if (room.own.has(hash)) return
    room.own.set(hash, { id: message.id, sentAt: message.sentAt })
    const floor = Math.floor(this.#opts.now() / 1000) - DELIVERY_RECEIPT_TTL_SECONDS
    const older = message.sentAt >= floor && (room.oldestOwn === undefined || message.sentAt < room.oldestOwn)
    if (older) room.oldestOwn = message.sentAt
    const waiting = room.unmatched.get(hash)
    if (!waiting) { if (older) this.#save(roomId, room); return }
    room.unmatched.delete(hash)
    let changed = false
    for (const who of waiting) changed = this.#record(room, message.id, message.sentAt, who) || changed
    if (changed) { this.#save(roomId, room); this.#opts.onChange(roomId) }
  }

  #record(room: Room, id: string, sentAt: number, who: DeliveredBy): boolean {
    let entry = room.delivered.get(id)
    if (!entry) { entry = { sentAt, by: new Map() }; room.delivered.set(id, entry) }
    const before = entry.by.get(who.participant)
    if (!before) { entry.by.set(who.participant, who); return true }
    // The first confirmation is the one that says when it arrived; an agent
    // is an agent once any of its devices says so.
    const next = { participant: who.participant, at: Math.min(before.at, who.at), agent: before.agent || who.agent }
    if (next.at === before.at && next.agent === before.agent) return false
    entry.by.set(who.participant, next)
    return true
  }

  /** A receipt that passed every check. `self` is this device's person, whose receipts never count. */
  receipt(roomId: string, receipt: DeliveryReceipt, self: string): void {
    if (receipt.participant === self) return
    const room = this.#room(roomId)
    const who: DeliveredBy = { participant: receipt.participant, at: receipt.createdAt, agent: receipt.agent }
    let changed = false
    for (const hash of receipt.got) {
      const own = room.own.get(hash)
      if (own) { changed = this.#record(room, own.id, own.sentAt, who) || changed; continue }
      const list = room.unmatched.get(hash) ?? []
      if (!list.some(w => w.participant === who.participant)) list.push(who)
      room.unmatched.set(hash, list)
      while (room.unmatched.size > MAX_UNMATCHED) room.unmatched.delete(room.unmatched.keys().next().value!)
    }
    if (room.newest === undefined || receipt.createdAt > room.newest) { room.newest = receipt.createdAt; changed = true }
    if (changed) { this.#save(roomId, room); this.#opts.onChange(roomId) }
  }

  /** Who has confirmed one of this person's messages, earliest first. */
  delivered(roomId: string, messageId: string): DeliveredBy[] {
    const entry = this.#room(roomId).delivered.get(messageId)
    return entry ? [...entry.by.values()].sort((a, b) => a.at - b.at) : []
  }

  /**
   * The oldest receipt worth asking relays for, unix seconds. After a visit
   * that read receipts: from the newest one read, less some slack, since a
   * receipt is stamped when it is published. Before any: from this
   * person's oldest recent message, less a minute. With neither, from now:
   * live receipts still arrive. Never older than seven days.
   */
  since(roomId: string): number {
    const now = Math.floor(this.#opts.now() / 1000)
    const floor = now - DELIVERY_RECEIPT_TTL_SECONDS
    const room = this.#room(roomId)
    if (room.newest !== undefined) return Math.max(floor, Math.min(now, room.newest - RECEIPT_REFETCH_SLACK_SECONDS))
    return room.oldestOwn !== undefined ? Math.max(floor, Math.min(now, room.oldestOwn - 60)) : now
  }

  /** Forget a room, as when it is left and deleted. */
  forget(roomId: string): void {
    this.#rooms.delete(roomId)
    try { this.#opts.store.remove(PREFIX + roomId) } catch { /* Nothing more to forget. */ }
  }
}

export interface DeliveredView {
  /** People (not agents) whose devices confirmed, earliest first. */
  people: DeliveredBy[]
  agents: DeliveredBy[]
  /** Members of a fixed list who have not confirmed yet, when there is a fixed list. */
  waiting?: string[]
  /** The fixed list's size, less this person, when there is one. */
  of?: number
}

/**
 * Whether a message shows two ticks, and the facts its words come from.
 * Undefined when nobody who counts has confirmed it.
 *
 * - `members`: the room's fixed member list (`RoomPolicy.members`), when it has one.
 * - `knownPeople`: whether anybody but agents is known in the room besides
 *   this person (seen in the roster, wrote in the log, or confirmed).
 */
export function deliveredView(delivered: readonly DeliveredBy[], opts: { self: string; members?: readonly string[]; knownPeople: boolean }): DeliveredView | undefined {
  const others = delivered.filter(w => w.participant !== opts.self)
  const people = others.filter(w => !w.agent)
  const agents = others.filter(w => w.agent)
  if (people.length === 0 && (agents.length === 0 || opts.knownPeople)) return undefined
  if (!opts.members) return { people, agents }
  const members = [...new Set(opts.members)].filter(m => m !== opts.self)
  const confirmed = new Set(others.map(w => w.participant))
  return { people, agents, of: members.length, waiting: members.filter(m => !confirmed.has(m)) }
}

/** The tick's words: what it says beside the time, and its accessible label. */
export function deliveredWords(view: DeliveredView, nameOf: (participant: string) => string, knownOthers: number): { text: string; label: string } {
  const count = view.people.length || view.agents.length
  const first = (view.people[0] ?? view.agents[0])!
  if (view.of !== undefined) {
    if (view.of <= 1) return { text: 'Delivered', label: `Delivered to ${nameOf(first.participant)}` }
    return { text: `Delivered to ${count} of ${view.of}`, label: `Delivered to ${count} of ${view.of}` }
  }
  if (count === 1 && knownOthers <= 1) return { text: 'Delivered', label: `Delivered to ${nameOf(first.participant)}` }
  return { text: `Delivered to ${count}`, label: `Delivered to ${count}` }
}

/** The lines under "Delivered" when the ticks are opened. */
export const DELIVERED_FOOTNOTE = 'Delivered means their device received it. It does not mean they read it.'
export const DELIVERED_LINK_ROOM_NOTE = 'People not listed may be away, or using an app that does not confirm delivery.'

/** The setting that stops this device sending confirmations. */
export const DELIVERY_RECEIPTS_SETTING = 'kithmoot.delivery-receipts.v1'
/** Whether this device sends confirmations: on unless the person turned it off. */
export function sendsDeliveryReceipts(store: Pick<Storage, 'getItem'>): boolean {
  try { return store.getItem(DELIVERY_RECEIPTS_SETTING) !== 'off' } catch { return true }
}
