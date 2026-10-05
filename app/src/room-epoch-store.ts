/**
 * The epoch each room was in when this device last read it, kept beside the
 * room secret this device already holds.
 *
 * Two records, by room id:
 *
 * - `kithmoot.room-epoch.v1.<room>`: the epoch's number, id and key. What
 *   the rooms list reads a room under, and what a release before this one
 *   reads and writes.
 * - `kithmoot.room-epoch.v2.<room>`: the epoch with its secret, the window's
 *   left epochs with theirs (`epochsInWindow`), who the room removed and who
 *   it knows. What a session opens the room with (`RoomSessionOptions.epoch`
 *   and `pastEpochs`), so it neither replays every rekey from epoch 0 nor
 *   stalls on one sealed to a seal key this device has since dropped, and
 *   still reads the last month.
 *
 * Neither adds anything a thief of this storage lacks: the link, the device
 * key and the seal keys beside them already re-derive every epoch. Both go
 * with the room (`forgetRoomEpoch`).
 *
 * A v1 record has no secret, so it cannot become a v2 one: a device coming
 * from an earlier release opens the room from epoch 0 as before, and keeps a
 * v2 record from then on. v1 goes on being written beside it.
 *
 * Pure functions over an injected store, like `device-store.ts`.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { deriveEpoch, epochsInWindow, type EpochKeys, type LeftEpoch, type RekeyNotice, type RoomEpoch } from '../../src/epoch.js'
import type { PastEpoch } from '../../src/chat.js'
import type { DeviceStore } from './device-store.js'

export const ROOM_EPOCH_PREFIX = 'kithmoot.room-epoch.v1.'
export const ROOM_EPOCH_V2_PREFIX = 'kithmoot.room-epoch.v2.'

/** What a v2 record holds, read back. */
export interface KeptRoomEpoch {
  /** Above epoch 0. */
  epoch: RoomEpoch
  /** The left epochs still read, newest first: `epochsInWindow`'s answer
   *  when it was written. Epoch 0's secret is the room secret. */
  past: LeftEpoch[]
  removed: string[]
  members: string[]
}

const HEX64 = /^[0-9a-f]{64}$/

const hexList = (raw: unknown): string[] =>
  Array.isArray(raw) ? [...new Set(raw.filter((p): p is string => typeof p === 'string' && HEX64.test(p)))].sort() : []

/** The epoch the rooms list reads a room under: the v2 record's when there
 *  is one, else the v1 record's. Undefined for a room in epoch 0. */
export function loadWatchedEpoch(store: DeviceStore, roomId: string): EpochKeys | undefined {
  const kept = loadKeptRoomEpoch(store, roomId)
  const v1 = loadRoomEpochV1(store, roomId)
  if (kept && (!v1 || kept.epoch.epoch >= v1.epoch)) return deriveEpoch(kept.epoch)
  return v1
}

/** The v1 record, or undefined when there is none or it does not parse. */
export function loadRoomEpochV1(store: DeviceStore, roomId: string): EpochKeys | undefined {
  try {
    const raw = JSON.parse(store.get(ROOM_EPOCH_PREFIX + roomId) ?? 'null') as { epoch?: unknown; id?: unknown; key?: unknown } | null
    if (!raw || !Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 1) return undefined
    if (typeof raw.id !== 'string' || !HEX64.test(raw.id) || typeof raw.key !== 'string' || !HEX64.test(raw.key)) return undefined
    return { epoch: raw.epoch as number, id: raw.id, key: hexToBytes(raw.key) }
  } catch {
    return undefined
  }
}

/** The v2 record, or undefined when there is none or its epoch does not
 *  parse. A left epoch that does not parse is dropped; the rest stand. */
export function loadKeptRoomEpoch(store: DeviceStore, roomId: string): KeptRoomEpoch | undefined {
  try {
    const raw = JSON.parse(store.get(ROOM_EPOCH_V2_PREFIX + roomId) ?? 'null') as Record<string, unknown> | null
    if (!raw || !Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 1) return undefined
    if (typeof raw.secret !== 'string' || !HEX64.test(raw.secret)) return undefined
    const epoch = raw.epoch as number
    const past: LeftEpoch[] = []
    for (const e of Array.isArray(raw.past) ? raw.past as unknown[] : []) {
      if (typeof e !== 'object' || e === null) continue
      const { epoch: n, secret, leftAt } = e as Record<string, unknown>
      if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) >= epoch) continue
      if (typeof secret !== 'string' || !HEX64.test(secret) || !Number.isSafeInteger(leftAt) || (leftAt as number) < 0) continue
      past.push({ epoch: n as number, secret: hexToBytes(secret), leftAt: leftAt as number })
    }
    const removed = hexList(raw.removed)
    return { epoch: { epoch, secret: hexToBytes(raw.secret) }, past, removed, members: hexList(raw.members).filter((p) => !removed.includes(p)) }
  } catch {
    return undefined
  }
}

