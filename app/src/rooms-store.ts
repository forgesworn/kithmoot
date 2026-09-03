/**
 * Where this browser keeps the rooms it has been in.
 *
 * A person is in several standing rooms - project rooms, a weekly town
 * hall, a bench their agents sit on - and a browser that forgets every one
 * of them the moment the tab closes makes each of those a link to go and
 * find again. So a room that admitted this device is written down here:
 * its id, what it is called, the link that opens it, when this device was
 * last in it, and how far through its chat this device has read.
 *
 * Nothing in here is a secret, and nothing in here is anything the link
 * did not already carry. The room key is deliberately NOT kept here: a
 * version 2 link is an invitation, the room secret arrives over the
 * rendezvous and lives where the app already keeps it - a creator's record
 * for twelve hours, a joiner's for the tab's session, or, when the person
 * has chosen to keep the room on this device, a joiner's record on the
 * creator's terms (see `storeKeptAdmission` in device-store.ts). What this
 * keeps is the way back in, which is the link itself, and whether that
 * choice was made. A pairing link is refused outright: its code is
 * single-use and a kept copy is a code sitting somewhere it could be
 * forwarded by accident.
 *
 * Pure functions over the same injected `DeviceStore` the device keys use,
 * so the rules are tested with no browser.
 */
import { parseRoomLink } from '../../src/link.js'
import { deriveInvitationId } from '../../src/invitation.js'
import { sanitiseDisplayName } from '../../src/display-name.js'
import { forgetKeptAdmission, type DeviceStore } from './device-store.js'

export const ROOM_PREFIX = 'kithmoot.room.'

export interface KnownRoom {
  roomId: string
  /** What the room is called, off its link. Undefined when nobody named it;
   *  see `roomLabel` for what is shown then. */
  name?: string
  /** The join link, as this app would hand it on. Never a pairing link. */
  link: string
  /** Unix seconds this device last opened the room. */
  openedAt: number
  /** `sentAt` of the newest chat message this device has been shown. Zero
   *  until it has been shown any, so everything in the room is new. */
  readAt: number
  /** The person chose to keep this room's admission on this device, so the
   *  list and notifications can read it with no tab open on it. Off unless
   *  they did. */
  keep?: boolean
}

/** What a visit to a room says about it. */
export interface RoomVisit {
  roomId: string
  link: string
  /** The room's name, when the visit learned one. Omit to keep whatever
   *  name is already held, or the one on the link. */
  name?: string
  /** Unix seconds. */
  openedAt: number
}

const ROOM_ID = /^[0-9a-f]{64}$/

function keyFor(roomId: string): string {
  return ROOM_PREFIX + roomId
}

function readRoom(store: DeviceStore, roomId: string): KnownRoom | undefined {
  const raw = store.get(keyFor(roomId))
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<KnownRoom>
    if (typeof parsed.link !== 'string' || !parsed.link) return undefined
    if (typeof parsed.openedAt !== 'number' || !Number.isFinite(parsed.openedAt)) return undefined
    const room: KnownRoom = {
      roomId,
      link: parsed.link,
      openedAt: parsed.openedAt,
      readAt: typeof parsed.readAt === 'number' && Number.isFinite(parsed.readAt) ? parsed.readAt : 0,
    }
    if (parsed.keep === true) room.keep = true
    // Sanitised on the way out of storage as well as on the way in, because
    // a stored value is only as trustworthy as whatever wrote it.
    const name = sanitiseDisplayName(parsed.name)
    if (name !== undefined) room.name = name
    return room
  } catch {
    return undefined
  }
}

function writeRoom(store: DeviceStore, room: KnownRoom): void {
  const { roomId, ...rest } = room
  store.set(keyFor(roomId), JSON.stringify(rest))
}

/** One room this device has been in, or undefined. */
export function knownRoom(store: DeviceStore, roomId: string): KnownRoom | undefined {
  return ROOM_ID.test(roomId) ? readRoom(store, roomId) : undefined
}

