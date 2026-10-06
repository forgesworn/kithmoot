/** Private, per-room Nostr bookmarks. Never uploads the visitor's history.
 * Random addressable identifiers keep room ids out of public tags. Separate
 * records prevent two devices saving different rooms from overwriting a list.
 * Encrypted tombstones prevent an older relay copy resurrecting a removal.
 *
 * A record may also carry `admission`: the room secret of a group this
 * account is already a member of, so a new device opens the room without
 * the group's signed invitation, which public relays drop after a day or
 * two. It sits beside `room`, not inside it, and is encrypted to the
 * account's own key with the rest of the record. The cost, stated plainly:
 * a relay may keep an old copy of a replaceable record, so a tombstone no
 * longer removes the secret from every relay, only from the record the
 * account reads. Only the account's signer can decrypt it.
 */
import type { SignetSigner } from 'signet-login'
import type { Event } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import type { RelayTransport } from '../../src/relay-pool.js'
import { verifyEventUncached } from '../../src/verify.js'
import { memoryDeviceStore, type DeviceStore } from './device-store.js'
import { ROOM_PREFIX, rememberRoom, forgetRoom, type KnownRoom } from './rooms-store.js'
import { deriveRoom } from '../../src/room.js'

const APP = 'kithmoot.rooms.v1'
const KIND = 30078
/** Signer requests in flight at once, and how many refusals in a row end a
 *  lookup's asking until the person retries. A remote signer is reached over
 *  the same relays that carry the bookmarks, and they rate-limit a burst. */
const DECRYPT_CONCURRENCY = 3
const REFUSAL_LIMIT = 3
/** The room secret, hex, of a group the account belongs to. */
interface RecordAdmission { secret: string }
interface RecordValue { roomId: string; at: number; room?: KnownRoom; admission?: RecordAdmission }
/** How a bookmark's admission meets this device's own kept memberships.
 *  `current` is what to attach when saving a room; `adopt` takes in a secret
 *  that arrived with a bookmark, and must not overwrite one already kept. */
export interface BookmarkAdmissions {
  current(room: KnownRoom): string | undefined
  adopt(room: KnownRoom, secret: string): void
}
const SECRET_HEX = /^[0-9a-f]{64}$/
/** An admission is kept only when the secret it names is the room's own. */
function validAdmission(value: unknown, roomId: string): RecordAdmission | undefined {
  const secret = (value as RecordAdmission | undefined)?.secret
  if (typeof secret !== 'string' || !SECRET_HEX.test(secret)) return undefined
  try { return deriveRoom(hexToBytes(secret)).roomId === roomId ? { secret } : undefined } catch { return undefined }
}
/** `event` is the signed copy, kept so a record a relay has lost can be put
 *  back exactly as it was, without the signer. Absent on older caches. It
 *  costs about a kilobyte a room in this browser's storage. */
interface RecordEntry extends RecordValue { d: string; id: string; event?: Event }
interface Pending { value: RecordValue; d: string; event?: Event }

/** Match NIP-01 replacement: whole seconds, then the lowest event id. */
function newer(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
  const seconds = Math.floor(a.at / 1000) - Math.floor(b.at / 1000)
  return seconds > 0 || (seconds === 0 && a.id < b.id)
}

/** Only bookmark metadata is account-scoped; admissions stay device-local. */
export function accountRoomStore(store: DeviceStore, pubkey: string): DeviceStore {
  const prefix = `kithmoot.account.${pubkey}.`
  const keyFor = (key: string) => key.startsWith(ROOM_PREFIX) ? prefix + key : key
  return {
    get: key => store.get(keyFor(key)),
    set: (key, value) => store.set(keyFor(key), value),
    remove: key => store.remove(keyFor(key)),
    keys: () => store.keys().filter(key => key.startsWith(prefix + ROOM_PREFIX)).map(key => key.slice(prefix.length)),
  }
}

