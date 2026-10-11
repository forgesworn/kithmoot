import { roomLogoOp, type RoomLogoRecord } from '../../src/room-logo.js'
import { readLogoImage } from '../../src/logo-image.js'
import type { DeviceStore } from './device-store.js'

export const ROOM_LOGO_PREFIX = 'kithmoot.room-logo.v1.'
const MAX_CACHED_ROOMS = 64
export interface KeptRoomLogo { record: RoomLogoRecord; epoch: number }

function read(value: unknown): KeptRoomLogo | undefined {
  try {
    if (!value || typeof value !== 'object') return
    const raw = value as KeptRoomLogo
    if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || !raw.record) return
    const image = raw.record.image === null ? null : readLogoImage(raw.record.image)
    if (image === undefined) return
    const op = roomLogoOp(image, raw.record.at, raw.record.id)
    if (!Number.isSafeInteger(raw.record.sentAt) || raw.record.sentAt < Math.floor(op.at / 1000)) return
    return { epoch: raw.epoch, record: { image, id: op.id, at: op.at, sentAt: raw.record.sentAt } }
  } catch { return }
}

/** Only metadata accepted from an admitted session/watch enters this cache.
 * Temporary room images never persist. A cached record is not a relay copy;
 * its original epoch stays attached for removed-member discounting. */
export class RoomLogoCache {
  readonly #memory = new Map<string, KeptRoomLogo>()
  constructor(private store: DeviceStore) {}
  get(room: string): KeptRoomLogo | undefined {
    const memory = this.#memory.get(room)
    if (memory) return structuredClone(memory)
    try { return read(JSON.parse(this.store.get(ROOM_LOGO_PREFIX + room) ?? 'null')) } catch { return }
  }
  keep(room: string, record: RoomLogoRecord, epoch: number, persistent: boolean): void {
    const checked = read({ record, epoch })
    if (!checked || !/^[0-9a-f]{64}$/.test(room)) return
    this.#memory.delete(room); this.#memory.set(room, checked)
    if (this.#memory.size > MAX_CACHED_ROOMS) this.#memory.delete(this.#memory.keys().next().value!)
    try {
      if (!persistent) { this.store.remove(ROOM_LOGO_PREFIX + room); return }
      const key = ROOM_LOGO_PREFIX + room
      // Keep optional thumbnails bounded without evicting room admission.
      const others = this.store.keys().filter(k => k.startsWith(ROOM_LOGO_PREFIX) && k !== key)
      while (others.length >= MAX_CACHED_ROOMS) this.store.remove(others.shift()!)
      this.store.set(key, JSON.stringify(checked))
    } catch { /* The current room still uses its in-memory metadata. */ }
  }
  forget(room: string): void {
    this.#memory.delete(room)
    try { this.store.remove(ROOM_LOGO_PREFIX + room) } catch { /* Storage unavailable. */ }
  }
}
