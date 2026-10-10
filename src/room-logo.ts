import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import type { ChatLog, ChatMessage } from './chat.js'
import { CONTROL_CHANNEL, encodeControl } from './control.js'
import { readLogoImage, type LogoImage } from './logo-image.js'
import { readRoomLogoOp, roomLogoPayload, type RoomLogoOp } from './room-logo-payload.js'
import { compareMessages } from './message-order.js'
import { ROOM_NAME_REKEY_GRACE_SECONDS, ROOM_NAME_REPOST_SECONDS, type RoomNameEpochs } from './room-name.js'

/** Like a shared room name, an override may be changed by an admitted writer.
 * A logo neither proves identity nor grants room or project access. */
export interface RoomLogoRecord {
  image: LogoImage | null
  id: string
  at: number
  sentAt: number
  by?: string
}
const identity = (record: Pick<RoomLogoRecord, 'image' | 'id' | 'at'>) => `${record.at}:${record.id}:${record.image?.sha256 ?? 'removed'}`

export function roomLogoOp(image: LogoImage | null, at: number, id = bytesToHex(randomBytes(16))): RoomLogoOp {
  const checked = image === null ? null : readLogoImage(image)
  if (checked === undefined) throw new Error('Invalid room logo image')
  const op = readRoomLogoOp({ op: 'logo', id, at, sha256: checked?.sha256 ?? null })
  if (!op) throw new Error('Invalid room logo change')
  return op
}
export function roomLogoFromMessage(message: Pick<ChatMessage, 'text' | 'roomLogo' | 'participant' | 'sentAt'>): RoomLogoRecord | undefined {
  try {
    const op = readRoomLogoOp(JSON.parse(message.text))
    if (!op || Math.floor(op.at / 1000) > message.sentAt || message.roomLogo === undefined) return
    const image = roomLogoPayload(message.text, message.roomLogo, CONTROL_CHANNEL)
    if (image === undefined) return
    return { image, id: op.id, at: op.at, sentAt: message.sentAt, ...(op.carried ? {} : { by: message.participant }) }
  } catch { return }
}
export function compareRoomLogos(a: RoomLogoRecord, b: RoomLogoRecord): number {
  const order = compareMessages({ sentAt: Math.floor(a.at / 1000), sentAtMs: a.at, id: a.id },
    { sentAt: Math.floor(b.at / 1000), sentAtMs: b.at, id: b.id })
  if (order) return order
  const first = a.image?.sha256 ?? '', second = b.image?.sha256 ?? ''
  return first < second ? -1 : first > second ? 1 : 0
}

export class RoomLogoBook {
  readonly #entries: { record: RoomLogoRecord; epoch: number | undefined; cached?: true }[] = []
  add(record: RoomLogoRecord, epoch: number): boolean {
    if (this.#entries.some(entry => !entry.cached && entry.epoch === epoch && entry.record.sentAt === record.sentAt && identity(entry.record) === identity(record))) return false
    this.#entries.push({ record: structuredClone(record), epoch }); return true
  }
  seed(record: RoomLogoRecord, epoch?: number): void {
    try {
      roomLogoOp(record.image, record.at, record.id)
      if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) return
      if (!Number.isSafeInteger(record.sentAt) || Math.floor(record.at / 1000) > record.sentAt) return
      this.#entries.push({ record: structuredClone(record), epoch, cached: true })
    } catch { /* Invalid caches never become a renderer source. */ }
  }
  current(epoch: number, epochs: RoomNameEpochs = {}): RoomLogoRecord | undefined {
    let best: RoomLogoRecord | undefined
    for (const entry of this.#entries) {
      if (entry.epoch !== undefined && entry.epoch > epoch) continue
      if (entry.epoch !== undefined && entry.epoch < epoch) {
        const left = epochs.rekeyedAt?.(entry.epoch + 1)
        if (left !== undefined && entry.record.at > (left + ROOM_NAME_REKEY_GRACE_SECONDS) * 1000) continue
      }
      if (!best || compareRoomLogos(entry.record, best) > 0) best = entry.record
    }
    return best ? structuredClone(best) : undefined
  }
  carryDue(epoch: number, now: number, epochs: RoomNameEpochs = {}): RoomLogoRecord | undefined {
    const best = this.current(epoch, epochs)
    if (!best) return
    const copies = this.#entries.filter(entry => !entry.cached && entry.epoch === epoch && identity(entry.record) === identity(best))
    return !copies.some(entry => entry.record.sentAt >= now - ROOM_NAME_REPOST_SECONDS) ? best : undefined
  }
}

export interface RoomLogoSession { readonly epoch: number; channel(name: string): ChatLog; rekeyedAt?(epoch: number): number | undefined }
export interface RoomLogoFollower {
  current(): RoomLogoRecord | undefined
  replace(image: LogoImage | null): Promise<RoomLogoRecord>
  carryIfDue(): Promise<boolean>
  refresh(): void
  close(): void
}
/** Attach before the first rekey: each newly read message is filed under the
 * session's current epoch, as for the shared room name. */
export function followRoomLogo(session: RoomLogoSession, options: {
  seed?: RoomLogoRecord; seedEpoch?: number; nowMs?: () => number; onLogo?: (record: RoomLogoRecord | undefined) => void
} = {}): RoomLogoFollower {
  const log = session.channel(CONTROL_CHANNEL), book = new RoomLogoBook(), seen = new Set<string>()
  const epochs = { rekeyedAt: (epoch: number) => session.rekeyedAt?.(epoch) }, now = options.nowMs ?? Date.now
  let closed = false, shown: string | undefined
  if (options.seed) book.seed(options.seed, options.seedEpoch)
  const settle = () => {
    const current = book.current(session.epoch, epochs), next = current ? identity(current) : undefined
    if (shown === next) return
    shown = next
    try { options.onLogo?.(current) } catch { /* A renderer must not stop metadata ingestion. */ }
  }
  const ingest = (messages: ChatMessage[]) => {
    if (closed) return
    for (const message of messages) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      const record = roomLogoFromMessage(message)
      if (record) book.add(record, session.epoch)
    }
    settle()
  }
  const off = log.onChange(ingest); ingest(log.messages())
  return {
    current: () => book.current(session.epoch, epochs),
    async replace(image) {
      if (closed) throw new Error('This room logo has closed')
      const checked = image === null ? null : readLogoImage(image)
      if (checked === undefined) throw new Error('Invalid room logo image')
      const op = roomLogoOp(checked, now())
      await log.send(encodeControl(op), { roomLogo: checked })
      return { image: checked, id: op.id, at: op.at, sentAt: Math.floor(op.at / 1000) }
    },
    async carryIfDue() {
      if (closed || log.readOnly) return false
      const record = book.carryDue(session.epoch, Math.floor(now() / 1000), epochs)
      if (!record) return false
      const op = { ...roomLogoOp(record.image, record.at, record.id), carried: true as const }
      await log.send(encodeControl(op), { roomLogo: record.image })
      return true
    },
    refresh() { if (!closed) settle() },
    close() { closed = true; off() },
  }
}
