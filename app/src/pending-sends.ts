/**
 * Messages this device has written and no relay has confirmed yet.
 *
 * A message on a bad connection must not vanish into a strip of its own, or
 * be lost by a reload: it waits where it was written, says what it is
 * waiting for, and goes by itself once a relay will take it. The states
 * matter beyond what the row says, because they decide what a later edit
 * or deletion can honestly promise:
 *
 * - `holding`: within the person's chosen moment to take it back after
 *   pressing Send. Nothing has left this device.
 * - `waiting`: never offered to a relay. No connection, or a retry not yet
 *   due after a refusal. Nothing has left this device.
 * - `sending`: offered to the relays, no answer yet.
 * - `refused`: every relay answered no. Nothing was kept anywhere.
 * - `unknown`: no relay answered in time. It may have arrived; a relay's
 *   acknowledgement can be what was lost.
 * - `moved`: the conversation closed or changed its key first. It was
 *   never sent, and never will be as it stands.
 *
 * A message whose files no group computer has taken yet is `waiting` too, and
 * says what for (`storage`): nothing of it has left this device either, so it
 * can still be deleted without a trace. When what stops it cannot change by
 * waiting (this device's clock is wrong, its grants have ended, the only nodes
 * give files to anyone) it is `stuck`: it says so in those words, is not tried
 * again on a timer, and goes only when something about the storage changes
 * (`wakeStorage`) or the person presses Retry.
 *
 * A message the relays refused, or did not answer, is tried again by itself
 * at most `MAX_AUTO_ATTEMPTS` times. After that it stays `refused` or
 * `unknown` and says so, and goes again only when the person presses Retry:
 * a client that resends for ever is what gets an address banned.
 *
 * Every retry publishes the same signed event, so a relay that already has
 * it keeps one copy. A row leaves when its message arrives in the chat, not
 * when a relay acknowledges it, so it never disappears before the message
 * it stands for is on screen.
 *
 * Except after a day. A message is never published by itself once
 * `UNSENT_AUTO_RETRY_LIMIT_SECONDS` have passed since it was written (its
 * `created_at`), whatever asks: a timer, a connection coming back, a room
 * opening again, a reload. It stays, saying it was not sent, and Retry then
 * signs it again as a new event, written now, in place of the old one, which
 * is dropped in the same write and can never go out later (`renew`). A
 * message that cannot be signed again from here says so and offers no Retry.
 * One a relay has acknowledged is sent, and is never signed again.
 *
 * No DOM, so it can be tested without a browser.
 */
import type { Event } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'
import { CONVERSATION_MOVED, type ChatMessage, type SendOptions } from '../../src/chat.js'
import { GROUP_STORAGE_WAITING } from '../../src/group-storage.js'

/** Thrown by a publisher that cannot put a message's files on the group's storage and will not be able to by waiting. Its message is what the row says. */
export class StorageStuckError extends Error {
  constructor(words: string) {
    super(words)
    this.name = 'StorageStuckError'
  }
}
import { MAX_CHAT_ARTWORK, normaliseArtwork, type ChatArtwork } from '../../src/artwork.js'

export type PendingState = 'holding' | 'waiting' | 'sending' | 'refused' | 'unknown' | 'moved'

