/**
 * Whether the relays kept a message this device sent: the one tick.
 *
 * A relay's `OK` says it took the event, not that it will return it. A
 * relay that accepts chat and returns none of it, or an event that no reader
 * can use, looked exactly like a delivered message. So a message is shown as
 * sent only on evidence from a relay that acknowledged it:
 *
 * - a relay returned this very event when asked for it back after the write
 *   (whether or not its OK got through), or
 * - a relay that said OK to it has returned a chat event since the pool was
 *   set up (it has been seen to keep chat), and has not been seen to lose any.
 *
 * When every relay that was asked, including those that never said OK, has
 * not returned it, the message is "not kept", which can be sent again. A
 * message with no answer yet is "checking". Nothing here says anyone else's device has it: that needs a
 * delivery receipt, which is a later change.
 *
 * Only this device's own messages are tracked. The verdict is kept per
 * message on the device, so a reload shows the same tick; a message this
 * device sent before the feature, or sent from another device, has none.
 *
 * No DOM, so the rules can be tested without a browser.
 */
import type { Event } from 'nostr-tools/pure'
import type { ChatMessage } from '../../src/chat.js'
import type { PublishEvidence } from '../../src/relay-pool.js'
import type { DeviceStore } from './device-store.js'

export type DeliveryState = 'checking' | 'sent' | 'not-kept'

/** What the relays' answers add up to for one message, or undefined when
 *  they cannot say (a relay that cannot be asked might hold it, or none is
 *  known).
 *
 *  `trustRelayLoss: false` ignores a relay's earlier failure on another
 *  event, which a retry has not yet had the chance to answer for itself.
 *  `since` is when a retry began: what a relay did with the write before it
 *  is not an answer about this one. */
export function sentState(evidence: PublishEvidence | undefined, options: { trustRelayLoss?: boolean; since?: number } = {}): DeliveryState | undefined {
  if (!evidence) return undefined
  const trustLoss = options.trustRelayLoss !== false
  // After a retry, only relays that have answered the new write count.
  const relays = options.since === undefined ? evidence.relays : evidence.relays.filter(relay => !relay.acked || relay.at >= options.since!)
  if (relays.length === 0) return options.since === undefined ? undefined : 'checking'
  let unanswered = 0, unaskable = 0
  for (const relay of relays) {
    // A relay that returned this very event holds it, whether or not its OK got through.
    if (relay.found === true) return 'sent'
    if (relay.found === false) continue
    // What a relay did with another event only speaks for this one if it said OK to this one.
    if (relay.acked && relay.keeps && !relay.lost) return 'sent'
    if (relay.acked && relay.lost && trustLoss) continue
    if (relay.readable) unanswered++
    else unaskable++
  }
  // A relay that cannot be asked might hold it: claim nothing either way.
  if (unaskable > 0) return undefined
  // A relay still working on the write, or not yet asked, may yet have it.
  if (unanswered > 0 || evidence.pending > 0) return 'checking'
  return 'not-kept'
}

/** A message that renders as a row of its own: not a reaction, an edit, a
 *  retraction, an invitation, a room logo or a shared-work operation. */
export function isTickMessage(message: Pick<ChatMessage, 'reaction' | 'replaces' | 'retracts' | 'invite' | 'roomLogo' | 'assignment'>): boolean {
  return !message.reaction && message.replaces === undefined && message.retracts === undefined &&
    !message.invite && message.roomLogo === undefined && !message.assignment
}

export interface DeliveryRecord {
  /** The message's own id, as the chat shows it. */
  id: string
  /** The signed event id the relays acknowledged. */
  eventId: string
  state: DeliveryState
  /** When a relay acknowledged it, in milliseconds. */
  at: number
  /** The signed event, kept only while it is not kept, so Retry can offer the same bytes again. */
  event?: Event
  /** When the person sent it again, in milliseconds: what the relays said about an earlier write says nothing about this one. */
  retriedAt?: number
}

export interface DeliveryTicksOptions {
  store: DeviceStore
  /** What the pool knows about an acknowledged event. */
  evidence: (eventId: string) => PublishEvidence | undefined
  /** Asks the relays that acknowledged an event for it back, now. */
  askBack?: (eventId: string) => void
  now?: () => number
  onChange?: () => void
}

const PREFIX = 'kithmoot.delivery.v1.'
/** A message's verdict is kept this long: a week, as long as anything else about delivery is. */
export const DELIVERY_KEPT_MS = 7 * 24 * 3600 * 1000
/** Most verdicts kept for a room. */
export const MAX_DELIVERY_KEPT = 300
/** How long a message may wait for the one check per relay before it is asked about by name. */
export const ASK_BACK_AFTER_MS = 15_000
/** How long a message with no evidence at all keeps its clock before the tick is dropped. */
export const NO_EVIDENCE_AFTER_MS = 15_000
/** How long a clock may wait for relays that never answer before it is dropped: no tick says less than a clock that never ends. */
export const GIVE_UP_AFTER_MS = 90_000
/** Most unsent copies of a not-kept message kept for Retry. */
const MAX_KEPT_EVENTS = 20

interface Stored { i: string; e: string; s: 'sent' | 'not-kept'; a: number; v?: Event }

function readable(value: unknown): value is Stored {
  const v = value as Partial<Stored> | null
  return !!v && typeof v === 'object' && typeof v.i === 'string' && typeof v.e === 'string' && (v.s === 'sent' || v.s === 'not-kept') &&
    Number.isSafeInteger(v.a) && (v.v === undefined || (typeof v.v === 'object' && v.v !== null && typeof (v.v as Event).id === 'string'))
}

