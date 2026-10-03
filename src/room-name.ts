import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import type { ChatLog, ChatMessage } from './chat.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl, type ControlMessage } from './control.js'
import { sanitiseDisplayName } from './display-name.js'
import { compareMessages } from './message-order.js'

/**
 * The room's name, shared: any member may rename the room for everybody.
 *
 * A rename is a `name` op on the room's `control` channel - a kind-1460 chat
 * event under the current epoch's control-channel id and key, signed by the
 * sender's device and carrying its credential - so a relay sees exactly what
 * it sees of every other control message. Nothing about the name is public,
 * not even its length beyond NIP-44's padding. See `docs/room-name.md`.
 *
 * Newest wins, in the message order (`docs/messages.md`, "Order"): `at`,
 * then `id`, then the name itself, so every device that holds the same
 * renames shows the same name.
 */
export type RoomNameOp = Extract<ControlMessage, { op: 'name' }>

/** A rename a reader has accepted. */
export interface RoomNameRecord {
  /** Sanitised, 1 to `MAX_DISPLAY_NAME_LENGTH` characters. */
  name: string
  /** The rename's id: 32 lower-case hex characters. */
  id: string
  /** When the rename was made, unix milliseconds: its order key. */
  at: number
  /** Who renamed the room: the participant whose credential-bound message
   *  carried the rename. Absent on a carried copy, whose sender only
   *  repeated somebody else's rename and cannot say whose it was. */
  by?: string
  /** The carrying message's `sentAt`, unix seconds. */
  sentAt: number
}

/** How long a copy of the current name may sit in the control log before a
 *  member posts it again, so a newcomer reading the 30-day window still
 *  finds it. The same figure the room relays record uses. */
export const ROOM_NAME_REPOST_SECONDS = 20 * 24 * 60 * 60

/** How far past the rekey that left an epoch a rename read under that epoch
 *  may claim to have been made: the codec's own clock-skew bound. */
export const ROOM_NAME_REKEY_GRACE_SECONDS = 300

/**
 * Build a fresh rename. Throws when nothing of `name` survives sanitising:
 * an empty name is not a rename. A name over the cap is cut here, where the
 * person typing it can see the result, and refused by a reader that
 * receives one longer.
 */
export function renameRoomOp(name: string, at: number, id: string = bytesToHex(randomBytes(16))): RoomNameOp {
  const clean = sanitiseDisplayName(name)
  if (clean === undefined) throw new Error('a room name cannot be empty')
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error('a rename needs a time')
  const op = decodeControl(encodeControl({ op: 'name', name: clean, id, at }))
  if (!op || op.op !== 'name') throw new Error('invalid rename')
  return op
}

/** The same rename, to be posted again by any member: under a new epoch, or
 *  before its last copy leaves the retention window. Its order key is the
 *  original's, so it never outranks a later rename. */
export function carryRoomNameOp(record: Pick<RoomNameRecord, 'name' | 'id' | 'at'>): RoomNameOp {
  return { op: 'name', name: record.name, id: record.id, at: record.at, carried: true }
}

/**
 * Read a rename out of a decoded control-channel message, or null.
 *
 * The message has already passed `decodeChatEvent`: signed by a device whose
 * credential binds it to `participant` in this room, and admitted by the
 * room's policy. What is checked here is the op itself, and that its time is
 * no later than the second of the message carrying it - a sender cannot
 * stamp a rename in the future to pin a name above every later one; the
 * most they can do is what renaming now would do.
 */
export function roomNameFromMessage(message: Pick<ChatMessage, 'text' | 'participant' | 'sentAt'>): RoomNameRecord | null {
  const op = decodeControl(message.text)
  if (!op || op.op !== 'name') return null
  if (Math.floor(op.at / 1000) > message.sentAt) return null
  return {
    name: op.name,
    id: op.id,
    at: op.at,
    ...(op.carried ? {} : { by: message.participant }),
    sentAt: message.sentAt,
  }
}