export interface PendingSend {
  /** The message's own id, which is how it is recognised when it arrives. */
  id: string
  roomId: string
  /** The conversation's label, as the row names it. */
  channel: string
  text: string
  files: string[]
  artwork?: ChatArtwork[]
  event: Event
  state: PendingState
  /** A private publisher is attached; a restored row waits for its room. */
  ready?: boolean
  /** Storage failure holds automatic sending until an explicit retry. */
  held?: boolean
  /** Its files go on the group's own storage before the message goes: what it waits for is a group computer, not a relay, and it is not tried again as long as it cannot be, whatever the page's timers do. */
  storage?: true
  /** Set while a storage problem that waiting will not mend stops it: the words the row shows. */
  stuck?: string
  /** Whether this row is kept across a reload. */
  durable: boolean
  /** A plain new message, which Edit can put back in the message box as it
   *  was. A reply, an edit, a reaction or a message with files is not. */
  editable?: boolean
  attempts: number
  /** When the next automatic attempt is due, in milliseconds. */
  retryAt?: number
  /** While `holding`: when it goes, in milliseconds. */
  holdUntil?: number
  /** A relay acknowledged it; it leaves once the chat shows it. */
  acknowledged?: boolean
  /** It was tried `MAX_AUTO_ATTEMPTS` times without a relay taking it, or it
   *  is past `UNSENT_AUTO_RETRY_LIMIT_SECONDS`: it is not tried again until
   *  the person presses Retry. */
  gaveUp?: boolean
  /** Retry can sign it again as a new message once it is past
   *  `UNSENT_AUTO_RETRY_LIMIT_SECONDS`. */
  renewable?: boolean
}

/** The same message signed again, now, to stand in for an unsent one past
 *  `UNSENT_AUTO_RETRY_LIMIT_SECONDS`. Keeps the old row's room, conversation,
 *  and whether it is kept across a reload. */
export interface RenewedSend {
  id: string
  event: Event
  text: string
  files?: string[]
  artwork?: ChatArtwork[]
  publish: (event: Event) => Promise<void>
}

/** Signs an unsent message again as a new event. `'acknowledged'` when a
 *  relay is now known to have taken the old one (it is sent, and is not
 *  signed again); undefined when nothing was done (the reason already
 *  shown to the person). */
export type RenewSend = (item: PendingSend) => Promise<RenewedSend | 'acknowledged' | undefined>

export type PendingSendInput = Omit<PendingSend, 'state' | 'attempts' | 'retryAt' | 'acknowledged' | 'holdUntil' | 'ready' | 'held' | 'stuck' | 'gaveUp' | 'renewable'> & { publish?: (event: Event) => Promise<void>; renew?: RenewSend }
type PrivatePendingSend = Omit<PendingSend, 'ready' | 'held' | 'renewable'> & { publish?: (event: Event) => Promise<void>; renew?: RenewSend }

export interface PendingSendsOptions {
  store?: DeviceStore
  /** Named async custody; rejection never falls back to the legacy store. */
  storage?: PendingStorage
  onStorageHold?: (error: unknown) => void
  /** Whether a relay can be reached now. A message is not offered to the
   *  relays while this is false, so it stays cleanly unsent. */
  connected: () => boolean
  now?: () => number
  onChange?: () => void
  /** A relay acknowledged this message. Not that it was kept: see `delivery-state.ts`. */
  onAcknowledged?: (item: PendingSend) => void
  /** The room open now. A message is only offered from its own room: one
   *  left behind in another waits, kept, until that room is open again. */
  active?: () => string | undefined
  /** For tests: replaces setTimeout. */
  schedule?: (run: () => void, ms: number) => void
}

export interface PendingStorage {
  load(roomId: string): Promise<{ durable: string | null; transient: string | null }>
  /** Retain both classes before acknowledgement. Transient sends belong to
   * encrypted tab custody; they must not become a successful empty write. */
  retain(roomId: string, durable: string | null, transient: string | null): Promise<void>
}

/** Seconds before each automatic retry, the last repeating. */
export const RETRY_SECONDS = [5, 15, 30, 60]
/** Attempts a message gets by itself; after these, only Retry sends it. */
export const MAX_AUTO_ATTEMPTS = 8
/** How often a message waiting for a connection looks for one. */
export const CONNECT_POLL_MS = 1_000
/**
 * How long after it was written (its `created_at`) an unsent message may
 * still be published by itself, as the event it was. After this only Retry
 * sends it, signed again as a new event. Android's chat catch-up after a
 * relay reconnect asks each relay from the last `created_at` it saw minus a
 * skew, and that skew depends on this: no event of ours reaches a relay
 * later than this after its `created_at`. Raise it and the skew must grow.
 */
