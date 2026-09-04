/** Private, per-room Nostr bookmarks. Never uploads the visitor's history.
 * Random addressable identifiers keep room ids out of public tags. Separate
 * records prevent two devices saving different rooms from overwriting a list.
 * Encrypted tombstones prevent an older relay copy resurrecting a removal.
 */
import type { SignetSigner } from 'signet-login'
import type { Event } from 'nostr-tools/pure'
import type { RelayTransport } from '../../src/relay-pool.js'
import { verifyEventUncached } from '../../src/verify.js'
import { memoryDeviceStore, type DeviceStore } from './device-store.js'
import { ROOM_PREFIX, rememberRoom, forgetRoom, type KnownRoom } from './rooms-store.js'

const APP = 'kithmoot.rooms.v1'
const KIND = 30078
interface RecordValue { roomId: string; at: number; room?: KnownRoom }
interface RecordEntry extends RecordValue { d: string; id: string }
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
  #off?: () => void
  #prefix: string
  constructor(
    private store: DeviceStore,
    private signer: SignetSigner,
    private relay: RelayTransport,
    private changed: () => void,
    private status: (message: string) => void,
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
    this.#off = this.relay.subscribe([{ kinds: [KIND], authors: [this.signer.pubkey], '#l': [APP] }], event => {
      void this.receive(event)
    }, () => {
      if (!this.#closed && !this.#pending.size) this.status('Relay lookup finished. Your signer may still be decrypting; unreachable relays cannot restore bookmarks.')
    })
  }

  async receive(event: Event): Promise<void> {
    if (this.#closed || event.kind !== KIND || event.pubkey !== this.signer.pubkey ||
        event.content.length > 60_000 || !verifyEventUncached(event) ||
        !event.tags.some(t => t[0] === 'l' && t[1] === APP)) return
    const d = event.tags.find(t => t[0] === 'd')?.[1]
    if (!d || !/^kithmoot\.rooms\.v1\.[0-9a-f-]{36}$/.test(d)) return
    // Returning on the same browser does not need another signer prompt
    // for an event already decrypted into this account's local cache.
    if ([...this.#records.values()].some(record => record.id === event.id)) return
    try {
      const value = JSON.parse(await this.signer.nip44!.decrypt(this.signer.pubkey, event.content)) as RecordValue
      if (this.#closed || !/^[0-9a-f]{64}$/.test(value.roomId) || !Number.isSafeInteger(value.at) ||
          Math.floor(value.at / 1000) !== event.created_at || event.created_at > Date.now() / 1000 + 60) return
      if (value.room) {
        if (value.room.roomId !== value.roomId) return
        // Validate links and names through the same rules as local visits.
        value.room = rememberRoom(memoryDeviceStore(), value.room)
      }
      const incoming = { ...value, d, id: event.id }
      const previous = this.#records.get(value.roomId)
      if (previous && !newer(incoming, previous)) return
      const pending = this.#pending.get(value.roomId)
      this.#records.set(value.roomId, incoming)
      if (pending && (pending.event ? newer(incoming, { at: pending.value.at, id: pending.event.id })
        : Math.floor(value.at / 1000) > Math.floor(pending.value.at / 1000))) this.#pending.delete(value.roomId)
      if (!this.#pending.has(value.roomId)) this.#apply(value)
      this.#persist(value.roomId)
      this.changed()
      if (!this.#pending.size) this.status('Encrypted room bookmarks loaded. Opening a room may still need an online member to let this device in.')
    } catch { /* Unreadable, malformed or foreign data never reaches the UI. */ }
  }

  save(room: KnownRoom): void {
    const previous = this.#pending.get(room.roomId)?.value ?? this.#records.get(room.roomId)
    if (previous?.room?.link === room.link && previous.room.name === room.name) return
    this.#queue({ roomId: room.roomId, at: Date.now(), room })
  }

  remove(roomId: string): void {
    this.#queue({ roomId, at: Date.now() })
  }

  #queue(value: RecordValue): void {
    if (this.#closed) return
    // Only bookmark fields travel. Read positions, device credentials and
    // the choice to keep an admission never follow an account.
    if (value.room) {
      const { roomId, link, name, openedAt } = value.room
      value.room = { roomId, link, name, openedAt, readAt: 0 }
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

  #apply(value: RecordValue): void {
    if (value.room) rememberRoom(this.rooms, value.room)
    else forgetRoom(this.rooms, value.roomId)
  }

  #persist(roomId: string): void {
    this.store.set(this.#prefix + roomId, JSON.stringify({ record: this.#records.get(roomId), pending: this.#pending.get(roomId) }))
  }

  async retry(): Promise<void> {
    if (this.#closed || this.#busy) return
    if (!this.#pending.size) { this.start(); return }
    if (!this.signer.nip44) {
      this.status('Saved in this browser only. Use a signer with NIP-44 encryption to sync your rooms.')
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
        const published = { ...pending.value, d: pending.d, id: pending.event.id }
        if (!latest || newer(published, latest)) this.#records.set(roomId, published)
        if (this.#pending.get(roomId) === pending) this.#pending.delete(roomId)
        if (!this.#pending.has(roomId)) this.#apply(this.#records.get(roomId)!)
        this.#persist(roomId)
        this.changed()
      }
      if (!this.#closed) this.status('Room bookmarks accepted by a relay, encrypted to your Nostr key. Sign in with the same key on another device to find them.')
    } catch {
      if (!this.#closed) this.status('Saved in this browser, but sync was not confirmed. Retry room sync when your signer and relays are available.')
    } finally { this.#busy = false }
  }

  close(): void {
    this.#closed = true
    this.#off?.()
    this.relay.close()
  }
}
