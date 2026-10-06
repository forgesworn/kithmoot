/**
 * Messages this device has written and no relay has confirmed yet.
 *
 * A message on a bad connection must not vanish into a strip of its own, or
 * be lost by a reload: it waits where it was written, says what it is
 * waiting for, and goes by itself once a relay will take it. The states
 * matter beyond what the row says, because they decide what a later edit
 * or deletion can honestly promise:
 *
 * - `waiting`: never offered to a relay. No connection, or a retry not yet
 *   due after a refusal. Nothing has left this device.
 * - `sending`: offered to the relays, no answer yet.
 * - `refused`: every relay answered no. Nothing was kept anywhere.
 * - `unknown`: no relay answered in time. It may have arrived; a relay's
 *   acknowledgement can be what was lost.
 * - `moved`: the conversation closed or changed its key first. It was
 *   never sent, and never will be as it stands.
 *
 * Every retry publishes the same signed event, so a relay that already has
 * it keeps one copy. A row leaves when its message arrives in the chat, not
 * when a relay acknowledges it, so it never disappears before the message
 * it stands for is on screen.
 *
 * No DOM, so it can be tested without a browser.
 */
import type { Event } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'
import { CONVERSATION_MOVED } from '../../src/chat.js'

export type PendingState = 'waiting' | 'sending' | 'refused' | 'unknown' | 'moved'

export interface PendingSend {
  /** The message's own id, which is how it is recognised when it arrives. */
  id: string
  roomId: string
  /** The conversation's label, as the row names it. */
  channel: string
  text: string
  files: string[]
  event: Event
  state: PendingState
  /** Publishes the event. Absent on a row put back after a reload until
   *  the room is open again to give it one. */
  publish?: () => Promise<void>
  /** Whether this row is kept across a reload. */
  durable: boolean
  attempts: number
  /** When the next automatic attempt is due, in milliseconds. */
  retryAt?: number
  /** A relay acknowledged it; it leaves once the chat shows it. */
  acknowledged?: boolean
}

export interface PendingSendsOptions {
  store: DeviceStore
  /** Whether a relay can be reached now. A message is not offered to the
   *  relays while this is false, so it stays cleanly unsent. */
  connected: () => boolean
  now?: () => number
  onChange?: () => void
  /** The room open now. A message is only offered from its own room: one
   *  left behind in another waits, kept, until that room is open again. */
  active?: () => string | undefined
  /** For tests: replaces setTimeout. */
  schedule?: (run: () => void, ms: number) => void
}

/** Seconds before each automatic retry, the last repeating. */
export const RETRY_SECONDS = [5, 15, 30, 60]
/** How long an acknowledged row waits for its message to appear before it
 *  goes anyway: a relay that takes an event does not always echo it. */
export const ECHO_GRACE_MS = 5_000
/** How often a message waiting for a connection looks for one. */
export const CONNECT_POLL_MS = 1_000
const PREFIX = 'kithmoot.pending.'
/** A reload keeps this many unsent messages a room, newest last. */
const MAX_KEPT = 50

const REFUSED = /every relay rejected the event/
const UNANSWERED = /no relay could be reached in time/

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a failed publish says about where the event went. */
export function stateAfter(error: unknown): PendingState {
  const text = message(error)
  if (text === CONVERSATION_MOVED) return 'moved'
  if (REFUSED.test(text) && !UNANSWERED.test(text)) return 'refused'
  return 'unknown'
}

interface Kept { id: string; channel: string; text: string; files: string[]; event: Event; state: PendingState }

export class PendingSends {
  readonly #items = new Map<string, PendingSend>()
  readonly #opts: Required<Omit<PendingSendsOptions, 'schedule' | 'active'>> & Pick<PendingSendsOptions, 'schedule' | 'active'>

  constructor(opts: PendingSendsOptions) {
    this.#opts = { now: () => Date.now(), onChange: () => {}, ...opts }
  }