export const UNSENT_AUTO_RETRY_LIMIT_SECONDS = 24 * 60 * 60
const PREFIX = 'kithmoot.pending.'
/** A reload keeps this many unsent messages a room, newest last. */
export const MAX_KEPT = 50

const REFUSED = /every relay rejected the event/
const UNANSWERED = /no relay could be reached in time/

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a failed publish says about where the event went. */
export function stateAfter(error: unknown): PendingState {
  const text = message(error)
  if (text === CONVERSATION_MOVED) return 'moved'
  // Not a relay's answer: no group computer has the files yet. Nothing has left, so it stays Delete-able.
  if (text === GROUP_STORAGE_WAITING || error instanceof StorageStuckError) return 'waiting'
  if (REFUSED.test(text) && !UNANSWERED.test(text)) return 'refused'
  return 'unknown'
}

export interface KeptPendingSend { id: string; channel: string; text: string; files: string[]; artwork?: ChatArtwork[]; event: Event; state: PendingState; editable?: boolean }

/** Whether an unsent message is past `UNSENT_AUTO_RETRY_LIMIT_SECONDS` and
 *  may no longer be published as the event it was. `now` in milliseconds. */
export function pastAutoRetryLimit(item: { event: Pick<Event, 'created_at'>; acknowledged?: boolean }, now: number): boolean {
  return !item.acknowledged && Math.floor(now / 1000) - item.event.created_at >= UNSENT_AUTO_RETRY_LIMIT_SECONDS
}

/** What a message asked for beyond its text, so that it can be signed again
 *  as a new message saying the same: the same reply, files, stickers,
 *  mentions, edit, retraction or reaction. Undefined for one that is more
 *  than a message (an invitation, a room logo, shared work), which is not
 *  signed again from here. */
export function renewOptions(message: ChatMessage): SendOptions | undefined {
  if (message.invite !== undefined || message.roomLogo !== undefined || message.assignment !== undefined) return undefined
  const opts: SendOptions = {}
  if (message.reaction) opts.reaction = message.reaction
  if (message.kind === 'transcript' && message.speaker) opts.transcriptOf = message.speaker
  else if (message.kind === 'directive') opts.directive = true
  if (message.attachments?.length) opts.attachments = message.attachments
  if (message.artwork?.length) opts.artwork = message.artwork
  // `prepare` keeps the thread it is given, so the answer stays in the same one.
  if (message.reply) opts.replyTo = { id: message.reply.messageId, participant: message.reply.participant, ...(message.thread ? { thread: message.thread } : {}) }
  if (message.replaces !== undefined) opts.replaces = message.replaces
  if (message.retracts !== undefined) opts.retracts = message.retracts
  if (message.mentions?.length) opts.mentions = message.mentions
  return opts
}

/** States in which nothing of the message has reached any relay, so taking
 *  it back leaves no trace. */
export function neverLeft(item: PendingSend): boolean {
  return !item.acknowledged && (item.state === 'holding' || item.state === 'waiting' || item.state === 'refused' || item.state === 'moved')
}

export class PendingSends {
  readonly #items = new Map<string, PrivatePendingSend>()
  readonly #opts: PendingSendsOptions & { now: () => number; onChange: () => void }
  readonly #storage: PendingStorage
  readonly #versions = new Map<string, number>()
  readonly #attempting = new Map<string, Promise<void>>()
  readonly #blocked = new Set<string>()
  readonly #renewing = new Set<string>()
  #writes: Promise<void> = Promise.resolve()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  #closed = false