export class DeliveryTicks {
  readonly #opts: DeliveryTicksOptions & { now: () => number; onChange: () => void }
  readonly #rooms = new Map<string, Map<string, DeliveryRecord>>()
  readonly #asked = new Set<string>()

  constructor(opts: DeliveryTicksOptions) {
    this.#opts = { now: () => Date.now(), onChange: () => {}, ...opts }
  }

  #room(roomId: string): Map<string, DeliveryRecord> {
    let room = this.#rooms.get(roomId)
    if (room) return room
    room = new Map()
    this.#rooms.set(roomId, room)
    try {
      const raw = this.#opts.store.get(PREFIX + roomId)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) for (const value of parsed) {
        if (!readable(value)) continue
        room.set(value.i, { id: value.i, eventId: value.e, state: value.s, at: value.a * 1000, ...(value.v ? { event: value.v } : {}) })
      }
    } catch { /* Unreadable or unavailable storage: no evidence, no tick. */ }
    return room
  }

  #save(roomId: string): void {
    const room = this.#room(roomId)
    const cutoff = this.#opts.now() - DELIVERY_KEPT_MS
    for (const [id, record] of room) if (record.at < cutoff) room.delete(id)
    const settled = [...room.values()].filter(record => record.state !== 'checking').sort((a, b) => a.at - b.at).slice(-MAX_DELIVERY_KEPT)
    const withEvent = new Set(settled.filter(record => record.state === 'not-kept' && record.event).slice(-MAX_KEPT_EVENTS).map(record => record.id))
    const stored: Stored[] = settled.map(record => ({ i: record.id, e: record.eventId, s: record.state as 'sent' | 'not-kept',
      a: Math.floor(record.at / 1000), ...(withEvent.has(record.id) ? { v: record.event } : {}) }))
    try {
      if (stored.length) this.#opts.store.set(PREFIX + roomId, JSON.stringify(stored))
      else this.#opts.store.remove(PREFIX + roomId)
    } catch { /* The tick still shows for this visit. */ }
  }

  /** A relay acknowledged this message. `quiet` rooms have no read-back: the drop being accepted is the whole of what they can say. */
  note(roomId: string, id: string, event: Event, quiet = false): void {
    const room = this.#room(roomId)
    room.set(id, { id, eventId: event.id, state: quiet ? 'sent' : 'checking', at: this.#opts.now(), ...(quiet ? {} : { event }) })
    if (quiet) this.#save(roomId)
    this.#opts.onChange()
  }

  get(roomId: string, id: string): DeliveryRecord | undefined { return this.#room(roomId).get(id) }

  /** Whether any message in this room still waits for an answer. */
  waiting(roomId: string): boolean { return [...this.#room(roomId).values()].some(record => record.state === 'checking') }

  /** The person pressed Retry: ask again, and let this write answer for itself. */
  retry(roomId: string, id: string): DeliveryRecord | undefined {
    const record = this.#room(roomId).get(id)
    if (!record || record.state !== 'not-kept' || !record.event) return undefined
    record.state = 'checking'; record.retriedAt = this.#opts.now(); record.at = record.retriedAt
    this.#asked.delete(record.eventId)
    this.#save(roomId)
    this.#opts.onChange()
    return record
  }

  /** The republish itself failed: it is still not kept. */
  failed(roomId: string, id: string): void {
    const record = this.#room(roomId).get(id)
    if (!record || record.state !== 'checking') return
    record.state = 'not-kept'
    this.#save(roomId); this.#opts.onChange()
  }

  /** Read what the pool now knows about every message still waiting. */
  refresh(roomId: string): void {
    const room = this.#room(roomId)
    const now = this.#opts.now()
    let changed = false
    for (const record of [...room.values()]) {
      if (record.state !== 'checking') continue
      const evidence = this.#opts.evidence(record.eventId)
      const state = sentState(evidence, { trustRelayLoss: record.retriedAt === undefined, ...(record.retriedAt === undefined ? {} : { since: record.retriedAt }) })
      if (state === 'sent' || state === 'not-kept') {
        record.state = state
        if (state === 'sent') delete record.event
        changed = true
        continue
      }
      if (now - record.at >= ASK_BACK_AFTER_MS && evidence && !this.#asked.has(record.eventId)) {
        this.#asked.add(record.eventId); this.#opts.askBack?.(record.eventId)
      }
      // Nothing can ever say: the relays that took it cannot be asked, or the
      // pool that took it is gone. No tick is better than a clock for ever.
      if ((state === undefined && now - record.at >= NO_EVIDENCE_AFTER_MS) || now - record.at >= GIVE_UP_AFTER_MS) { room.delete(record.id); changed = true }
    }
    if (changed) { this.#save(roomId); this.#opts.onChange() }
  }

  /** Forget a room's verdicts, as when the room is left and deleted. */
  forget(roomId: string): void {
    this.#rooms.delete(roomId)
    try { this.#opts.store.remove(PREFIX + roomId) } catch { /* Nothing more to forget. */ }
  }
}

/** The words for a state, for the tick and its tooltip. Accessible label first; Retry is part of the label because the tick is the button that offers it. */
export function deliveryWords(state: DeliveryState): { label: string; title: string } {
  switch (state) {
    case 'checking': return { label: 'Sending', title: 'Sending…' }
    case 'sent': return { label: 'Sent', title: 'Sent. Not yet confirmed on anyone else’s device.' }
    case 'not-kept': return { label: 'Not kept. Retry', title: 'Not kept: a relay accepted it but did not keep it.' }
  }
}