/** Order two renames: by `at`, then `id` (the message rule), then the name,
 *  so two renames that share both still settle the same way everywhere. */
export function compareRoomNames(a: Pick<RoomNameRecord, 'name' | 'id' | 'at'>, b: Pick<RoomNameRecord, 'name' | 'id' | 'at'>): number {
  const order = compareMessages(
    { sentAt: Math.floor(a.at / 1000), sentAtMs: a.at, id: a.id },
    { sentAt: Math.floor(b.at / 1000), sentAtMs: b.at, id: b.id },
  )
  if (order !== 0) return order
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function sameRename(a: Pick<RoomNameRecord, 'name' | 'id' | 'at'>, b: Pick<RoomNameRecord, 'name' | 'id' | 'at'>): boolean {
  return a.id === b.id && a.at === b.at && a.name === b.name
}

/** What a book needs to know about the room's epochs. */
export interface RoomNameEpochs {
  /** When the authority rekeyed into `epoch`, unix seconds, if known. */
  rekeyedAt?: (epoch: number) => number | undefined
}

/**
 * Every rename a device has read, with the epoch it read each under, and
 * which one is the room's name.
 *
 * A rename read under an epoch the room has since left counts only if it
 * was made no later than the rekey out of that epoch (plus the clock-skew
 * grace): after that, the only people still writing under the old key are
 * the members it removed, and a device that had not yet heard of the rekey
 * must not carry their word into the room's new epoch.
 */
export class RoomNameBook {
  readonly #entries: { record: RoomNameRecord; epoch: number | undefined }[] = []

  /** Add a rename read under `epoch`. Returns false for one already held
   *  from the same message time and order key. */
  add(record: RoomNameRecord, epoch: number): boolean {
    if (this.#entries.some(e => e.epoch === epoch && e.record.sentAt === record.sentAt && sameRename(e.record, record) && e.record.by === record.by)) return false
    this.#entries.push({ record, epoch })
    return true
  }

  /** A rename this device accepted before and kept, read under no epoch:
   *  it counts toward the name and is never mistaken for a copy in the log. */
  seed(record: Pick<RoomNameRecord, 'name' | 'id' | 'at'>): void {
    const name = sanitiseDisplayName(record.name)
    if (name === undefined || !/^[0-9a-f]{32}$/.test(record.id) || !Number.isSafeInteger(record.at) || record.at <= 0) return
    this.#entries.push({ record: { name, id: record.id, at: record.at, sentAt: Math.floor(record.at / 1000) }, epoch: undefined })
  }

  /** The room's name: the newest rename that counts, or undefined. */
  current(currentEpoch: number, epochs: RoomNameEpochs = {}): RoomNameRecord | undefined {
    let best: RoomNameRecord | undefined
    for (const { record, epoch } of this.#entries) {
      if (epoch !== undefined && epoch < currentEpoch) {
        const left = epochs.rekeyedAt?.(epoch + 1)
        if (left !== undefined && record.at > (left + ROOM_NAME_REKEY_GRACE_SECONDS) * 1000) continue
      }
      if (epoch !== undefined && epoch > currentEpoch) continue
      if (!best || compareRoomNames(record, best) > 0) best = record
    }
    return best
  }

  /**
   * The rename to post again now, or undefined: the current name, when the
   * control log of `currentEpoch` holds no copy of it, or only copies older
   * than `ROOM_NAME_REPOST_SECONDS`. `now` is unix seconds.
   */
  carryDue(currentEpoch: number, now: number, epochs: RoomNameEpochs = {}): RoomNameRecord | undefined {
    const winner = this.current(currentEpoch, epochs)
    if (!winner) return undefined
    let newest = -Infinity
    for (const { record, epoch } of this.#entries) {
      if (epoch === currentEpoch && sameRename(record, winner)) newest = Math.max(newest, record.sentAt)
    }
    return newest < now - ROOM_NAME_REPOST_SECONDS ? winner : undefined
  }
}

/** The surface of a `RoomSession` a follower uses. */
export interface RoomNameSession {
  readonly epoch: number
  channel(name: string): ChatLog
  rekeyedAt?(epoch: number): number | undefined
}

export interface FollowRoomNameOptions {
  /** A rename this device accepted before and kept, from its own storage,
   *  so it can post the name again after every copy has left the relays. */
  seed?: Pick<RoomNameRecord, 'name' | 'id' | 'at'>
  /** The room's name changed: the new one, or undefined. */
  onName?: (record: RoomNameRecord | undefined) => void
  /** A fresh rename was read for the first time, whether or not it won:
   *  what a chat shows as "<who> renamed the room to …". Not called for a
   *  carried copy. */
  onRename?: (record: RoomNameRecord & { by: string }, message: ChatMessage) => void
  /** Milliseconds, for a rename's `at`. Defaults to `Date.now`. */
  nowMs?: () => number
}

/** A room's shared name, followed on its control channel. */
export interface RoomNameFollower {
  /** The room's name now, or undefined when nobody has renamed it. */
  current(): RoomNameRecord | undefined
  /** Rename the room for everybody. Resolves once a relay has it. */
  rename(name: string): Promise<RoomNameRecord>
  /** Post the current name again if this epoch's log lacks a fresh copy.
   *  Resolves to whether it posted. Call a while after joining, and a while
   *  after every rekey, with a random delay so members do not all post at
   *  once; a duplicate copy is harmless. */
  carryIfDue(): Promise<boolean>
  /** Work the name out again without a new message: after a rekey, which
   *  can discount renames read under the epoch the room left. */
  refresh(): void
  close(): void
}

/**
 * Follow a room's name on `session`'s control channel.
 *
 * Attach before the session's first rekey, as a client does on joining:
 * every rename is filed under the epoch the session is in when the follower
 * first reads it, so messages a log already held from an earlier epoch
 * would be filed under the wrong one by a follower attached later.
 */
export function followRoomName(session: RoomNameSession, opts: FollowRoomNameOptions = {}): RoomNameFollower {
  const log = session.channel(CONTROL_CHANNEL)
  const book = new RoomNameBook()
  const seen = new Set<string>()
  const renamed = new Set<string>()
  const nowMs = opts.nowMs ?? Date.now
  const epochs: RoomNameEpochs = { rekeyedAt: (epoch) => session.rekeyedAt?.(epoch) }
  if (opts.seed) book.seed(opts.seed)
  let shown = book.current(session.epoch, epochs)
  let closed = false

  const settle = (): void => {
    const next = book.current(session.epoch, epochs)
    if (next === shown || (next && shown && sameRename(next, shown))) return
    shown = next
    try { opts.onName?.(next) } catch { /* A caller's problem. */ }
  }
  const ingest = (messages: ChatMessage[]): void => {
    if (closed) return
    for (const message of messages) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      const record = roomNameFromMessage(message)
      if (!record) continue
      book.add(record, session.epoch)
      if (record.by !== undefined && !renamed.has(record.id)) {
        renamed.add(record.id)
        try { opts.onRename?.(record as RoomNameRecord & { by: string }, message) } catch { /* A caller's problem. */ }
      }
    }
    settle()
  }
  const unsubscribe = log.onChange(ingest)
  ingest(log.messages())

  return {
    current: () => book.current(session.epoch, epochs),
    async rename(name: string): Promise<RoomNameRecord> {
      const op = renameRoomOp(name, nowMs())
      await log.send(encodeControl(op))
      return { name: op.name, id: op.id, at: op.at, sentAt: Math.floor(op.at / 1000) }
    },
    refresh(): void {
      if (!closed) settle()
    },
    async carryIfDue(): Promise<boolean> {
      if (closed || log.readOnly) return false
      settle()
      const due = book.carryDue(session.epoch, Math.floor(nowMs() / 1000), epochs)
      if (!due) return false
      await log.send(encodeControl(carryRoomNameOp(due)))
      return true
    },
    close(): void {
      closed = true
      unsubscribe()
    },
  }
}