/** Every room this device has been in, most recently opened first. */
export function knownRooms(store: DeviceStore): KnownRoom[] {
  const rooms: KnownRoom[] = []
  for (const key of store.keys()) {
    if (!key.startsWith(ROOM_PREFIX)) continue
    const roomId = key.slice(ROOM_PREFIX.length)
    if (!ROOM_ID.test(roomId)) continue
    const room = readRoom(store, roomId)
    if (room) rooms.push(room)
  }
  return rooms.sort((a, b) => b.openedAt - a.openedAt || (a.roomId < b.roomId ? -1 : 1))
}

/**
 * Write a room down, or bring what is written up to date.
 *
 * Called whenever a link is opened and admission succeeds, and when a room
 * is created, so the list is what this device has actually been let into.
 * The name is the one given, else the one on the link, else the one already
 * held; how far the chat has been read is never touched here. Throws on a
 * link that does not parse or that carries a pairing code, because both are
 * a caller's mistake and neither is a thing to keep.
 */
export function rememberRoom(store: DeviceStore, visit: RoomVisit): KnownRoom {
  if (!ROOM_ID.test(visit.roomId)) throw new Error('a room id is 64 lowercase hex characters')
  const link = parseRoomLink(visit.link)
  if (link.pairingCode) throw new Error('a pairing link is single-use and is never kept')
  const existing = readRoom(store, visit.roomId)
  const room: KnownRoom = {
    roomId: visit.roomId,
    link: visit.link,
    openedAt: visit.openedAt,
    readAt: existing?.readAt ?? 0,
  }
  const name = sanitiseDisplayName(visit.name) ?? link.name ?? existing?.name
  if (name !== undefined) room.name = name
  if (existing?.keep) room.keep = true
  writeRoom(store, room)
  return room
}

/**
 * Whether to keep this room's admission on this device - see
 * `storeKeptAdmission`. The choice is written here; the admission itself
 * is written by whoever holds it, which is the page in the room. Turning
 * it off removes whatever was kept for the room's current link. False when
 * the room is not one this device has written down.
 */
export function setKeepRoom(store: DeviceStore, roomId: string, keep: boolean): boolean {
  const room = knownRoom(store, roomId)
  if (!room) return false
  const { keep: _was, ...rest } = room
  writeRoom(store, keep ? { ...rest, keep: true } : rest)
  if (!keep) forgetKeptFor(store, room.link)
  return true
}

/**
 * Note how far this device has read a room's chat: the `sentAt` of the
 * newest message it was shown. Only ever moves forward, so a log rendered
 * out of order cannot mark the room less read than it is. False when the
 * room is not one this device has written down.
 */
export function markRead(store: DeviceStore, roomId: string, readAt: number): boolean {
  if (!Number.isFinite(readAt)) return false
  const room = knownRoom(store, roomId)
  if (!room) return false
  if (readAt <= room.readAt) return true
  writeRoom(store, { ...room, readAt })
  return true
}

/** Forget a room on this device. The link goes with it, and so does any
 *  admission kept for it; the room itself, and this device's standing in
 *  it, are untouched. */
export function forgetRoom(store: DeviceStore, roomId: string): void {
  if (!ROOM_ID.test(roomId)) return
  const room = readRoom(store, roomId)
  if (room) forgetKeptFor(store, room.link)
  store.remove(keyFor(roomId))
}

/** Remove the kept admission behind a link, if the link is an invitation. */
function forgetKeptFor(store: DeviceStore, link: string): void {
  try {
    const parsed = parseRoomLink(link)
    if (parsed.invitation) forgetKeptAdmission(store, deriveInvitationId(parsed.invitation))
  } catch {
    // A link that does not parse kept nothing.
  }
}

/** What to call a room on screen: its name, or enough of its id to tell it
 *  from the next one. The id is shown beside the name either way, for the
 *  same reason a pubkey is shown beside a person's - two rooms can be
 *  called the same thing. */
export function roomLabel(room: Pick<KnownRoom, 'roomId' | 'name'>): string {
  return room.name ?? `Room ${room.roomId.slice(0, 8)}`
}

/** How many of these messages are newer than the room was last read to. */
export function unreadCount(messages: ReadonlyArray<{ sentAt: number }>, readAt: number): number {
  let count = 0
  for (const message of messages) if (message.sentAt > readAt) count++
  return count
}