export class RoomBookmarks {
  readonly rooms: DeviceStore
  #records = new Map<string, RecordEntry>()
  #pending = new Map<string, Pending>()
  #closed = false
  #busy = false
  /** Counts the outcomes a save has reported. A lookup carries the count it
   *  was armed with, so a relay that answers late cannot replace a newer
   *  save's outcome with news of a lookup that started before it. */
  #reports = 0
  #off?: () => void
  #prefix: string
  /** Bookmark events the signer is being asked about. Every relay sends its
   *  own copy of a bookmark, and a remote signer answers each request over
   *  those same relays, so a copy must not become another request. */
  #decrypting = new Set<string>()
  /** Bookmark events the signer could not decrypt. Not asked again until an
   *  explicit retry, so a refusing signer is not hammered on every
   *  reconnect. */
  #undecryptable = new Set<string>()
  /** Decryptions in a row the signer has refused, reset by any success. */
  #refusals = 0
  #active = 0
  #queued: Array<() => void> = []
  /** The newest copy of each record, by `d`, that any relay returned in the
   *  current lookup, in whole seconds. A pool passes on only the first copy
   *  of an event, so this says a record is somewhere, never where. */
  #seen = new Map<string, number>()
  /** Records already put back this session, by `d`, so a relay that keeps
   *  refusing one is not sent it again on every reconnect. */
  #repaired = new Set<string>()
  /** The next lookup's end puts back lost records even when it found none:
   *  an explicit retry is the person asking for exactly that. */
  #forceRepair = false
  /** Records the current repair is putting back. */
  #repairing = 0
  constructor(
    private store: DeviceStore,
    private signer: SignetSigner,
    private relay: RelayTransport,
    private changed: () => void,
    private status: (message: string) => void,
    private admissions?: BookmarkAdmissions,
  ) {
    this.rooms = accountRoomStore(store, signer.pubkey)
    this.#prefix = `kithmoot.bookmarks.${signer.pubkey}.`
    for (const key of store.keys().filter(key => key.startsWith(this.#prefix))) {
      try {
        const saved = JSON.parse(store.get(key)!) as { record?: RecordEntry; pending?: Pending }
        if (saved.record) this.#records.set(saved.record.roomId, saved.record)
        if (saved.pending) this.#pending.set(saved.pending.value.roomId, saved.pending)
      } catch { /* A broken cache must not stop sign-in. */ }
    }
  }

  start(): void {
    if (!this.signer.nip44) {
      this.status('Rooms are saved for this account in this browser only: this signer does not support NIP-44 encryption.')
      return
    }
    this.status(this.#pending.size ? 'Some room changes are not synced. Retry when your signer and relays are available.' : 'Looking for your encrypted room bookmarks. Relay availability determines what can be restored.')
    this.#off?.()
    this.#seen.clear()
    const armed = this.#reports
    this.#off = this.relay.subscribe([{ kinds: [KIND], authors: [this.signer.pubkey], '#l': [APP] }], event => {
      void this.receive(event)
    }, () => {
      if (this.#closed) return
      if (this.#repair()) return
      // The end of a lookup is not news once a save started after it has
      // reported: a reconnecting relay can take seconds to answer, and this
      // weaker message would hide the confirmation the person waited for.
      if (!this.#pending.size && this.#reports === armed) this.status(this.#upToDate())
    })
  }

  async receive(event: Event): Promise<void> {
    if (this.#closed || event.kind !== KIND || event.pubkey !== this.signer.pubkey ||
        event.content.length > 60_000 || !verifyEventUncached(event) ||
        !event.tags.some(t => t[0] === 'l' && t[1] === APP)) return
    const d = event.tags.find(t => t[0] === 'd')?.[1]
    if (!d || !/^kithmoot\.rooms\.v1\.[0-9a-f-]{36}$/.test(d)) return
    this.#seen.set(d, Math.max(this.#seen.get(d) ?? 0, event.created_at))
    // Returning on the same browser does not need another signer prompt
    // for an event already decrypted into this account's local cache.
    const cached = [...this.#records.values()].find(record => record.id === event.id)
    if (cached) {
      // An older cache learns the signed copy, so it can be put back later.
      if (!cached.event) { cached.event = event; this.#persist(cached.roomId) }
      return
    }
    if (this.#decrypting.has(event.id) || this.#undecryptable.has(event.id)) return
    this.#decrypting.add(event.id)
    try {
      const plaintext = await this.#decrypt(event)
      if (plaintext === undefined) return
      const value = JSON.parse(plaintext) as RecordValue
      if (this.#closed || !/^[0-9a-f]{64}$/.test(value.roomId) || !Number.isSafeInteger(value.at) ||
          Math.floor(value.at / 1000) !== event.created_at || event.created_at > Date.now() / 1000 + 60) return
      if (value.room) {
        if (value.room.roomId !== value.roomId) return
        // Validate links and names through the same rules as local visits.
        value.room = rememberRoom(memoryDeviceStore(), value.room)
      }
      const admission = value.room ? validAdmission(value.admission, value.roomId) : undefined
      if (admission) value.admission = admission; else delete value.admission
      const incoming: RecordEntry = { ...value, d, id: event.id, event }
      const previous = this.#records.get(value.roomId)
      if (previous && !newer(incoming, previous)) return
      const pending = this.#pending.get(value.roomId)
      this.#records.set(value.roomId, incoming)
      // A relay returning the very event still pending means it arrived after
      // the publish gave up waiting: it is no longer pending.
      if (pending && (pending.event ? pending.event.id === event.id || newer(incoming, { at: pending.value.at, id: pending.event.id })
        : Math.floor(value.at / 1000) > Math.floor(pending.value.at / 1000))) this.#pending.delete(value.roomId)
      if (!this.#pending.has(value.roomId)) this.#apply(value)
      if (value.room && admission) try { this.admissions?.adopt(value.room, admission.secret) } catch { /* The room still lists; only the way back in goes unwritten. */ }
      this.#persist(value.roomId)
      this.changed()
      if (!this.#pending.size) this.status('Encrypted room bookmarks loaded. Opening a room may still need an online member to let this device in.')
    } catch { /* Unreadable, malformed or foreign data never reaches the UI. */ }
    finally { this.#decrypting.delete(event.id) }
  }

  /** One decryption, with a few at a time. Undefined when it was skipped
   *  or the signer would not do it. */
  async #decrypt(event: Event): Promise<string | undefined> {
    if (this.#active < DECRYPT_CONCURRENCY) this.#active++
    else await new Promise<void>(resolve => this.#queued.push(resolve))
    try {
      if (this.#closed) return undefined
      if (this.#refusals >= REFUSAL_LIMIT) { this.#undecryptable.add(event.id); return undefined }
      try {
        const plaintext = await this.signer.nip44!.decrypt(this.signer.pubkey, event.content)
        this.#refusals = 0
        return plaintext
      } catch {
        this.#undecryptable.add(event.id)
        if (++this.#refusals === REFUSAL_LIMIT && !this.#closed) this.#report('Your signer refused to decrypt your room bookmarks. Allow NIP-44 decryption for KithMoot in your signer, then retry room sync.')
        return undefined
      }
    } finally {
      const next = this.#queued.shift()
      if (next) next(); else this.#active--
    }
  }

  save(room: KnownRoom): void {
    const previous = this.#pending.get(room.roomId)?.value ?? this.#records.get(room.roomId)
    // Keep the secret a record already carries when this device has none of
    // its own: a save from a device that lacks it must not drop it.
    const secret = this.admissions?.current(room) ?? previous?.admission?.secret
    if (previous?.room?.link === room.link && previous.room.name === room.name && previous.admission?.secret === secret) return
    this.#queue({ roomId: room.roomId, at: Date.now(), room, ...(secret ? { admission: { secret } } : {}) })
  }

  remove(roomId: string): void {
    this.#queue({ roomId, at: Date.now() })
  }

  /**
   * Remove a room and wait for a relay to accept the tombstone. Resolves
   * with the tombstone's `d`, or undefined when none was accepted in time,
   * or when this signer cannot sync bookmarks at all.
   */
  async removeAndConfirm(roomId: string, timeoutMs = 20_000): Promise<string | undefined> {
    this.remove(roomId)
    const pending = this.#pending.get(roomId)
    if (!pending) return undefined
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.#closed) {
      if (this.#pending.get(roomId) !== pending) {
        const record = this.#records.get(roomId)
        return record && !record.room && record.d === pending.d ? record.d : undefined
      }
      if (!this.signer.nip44) return undefined
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return undefined
  }

  /** Forget this browser's copy of a room's bookmark record, tombstone
   *  included. Only for a room being tidied away entirely. */
  dropLocalRecord(roomId: string): void {
    this.#records.delete(roomId)
    this.#pending.delete(roomId)
    this.store.remove(this.#prefix + roomId)
  }

  #queue(value: RecordValue): void {
    if (this.#closed) return
    // Only bookmark fields travel. Read positions, device credentials and
    // the choice to keep an admission never follow an account.
    if (value.room) {
      // A conference room's end travels too, so the list on another device
      // shows the room ended without having to open it.
      const { roomId, link, name, openedAt, endsAt } = value.room
      value.room = { roomId, link, name, openedAt, readAt: 0, ...(endsAt !== undefined ? { endsAt } : {}) }
    }
    // Addressable-event replacement is ordered in whole seconds. A later
    // edit must not lose to the earlier event's id when both happen in one.
    value.at = Math.max(value.at, (Math.floor((this.#records.get(value.roomId)?.at ?? 0) / 1000) + 1) * 1000,
      (Math.floor((this.#pending.get(value.roomId)?.value.at ?? 0) / 1000) + 1) * 1000)
    const d = this.#records.get(value.roomId)?.d ?? this.#pending.get(value.roomId)?.d ?? `${APP}.${crypto.randomUUID()}`
    this.#pending.set(value.roomId, { value, d })
    this.#apply(value)
    this.#persist(value.roomId)
    this.changed()
    void this.retry()
  }

  /**
   * Put back this account's records the relays have lost, once a session.
   * Relays drop events, and devices read different relays: a room left on
   * one relay never reaches a device that does not read it, and nothing else
   * would send it again, because the device holding it counts it published.
   *
   * A record no relay returned at its latest is queued again and counted in
   * what the person is told. Every other record with a signed copy is sent
   * again quietly: the pool passes on one copy of an event, so nothing here
   * says which relays still hold it, and publishing goes to all of them.
   * A signed copy goes back exactly as it was, so a tombstone and the room it
   * removed keep their order and a removal cannot be undone. An older cache
   * without one is signed again at its own time, for the same reason.
   *
   * A lookup that found nothing at all may only mean no relay answered, so
   * it repairs nothing unless the person asked. A relay that never keeps
   * these is sent them again at the next sign-in. True when records were
   * queued, so their outcome is what gets reported.
   */
  #repair(): boolean {
    const force = this.#forceRepair
    this.#forceRepair = false
    if (!this.signer.nip44 || (!this.#seen.size && !force)) return false
    let count = 0
    const resend: Event[] = []
    for (const [roomId, record] of this.#records) {
      if (this.#pending.has(roomId) || this.#repaired.has(record.d)) continue
      this.#repaired.add(record.d)
      const { d: _d, id: _id, event, ...value } = record
      if ((this.#seen.get(record.d) ?? -1) >= Math.floor(record.at / 1000)) {
        if (event) resend.push(event)
        continue
      }
      this.#pending.set(roomId, { value, d: record.d, ...(event ? { event } : {}) })
      this.#persist(roomId)
      count++
    }
    void (async () => {
      // One at a time: a burst is what relays rate-limit.
      for (const event of resend) {
        if (this.#closed) return
        // A record changed since the lookup has had its newer copy sent.
        const record = [...this.#records.values()].find(record => record.id === event.id)
        if (!record || this.#pending.has(record.roomId)) continue
        await this.relay.publish(event).catch(() => { /* Another relay, or the next sign-in. */ })
      }
    })()
    if (!count) return false
    this.#repairing += count
    void this.retry()
    return true
  }

  /** How many rooms this account keeps, for the end of a lookup. */
  #upToDate(): string {
    const rooms = [...this.#records.values()].filter(record => record.room).length
    return `Up to date: ${rooms === 1 ? '1 room' : `${rooms} rooms`} on your account.`
  }

  /** Report how a queued change ended. Later than any lookup already armed. */
  #report(message: string): void {
    this.#reports++
    this.status(message)
  }

  #apply(value: RecordValue): void {
    if (value.room) rememberRoom(this.rooms, value.room)
    else forgetRoom(this.rooms, value.roomId)
  }

  #persist(roomId: string): void {
    this.store.set(this.#prefix + roomId, JSON.stringify({ record: this.#records.get(roomId), pending: this.#pending.get(roomId) }))
  }

  async retry(): Promise<void> {
    if (this.#closed || this.#busy) return
    if (!this.#pending.size) {
      // An explicit retry is the person saying the signer has changed, or
      // asking for rooms another device cannot see to be sent again.
      this.#undecryptable.clear()
      this.#refusals = 0
      this.#repaired.clear()
      this.#forceRepair = true
      this.start()
      return
    }
    if (!this.signer.nip44) {
      this.#report('Saved in this browser only. Use a signer with NIP-44 encryption to sync your rooms.')
      return
    }
    this.#busy = true
    try {
      while (this.#pending.size && !this.#closed) {
        const [roomId, pending] = this.#pending.entries().next().value!
        this.status('Saving encrypted room bookmarks… Your signer may ask for approval.')
        if (!pending.event) {
          const content = await this.signer.nip44.encrypt(this.signer.pubkey, JSON.stringify(pending.value))
          if (this.#closed) return
          const template = { kind: KIND, created_at: Math.floor(pending.value.at / 1000), tags: [['d', pending.d], ['l', APP]], content }
          const event = await this.signer.signEvent(template)
          if (this.#closed) return
          if (event.pubkey !== this.signer.pubkey || event.kind !== KIND || event.created_at !== template.created_at ||
              event.content !== content || JSON.stringify(event.tags) !== JSON.stringify(template.tags) || !verifyEventUncached(event)) throw new Error('signer changed bookmark')
          pending.event = event
          this.#persist(roomId)
        }
        if (this.#closed) return
        await this.relay.publish(pending.event)
        if (this.#closed) return
        const latest = this.#records.get(roomId)
        const published: RecordEntry = { ...pending.value, d: pending.d, id: pending.event.id, event: pending.event }
        // A record put back unchanged, or re-signed at its own time, replaces
        // the copy it restores.
        if (!latest || newer(published, latest) || (latest.d === published.d && Math.floor(latest.at / 1000) === Math.floor(published.at / 1000))) this.#records.set(roomId, published)
        if (this.#pending.get(roomId) === pending) this.#pending.delete(roomId)
        if (!this.#pending.has(roomId)) this.#apply(this.#records.get(roomId)!)
        this.#persist(roomId)
        this.changed()
      }
      if (!this.#closed) this.#report(this.#repairing
        ? `Put back ${this.#repairing === 1 ? '1 room change' : `${this.#repairing} room changes`} your relays had lost. ${this.#upToDate()}`
        : 'Room bookmarks accepted by a relay, encrypted to your Nostr key. Sign in with the same key on another device to find them.')
      this.#repairing = 0
    } catch {
      if (!this.#closed) this.#report('Saved in this browser, but sync was not confirmed. Retry room sync when your signer and relays are available.')
    } finally { this.#busy = false }
  }

  close(): void {
    this.#closed = true
    this.#off?.()
    this.relay.close()
  }
}