  #here(item: PendingSend): boolean {
    return !this.#opts.active || this.#opts.active() === item.roomId
  }

  /** Every unsent message for a room, oldest first. */
  items(roomId?: string): PendingSend[] {
    return [...this.#items.values()].filter(item => roomId === undefined || item.roomId === roomId)
  }

  get pending(): boolean { return this.#items.size > 0 }

  /** Queue a prepared message and send it as soon as a relay can be reached. */
  add(item: Omit<PendingSend, 'state' | 'attempts' | 'retryAt' | 'acknowledged'>): void {
    const added: PendingSend = { ...item, state: 'waiting', attempts: 0 }
    this.#items.set(item.id, added)
    this.#persist(item.roomId)
    this.#opts.onChange()
    void this.#attempt(added)
  }

  /** Messages now in the chat: their rows have done their job. */
  arrived(ids: Iterable<string>): void {
    let changed = false
    for (const id of ids) {
      const item = this.#items.get(id)
      if (!item) continue
      this.#items.delete(id)
      this.#persist(item.roomId)
      changed = true
    }
    if (changed) this.#opts.onChange()
  }

  /** Offer every message that is due, now that a relay may be reachable. */
  wake(): void {
    const now = this.#opts.now()
    for (const item of this.#items.values()) {
      if (item.publish && this.#here(item) && (item.state === 'waiting' || item.state === 'refused' || item.state === 'unknown') && (item.retryAt ?? 0) <= now) void this.#attempt(item)
    }
  }

  /** Send one again now, whatever its back-off says. */
  retry(id: string): void {
    const item = this.#items.get(id)
    if (!item || item.state === 'sending' || item.state === 'moved' || !item.publish) return
    item.retryAt = undefined
    void this.#attempt(item, true)
  }

  /** Stop showing a message. Whether it already reached a relay depends on
   *  its state; the caller says so before asking. */
  dismiss(id: string): PendingSend | undefined {
    const item = this.#items.get(id)
    if (!item || item.state === 'sending') return undefined
    this.#items.delete(id)
    this.#persist(item.roomId)
    this.#opts.onChange()
    return item
  }

  /** Let go of a room's kept messages held in memory, so the room's next
   *  opening restores them with a way to publish through its new session.
   *  One on its way out stays to learn how that ended. */
  release(roomId: string): void {
    for (const item of this.items(roomId)) if (item.durable && item.state !== 'sending' && !item.acknowledged) this.#items.delete(item.id)
  }

  /** The messages a reload left for a room, to be given a way to publish
   *  by `resume`. They are listed straight away, still waiting. */
  restore(roomId: string): PendingSend[] {
    let kept: Kept[] = []
    try { kept = JSON.parse(this.#opts.store.get(PREFIX + roomId) ?? '[]') as Kept[] } catch { /* An unreadable list is an empty one. */ }
    const restored: PendingSend[] = []
    // A message a reload caught on its way out may have arrived: `unknown`.
    for (const k of Array.isArray(kept) ? kept : []) {
      if (!k || typeof k.id !== 'string' || !k.event || this.#items.has(k.id)) continue
      const state: PendingState = k.state === 'moved' ? 'moved' : k.state === 'refused' ? 'refused' : k.state === 'unknown' ? 'unknown' : 'waiting'
      const item: PendingSend = { id: k.id, roomId, channel: k.channel, text: k.text, files: Array.isArray(k.files) ? k.files : [], event: k.event, state, durable: true, attempts: 0 }
      this.#items.set(k.id, item)
      restored.push(item)
    }
    if (restored.length) this.#opts.onChange()
    return restored
  }

  /** Give a restored message its way to publish, and offer it. */
  resume(id: string, publish: () => Promise<void>): void {
    const item = this.#items.get(id)
    if (!item || item.publish) return
    item.publish = publish
    void this.#attempt(item)
  }

  /** A restored message that can no longer go as it stands. */
  strand(id: string): void {
    const item = this.#items.get(id)
    if (!item) return
    item.state = 'moved'
    this.#persist(item.roomId)
    this.#opts.onChange()
  }

  async #attempt(item: PendingSend, asked = false): Promise<void> {
    if (!item.publish || item.state === 'sending' || item.state === 'moved' || this.#items.get(item.id) !== item || !this.#here(item)) return
    // Not offered while nothing can be reached: it stays cleanly unsent,
    // and is tried when a relay is back. An explicit retry tries anyway.
    if (!asked && !this.#opts.connected()) {
      // Checking is cheap and in memory, so look again soon: a message
      // written just after joining should not wait out a back-off.
      item.retryAt = this.#opts.now() + CONNECT_POLL_MS
      this.#schedule(() => this.wake(), CONNECT_POLL_MS)
      return
    }
    item.state = 'sending'
    item.attempts++
    // A reload from here on cannot say it never left.
    this.#persist(item.roomId)
    this.#opts.onChange()
    try {
      await item.publish()
      if (this.#items.get(item.id) !== item) return
      item.acknowledged = true
      // It is on a relay now: a reload has nothing left to send.
      item.durable = false
      this.#persist(item.roomId)
      this.#opts.onChange()
      this.#schedule(() => { if (this.#items.get(item.id) === item) this.arrived([item.id]) }, ECHO_GRACE_MS)
    } catch (error) {
      if (this.#items.get(item.id) !== item) return
      console.error('send failed:', message(error))
      item.state = stateAfter(error)
      this.#persist(item.roomId)
      this.#opts.onChange()
      if (item.state !== 'moved') this.#later(item)
    }
  }

  /** Try again after the back-off, or sooner if `wake` finds a relay. */
  #later(item: PendingSend): void {
    const seconds = RETRY_SECONDS[Math.min(item.attempts, RETRY_SECONDS.length - 1)]!
    item.retryAt = this.#opts.now() + seconds * 1000
    this.#schedule(() => this.wake(), seconds * 1000)
  }

  #schedule(run: () => void, ms: number): void {
    if (this.#opts.schedule) this.#opts.schedule(run, ms)
    else setTimeout(run, ms)
  }

  #persist(roomId: string): void {
    const kept: Kept[] = this.items(roomId).filter(item => item.durable)
      .map(({ id, channel, text, files, event, state }) => ({ id, channel, text, files, event, state: state === 'sending' ? 'unknown' : state }))
      .slice(-MAX_KEPT)
    try {
      if (kept.length) this.#opts.store.set(PREFIX + roomId, JSON.stringify(kept))
      else this.#opts.store.remove(PREFIX + roomId)
    } catch { /* Storage may be unavailable; the message is still held for this visit. */ }
  }
}