  constructor(opts: PendingSendsOptions) {
    if (!!opts.store === !!opts.storage) throw new Error('choose exactly one pending-message storage owner')
    this.#opts = { now: () => Date.now(), onChange: () => {}, ...opts }
    this.#storage = opts.storage ?? {
      load: async room => ({ durable: opts.store!.get(PREFIX + room), transient: null }),
      retain: async (room, encoded) => { if (encoded === null) opts.store!.remove(PREFIX + room); else opts.store!.set(PREFIX + room, encoded) },
    }
  }
  #version(room: string): number { return this.#versions.get(room) ?? 0 }
  #check(room: string, version: number): void {
    if (this.#closed || this.#version(room) !== version) throw new Error(CONVERSATION_MOVED)
  }
  #here(item: PrivatePendingSend): boolean { return !this.#closed && (!this.#opts.active || this.#opts.active() === item.roomId) }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(work)
    this.#writes = result.then(() => {}, () => {})
    return result
  }
  /** Only acknowledged snapshots enter the active map. Keep stable item
   * references for the outbox; no timer can publish a provisional candidate. */
  #change(room: string, work: (items: Map<string, PrivatePendingSend>) => boolean, version = this.#version(room)): Promise<void> {
    return this.#serial(async () => {
      this.#check(room, version)
      const candidate = new Map(this.#privateItems(room).map(item => [item.id, { ...item }]))
      if (!work(candidate)) return
      const encode = (durable: boolean): string | null => {
        const kept: KeptPendingSend[] = [...candidate.values()].filter(item => !item.acknowledged && item.durable === durable)
        .map(({ id, channel, text, files, artwork, event, state, editable }) => ({ id, channel, text, files,
          ...(artwork?.length ? { artwork } : {}), event, state: state === 'sending' ? 'unknown' : state === 'holding' ? 'waiting' : state,
          ...(editable ? { editable: true } : {}) }))
        return kept.length ? JSON.stringify(kept) : null
      }
      if ([...candidate.values()].filter(item => !item.acknowledged).length > MAX_KEPT) throw new Error('pending-message storage is full')
      await this.#storage.retain(room, encode(true), encode(false))
      this.#check(room, version)
      for (const old of this.#privateItems(room)) if (!candidate.has(old.id)) this.#items.delete(old.id)
      for (const [id, item] of candidate) {
        const old = this.#items.get(id)
        if (old) Object.assign(old, item)
        else this.#items.set(id, item)
      }
      this.#notify()
    })
  }
  #notify(): void { try { this.#opts.onChange() } catch { /* Rendering is not a custody receipt. */ } }
  #privateItems(roomId?: string): PrivatePendingSend[] { return [...this.#items.values()].filter(item => roomId === undefined || item.roomId === roomId) }
  #snapshot(item: PrivatePendingSend): PendingSend {
    const { publish, renew, ...value } = item
    const snapshot = structuredClone({ ...value, ready: !!publish, held: this.#blocked.has(item.id), ...(renew ? { renewable: true } : {}) })
    for (const tag of snapshot.event.tags) Object.freeze(tag)
    Object.freeze(snapshot.event.tags); Object.freeze(snapshot.event); Object.freeze(snapshot.files)
    for (const art of snapshot.artwork ?? []) Object.freeze(art)
    if (snapshot.artwork) Object.freeze(snapshot.artwork)
    return Object.freeze(snapshot)
  }
  #past(item: PrivatePendingSend): boolean { return pastAutoRetryLimit(item, this.#opts.now()) }
  /** Past the limit: never published by itself again. Said once, not on every look. */
  #expire(item: PrivatePendingSend): void {
    if (item.gaveUp && item.retryAt === undefined) return
    item.gaveUp = true; item.retryAt = undefined; this.#notify()
  }
  #hold(error: unknown): void { try { this.#opts.onStorageHold?.(error) } catch { /* The hold cannot be waived by an observer. */ } }
  items(roomId?: string): PendingSend[] { return this.#privateItems(roomId).map(item => this.#snapshot(item)) }
  get pending(): boolean { return this.#items.size > 0 }
  get holding(): boolean { return [...this.#items.values()].some(item => item.state === 'holding') }

  /** Return only after custody acknowledges the exact prepared event. */
  async add(input: PendingSendInput, holdMs = 0): Promise<void> {
    const item: PrivatePendingSend = { ...input, files: [...input.files], event: structuredClone(input.event),
      ...(input.artwork ? { artwork: structuredClone(input.artwork) } : {}), state: holdMs > 0 ? 'holding' : 'waiting', attempts: 0 }
    if (holdMs > 0) item.holdUntil = this.#opts.now() + holdMs
    await this.#change(item.roomId, items => { if (this.#items.has(item.id)) throw new Error('pending message already exists'); items.set(item.id, item); return true })
    const installed = this.#items.get(item.id)!
    try {
      if (holdMs > 0) this.#schedule(() => { void this.#release(installed).catch(error => this.#hold(error)) }, Math.max(0, installed.holdUntil! - this.#opts.now()))
      else void this.#attempt(installed)
    } catch (error) { this.#hold(error) }
  }
  async #release(item: PrivatePendingSend): Promise<void> {
    if (this.#items.get(item.id) !== item) return
    await this.#change(item.roomId, items => {
      const saved = items.get(item.id); if (!saved || saved.state !== 'holding') return false
      saved.state = 'waiting'; saved.holdUntil = undefined; return true
    })
    if (this.#items.get(item.id) === item) void this.#attempt(item)
  }
  async arrived(ids: Iterable<string>): Promise<void> {
    const selected = new Set(ids), rooms = new Set(this.items().filter(item => selected.has(item.id)).map(item => item.roomId))
    // Separate custody owners cannot atomically change both partitions.
    // Independent arrivals can acknowledge one class before the other holds.
    for (const room of rooms) for (const durable of [true, false]) await this.#change(room, items => {
      let changed = false
      for (const [id, item] of items) if (selected.has(id) && item.durable === durable) changed = items.delete(id) || changed
      return changed
    })
  }
  wake(): void {
    const now = this.#opts.now()
    for (const item of this.#items.values()) if (!this.#blocked.has(item.id) && item.publish && this.#here(item) && !item.stuck && !item.gaveUp &&
      (item.state === 'waiting' || item.state === 'refused' || item.state === 'unknown') && (item.retryAt ?? 0) <= now) void this.#attempt(item)
  }
  /** A grant or a node list arrived: messages waiting on the group's storage try again now, not at their next turn, and one that a storage problem had stopped gets another look. */
  wakeStorage(): void {
    for (const item of this.#items.values()) if (item.storage) { item.retryAt = undefined; item.stuck = undefined }
    this.wake()
  }
  /** Resolves once an attempt to send this message that is in flight has ended, however it ended. */
  settled(id: string): Promise<void> {
    return this.#attempting.get(id) ?? Promise.resolve()
  }
  async retry(id: string): Promise<void> {
    const item = this.#items.get(id)
    if (!item || item.state === 'sending' || item.state === 'moved') return
    // Past the limit the old event never goes, even when asked: Retry signs it again.
    if (this.#past(item)) { await this.#renew(item); return }
    if (!item.publish) return
    this.#blocked.delete(id)
    if (item.state === 'holding') { await this.#release(item); return }
    item.retryAt = undefined
    // Retry starts the count again: the person asked for it.
    item.gaveUp = undefined; item.attempts = 0
    await this.#attempt(item, true)
  }
  /** Sign a message past the limit again, now, and put the new event in the
   *  old one's place in a single write, so neither a crash nor a reload can
   *  lose it or leave both. The old event is never published afterwards. */
  async #renew(item: PrivatePendingSend): Promise<void> {
    if (!item.renew || item.acknowledged || this.#renewing.has(item.id) || this.#attempting.has(item.id)) return
    const version = this.#version(item.roomId)
    const unchanged = (): boolean => !this.#closed && this.#version(item.roomId) === version && this.#items.get(item.id) === item &&
      !item.acknowledged && item.state !== 'sending' && item.state !== 'moved' && !this.#attempting.has(item.id)
    this.#renewing.add(item.id)
    let fresh: RenewedSend | 'acknowledged' | undefined
    try { fresh = await item.renew(this.#snapshot(item)) } finally { this.#renewing.delete(item.id) }
    if (!fresh || !unchanged()) return
    if (fresh === 'acknowledged') {
      // A relay took the old event after all: it is sent, as it was.
      await this.#change(item.roomId, items => {
        const saved = items.get(item.id); if (!saved || saved.acknowledged) return false
        // As a publish that a relay acknowledged leaves it.
        saved.state = 'sending'; saved.acknowledged = true; saved.durable = false; saved.gaveUp = undefined; saved.retryAt = undefined; return true
      }, version)
      if (this.#items.get(item.id) === item && item.acknowledged) { try { this.#opts.onAcknowledged?.(this.#snapshot(item)) } catch { /* Rendering is not a custody receipt. */ } }
      return
    }
    if (!fresh.id || fresh.id === item.id || fresh.event.id === item.event.id || this.#items.has(fresh.id)) throw new Error('a message signed again must be a new message')
    const next: PrivatePendingSend = { id: fresh.id, roomId: item.roomId, channel: item.channel, text: fresh.text, files: [...(fresh.files ?? item.files)],
      ...(fresh.artwork?.length ? { artwork: structuredClone(fresh.artwork) } : {}), event: structuredClone(fresh.event), state: 'waiting', attempts: 0,
      durable: item.durable, ...(item.editable ? { editable: true } : {}), publish: fresh.publish, renew: item.renew }
    await this.#change(item.roomId, items => {
      const saved = items.get(item.id)
      if (!saved || saved.acknowledged || saved.state === 'sending' || saved.state === 'moved' || items.has(next.id)) return false
      items.delete(item.id); items.set(next.id, next); return true
    }, version)
    const installed = this.#items.get(next.id)
    if (!installed || this.#items.has(item.id)) return
    this.#blocked.delete(item.id)
    await this.#attempt(installed, true)
  }
  async dismiss(id: string): Promise<PendingSend | undefined> {
    const old = this.#items.get(id); if (!old) return undefined
    let removed = false
    await this.#change(old.roomId, items => {
      const item = items.get(id); if (!item || item.state === 'sending' || this.#attempting.has(id)) return false
      removed = items.delete(id); return removed
    })
    if (removed) { this.#blocked.delete(id); return this.#snapshot(old) }
    return undefined
  }
  async take(id: string): Promise<PendingSend | undefined> {
    const item = this.#items.get(id); if (!item || !neverLeft(item)) return undefined
    return this.dismiss(id)
  }
  /** Revoke old callbacks immediately; queued native work may finish custody
   * but cannot reinstall an old item or start its publisher. */
  release(roomId: string): void {
    if (!this.#versions.has(roomId) && this.#versions.size >= 4096) throw new Error('pending-message room fencing is full')
    this.#versions.set(roomId, this.#version(roomId) + 1)
    for (const item of this.#privateItems(roomId)) {
      this.#items.delete(item.id); this.#blocked.delete(item.id); this.#attempting.delete(item.id)
    }
  }
  async restore(roomId: string): Promise<PendingSend[]> {
    const version = this.#version(roomId)
    return this.#serial(async () => {
      this.#check(roomId, version)
      if (this.#privateItems(roomId).length) throw new Error('release the room before restoring pending messages')
      const encoded = await this.#storage.load(roomId)
      this.#check(roomId, version)
      const durable: unknown = JSON.parse(encoded.durable ?? '[]'), transient: unknown = JSON.parse(encoded.transient ?? '[]')
      if (!Array.isArray(durable) || !Array.isArray(transient)) throw new Error('pending-message storage is unreadable')
      const kept = [...durable.map(value => ({ value, durable: true })), ...transient.map(value => ({ value, durable: false }))]
      if (kept.length > MAX_KEPT || new Set(kept.map(k => k.value?.id)).size !== kept.length) throw new Error('pending-message storage is unreadable')
      const restored: PrivatePendingSend[] = []
      const now = this.#opts.now()
      for (const entry of kept) {
        const k = entry.value
        if (!k || typeof k.id !== 'string' || !k.id || typeof k.channel !== 'string' || typeof k.text !== 'string' ||
          !Array.isArray(k.files) || k.files.some((file: unknown) => typeof file !== 'string') || !k.event || typeof k.event.id !== 'string' || !k.event.id ||
          typeof k.event.content !== 'string' || typeof k.event.pubkey !== 'string' || typeof k.event.sig !== 'string' ||
          !Number.isSafeInteger(k.event.kind) || k.event.kind < 0 || !Number.isSafeInteger(k.event.created_at) || k.event.created_at < 0 ||
          !Array.isArray(k.event.tags) || k.event.tags.some((tag: unknown) => !Array.isArray(tag) || tag.some(value => typeof value !== 'string')) ||
          !['waiting','refused','unknown','moved','sending','holding'].includes(k.state)) throw new Error('pending-message storage is unreadable')
        const existing = this.#items.get(k.id)
        if (existing && existing.roomId !== roomId) throw new Error('pending-message storage conflicts with another room')
        const state: PendingState = k.state === 'moved' ? 'moved' : k.state === 'refused' ? 'refused' : k.state === 'unknown' || k.state === 'sending' ? 'unknown' : 'waiting'
        const artwork = k.artwork === undefined ? [] : Array.isArray(k.artwork) && k.artwork.length <= MAX_CHAT_ARTWORK ? k.artwork.map(normaliseArtwork) : undefined
        if (!artwork || artwork.some((art: unknown) => !art)) throw new Error('pending-message storage is unreadable')
        if (existing) continue
        restored.push({ id: k.id, roomId, channel: k.channel, text: k.text, files: [...k.files], event: structuredClone(k.event), state, durable: entry.durable, attempts: 0,
          ...(k.editable === true ? { editable: true } : {}), ...(artwork.length ? { artwork } : {}),
          // Kept by any build, it is past the limit if its own time says so: it never goes by itself again.
          ...(pastAutoRetryLimit(k, now) ? { gaveUp: true } : {}) })
      }
      for (const item of restored) this.#items.set(item.id, item)
      if (restored.length) this.#notify()
      return restored.map(item => this.#snapshot(item))
    })
  }
  /** Attach a restored message's publisher, and what can sign it again once
   *  it is past the limit. Past the limit, it is not published. */
  resume(id: string, publish: (event: Event) => Promise<void>, renew?: RenewSend): void {
    const item = this.#items.get(id); if (!item || item.publish || this.#closed) return
    item.publish = publish
    if (renew) item.renew = renew
    this.#notify(); void this.#attempt(item)
  }
  async strand(id: string): Promise<void> {
    const item = this.#items.get(id); if (!item) return
    await this.#change(item.roomId, items => { const saved = items.get(id); if (!saved) return false; saved.state = 'moved'; return true })
  }
  #attempt(item: PrivatePendingSend, asked = false): Promise<void> {
    try {
    const existing = this.#attempting.get(item.id); if (existing) return existing
    if (!item.publish || item.state === 'holding' || item.state === 'sending' || item.state === 'moved' ||
      this.#items.get(item.id) !== item || !this.#here(item) || this.#blocked.has(item.id)) return Promise.resolve()
    // From every path, timer, wake, reload or Retry alike: past the limit the old event never goes.
    if (this.#past(item)) { this.#expire(item); return Promise.resolve() }
    if (!asked && !this.#opts.connected()) {
      item.retryAt = this.#opts.now() + CONNECT_POLL_MS; this.#scheduleRetry(item, CONNECT_POLL_MS); return Promise.resolve()
    }
    const version = this.#version(item.roomId)
    const work = this.#send(item, version).catch(error => {
      if (this.#closed || this.#version(item.roomId) !== version || this.#items.get(item.id) !== item) return
      if (item.state === 'sending') item.state = 'unknown'
      this.#blocked.add(item.id); this.#notify(); this.#hold(error)
    })
    this.#attempting.set(item.id, work)
    void work.finally(() => { if (this.#attempting.get(item.id) === work) this.#attempting.delete(item.id) }).catch(() => {})
    return work
    } catch (error) { this.#hold(error); return Promise.resolve() }
  }
  async #send(item: PrivatePendingSend, version: number): Promise<void> {
    let going = false
    await this.#change(item.roomId, items => {
      const saved = items.get(item.id); if (!saved || saved.state === 'moved') return false
      // Checked again at the last moment before it goes: saving can take time.
      if (pastAutoRetryLimit(saved, this.#opts.now())) return false
      saved.state = 'sending'; saved.attempts++; saved.stuck = undefined; going = true; return true
    }, version)
    this.#check(item.roomId, version)
    if (this.#items.get(item.id) !== item || !this.#here(item)) return
    if (!going) { if (this.#past(item)) this.#expire(item); return }
    let error: unknown, failed = false
    try { await item.publish!(structuredClone(item.event)) } catch (caught) { failed = true; error = caught }
    this.#check(item.roomId, version)
    await this.#change(item.roomId, items => {
      const saved = items.get(item.id); if (!saved) return false
      if (failed) {
        saved.state = stateAfter(error)
        saved.stuck = error instanceof StorageStuckError ? error.message : undefined
        if (saved.stuck !== undefined) saved.retryAt = undefined
      } else { saved.acknowledged = true; saved.durable = false; saved.stuck = undefined }
      return true
    }, version)
    if (!failed && this.#items.get(item.id) === item) { try { this.#opts.onAcknowledged?.(this.#snapshot(item)) } catch { /* Rendering is not a custody receipt. */ } }
    // A problem that waiting will not mend is not tried again on a timer.
    if (failed && this.#items.get(item.id) === item && item.state !== 'moved' && item.stuck === undefined) this.#later(item)
  }
  #later(item: PrivatePendingSend): void {
    // Only a relay's refusal or silence counts towards giving up: a message
    // waiting on the group's storage is not offered to a relay at all.
    if (item.attempts >= MAX_AUTO_ATTEMPTS && (item.state === 'refused' || item.state === 'unknown')) {
      item.gaveUp = true; item.retryAt = undefined; this.#notify(); return
    }
    const seconds = RETRY_SECONDS[Math.min(item.attempts, RETRY_SECONDS.length - 1)]!
    item.retryAt = this.#opts.now() + seconds * 1000; this.#scheduleRetry(item, seconds * 1000)
  }
  /** A timer can run before the wall clock reports its deadline. Keep the
   * remaining wait without releasing a held or superseded custody owner. */
  #scheduleRetry(item: PrivatePendingSend, ms: number): void {
    this.#schedule(() => {
      if (this.#items.get(item.id) !== item || !this.#here(item) || !item.publish || this.#blocked.has(item.id) || item.gaveUp ||
          (item.state !== 'waiting' && item.state !== 'refused' && item.state !== 'unknown')) return
      // Past the limit a connection poll does not spin on it every second.
      if (this.#past(item)) { this.#expire(item); return }
      const remaining = (item.retryAt ?? 0) - this.#opts.now()
      if (remaining > 0) this.#scheduleRetry(item, remaining)
      else void this.#attempt(item)
    }, ms)
  }
  #schedule(run: () => void, ms: number): void {
    const guarded = () => { if (!this.#closed) run() }
    if (this.#opts.schedule) this.#opts.schedule(guarded, ms)
    else { const timer = setTimeout(() => { this.#timers.delete(timer); guarded() }, ms); this.#timers.add(timer) }
  }
  /** Native writes join; a remote publish that has not settled cannot delay
   * immediate revocation or make a closed queue release another effect. */
  async close(): Promise<void> {
    this.#closed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear(); this.#items.clear(); this.#blocked.clear(); this.#attempting.clear()
    await this.#writes
  }
}