/**
 * Write down where a room is, unless this device already holds a later
 * epoch for it: the v2 record, its left epochs cut to the history window at
 * `now`, and the v1 record beside it. Throws when storage refuses.
 */
export function storeKeptRoomEpoch(store: DeviceStore, roomId: string, kept: KeptRoomEpoch, now: number): void {
  if (kept.epoch.epoch < 1 || (loadKeptRoomEpoch(store, roomId)?.epoch.epoch ?? 0) > kept.epoch.epoch) return
  const removed = hexList(kept.removed.map((p) => p.toLowerCase()))
  const past = epochsInWindow(kept.past.filter((e) => e.epoch < kept.epoch.epoch && e.secret.length === 32), now)
  store.set(ROOM_EPOCH_V2_PREFIX + roomId, JSON.stringify({
    epoch: kept.epoch.epoch,
    secret: bytesToHex(kept.epoch.secret),
    past: past.map((e) => ({ epoch: e.epoch, secret: bytesToHex(e.secret), leftAt: e.leftAt })),
    removed,
    members: hexList(kept.members.map((p) => p.toLowerCase())).filter((p) => !removed.includes(p)),
  }))
  storeRoomEpochV1(store, roomId, kept.epoch)
}

/** The v1 record, unless it already names this epoch or a later one. */
function storeRoomEpochV1(store: DeviceStore, roomId: string, epoch: RoomEpoch): void {
  if ((loadRoomEpochV1(store, roomId)?.epoch ?? 0) >= epoch.epoch) return
  const keys = deriveEpoch(epoch)
  store.set(ROOM_EPOCH_PREFIX + roomId, JSON.stringify({ epoch: keys.epoch, id: keys.id, key: bytesToHex(keys.key) }))
}

/**
 * A rekey the rooms list followed from outside the room (`RoomWatch`'s
 * `onEpoch`). The v2 record moves on when it can be kept whole: when the
 * epoch left is the one it holds, or epoch 0, whose secret is the room
 * secret. Otherwise - a device whose v2 record is behind, or that has only
 * a v1 record - only v1 moves, and opening the room writes v2. Throws when
 * storage refuses.
 */
export function keepFollowedRekey(
  store: DeviceStore,
  roomId: string,
  moved: { roomSecret: Uint8Array; left: number; next: RoomEpoch; notice: Pick<RekeyNotice, 'at' | 'removed' | 'members'> },
  now: number,
): void {
  const kept = loadKeptRoomEpoch(store, roomId)
  if (kept && kept.epoch.epoch >= moved.next.epoch) return
  const leftSecret = moved.left === 0 ? moved.roomSecret : kept?.epoch.epoch === moved.left ? kept.epoch.secret : undefined
  if (!leftSecret) {
    storeRoomEpochV1(store, roomId, moved.next)
    return
  }
  storeKeptRoomEpoch(store, roomId, {
    epoch: moved.next,
    past: [{ epoch: moved.left, secret: leftSecret, leftAt: moved.notice.at }, ...(kept?.past ?? [])],
    removed: [...(kept?.removed ?? []), ...moved.notice.removed],
    members: moved.notice.members ?? kept?.members ?? [],
  }, now)
}

/** Forget both records for a room. */
export function forgetRoomEpoch(store: DeviceStore, roomId: string): void {
  store.remove(ROOM_EPOCH_PREFIX + roomId)
  store.remove(ROOM_EPOCH_V2_PREFIX + roomId)
}

/** What a log is handed to go on reading a v2 record's left epochs. */
export function pastRootsOf(kept: KeptRoomEpoch): PastEpoch[] {
  return kept.past.map((e) => {
    if (e.epoch === 0) return { leftAt: e.leftAt }
    const keys = deriveEpoch(e)
    return { root: { id: keys.id, key: keys.key }, leftAt: e.leftAt }
  })
}

/** Every epoch id the records name for a room, epoch 0's (the room id)
 *  aside: the main chat's stream in each, for forgetting what this device
 *  archived there. */
export function keptEpochIds(store: DeviceStore, roomId: string): string[] {
  const kept = loadKeptRoomEpoch(store, roomId)
  const ids = new Set<string>()
  const v1 = loadRoomEpochV1(store, roomId)
  if (v1) ids.add(v1.id)
  if (kept) for (const e of [kept.epoch, ...kept.past]) if (e.epoch > 0) ids.add(deriveEpoch(e).id)
  return [...ids]
}
