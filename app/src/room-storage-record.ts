/**
 * The group storage nodes a room lists, as this device holds them (phase S5b).
 *
 * The room's authority (its keeper) signs the list into the group invitation
 * and posts it as a `storage` op on the control channel. This device holds the
 * newest it has seen from either carrier, kept across visits: a returning
 * member's kept admission carries no `storage`, so this record is what tells
 * the app the room keeps its files on its own computers.
 *
 * `version` orders them. An invitation copy's version is its `created_at`; the
 * keeper gives the op the same number, so a stale op reposted later cannot
 * outrank a newer invitation copy. `sig` is present only when the record came
 * from an op: it is what lets this device post the op again.
 *
 * No DOM and no clock. The key is a routing record, like `room-relays`.
 */
import { isInvitationStorage } from '@forgesworn/fold-kit'
import { verifyRoomStorage } from '../../src/room-storage.js'

export const ROOM_STORAGE_PREFIX = 'kithmoot.room-storage.v1.'

export interface RoomStorageRecord {
  /** Canonical node base URLs, in the order the authority prefers them. `[]` means it withdrew them all. */
  nodes: string[]
  version: number
  /** The authority's signature over the op, when the record came from one. */
  sig?: string
}

interface ReadableStore { getItem(key: string): string | null }
interface WritableStore extends ReadableStore { setItem(key: string, value: string): void; removeItem(key: string): void }

const ROOM = /^[0-9a-f]{64}$/
const SIG = /^[0-9a-f]{128}$/

/** A record read off the device, or undefined when it is not one. */
export function parseRoomStorageRecord(raw: string | null): RoomStorageRecord | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const o = value as Record<string, unknown>
    if (Object.keys(o).some(k => k !== 'nodes' && k !== 'version' && k !== 'sig')) return undefined
    if (!isInvitationStorage(o.nodes) || !Number.isSafeInteger(o.version) || (o.version as number) < 0) return undefined
    if (o.sig !== undefined && (typeof o.sig !== 'string' || !SIG.test(o.sig))) return undefined
    return { nodes: [...o.nodes], version: o.version as number, ...(o.sig !== undefined ? { sig: o.sig as string } : {}) }
  } catch { return undefined }
}

export function loadRoomStorageRecord(store: ReadableStore, roomId: string): RoomStorageRecord | undefined {
  if (!ROOM.test(roomId)) return undefined
  try { return parseRoomStorageRecord(store.getItem(ROOM_STORAGE_PREFIX + roomId)) } catch { return undefined }
}

/** False when the device could not keep it: the record still applies for this visit. */
export function storeRoomStorageRecord(store: WritableStore, roomId: string, record: RoomStorageRecord): boolean {
  if (!ROOM.test(roomId)) return false
  try { store.setItem(ROOM_STORAGE_PREFIX + roomId, JSON.stringify({ nodes: record.nodes, version: record.version, ...(record.sig ? { sig: record.sig } : {}) })); return true } catch { return false }
}

export function forgetRoomStorageRecord(store: WritableStore, roomId: string): void {
  if (!ROOM.test(roomId)) return
  try { store.removeItem(ROOM_STORAGE_PREFIX + roomId) } catch { /* Nothing held there. */ }
}

/**
 * What to hold after being offered `offered`: the offer when it is newer than
 * `held` (or nothing is held), `held` otherwise. A tie keeps what is held,
 * except that the same list arriving from an op adds the signature to a record
 * that came from the invitation, so this device can post it again. Returns
 * `undefined` when nothing changes.
 */
export function adoptRoomStorage(held: RoomStorageRecord | undefined, offered: RoomStorageRecord): RoomStorageRecord | undefined {
  if (!held || offered.version > held.version) return { nodes: [...offered.nodes], version: offered.version, ...(offered.sig ? { sig: offered.sig } : {}) }
  if (offered.version === held.version && !held.sig && offered.sig && sameList(held.nodes, offered.nodes)) {
    return { nodes: [...held.nodes], version: held.version, sig: offered.sig }
  }
  return undefined
}

/**
 * The newer of two records for the same room: the higher version, and `a` on a
 * tie (what is held stays). Either may be missing. What another tab wrote, or an
 * older tab left behind, never replaces a newer list this one holds.
 */
export function newerRoomStorage(a: RoomStorageRecord | undefined, b: RoomStorageRecord | undefined): RoomStorageRecord | undefined {
  if (!a) return b
  if (!b) return a
  return b.version > a.version ? b : a
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/** The record an invitation copy carries, if the copy names storage at all. */
export function recordFromAdmission(admission: { storage?: readonly string[]; storageAt?: number }): RoomStorageRecord | undefined {
  if (!admission.storage || !isInvitationStorage(admission.storage)) return undefined
  const version = admission.storageAt
  return { nodes: [...admission.storage], version: Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0 }
}

/** The record a `storage` op carries, only if the room's authority signed it. */
export function recordFromOp(control: { nodes: readonly string[]; version: number; sig: string }, roomId: string, authority: string): RoomStorageRecord | undefined {
  if (!verifyRoomStorage({ roomId, version: control.version, nodes: control.nodes, sig: control.sig, authority })) return undefined
  return { nodes: [...control.nodes], version: control.version, sig: control.sig.toLowerCase() }
}

/** Whether the web app can reach a listed node: https, and not an onion address (no Tor in a browser). Loopback and LAN `http` nodes are not (Q4). */
export function usableGroupBase(base: string): boolean {
  try {
    const url = new URL(base)
    return url.protocol === 'https:' && !url.hostname.endsWith('.onion')
  } catch { return false }
}

/**
 * The listed base a file lives on, when its URL is exactly `<base>/<sha256>` for
 * one of the room's nodes. A file anywhere else (an older attachment on a public
 * server, or a node the room has since delisted) is not a group file and goes
 * the way it always did.
 */
export function listedBaseOf(nodes: readonly string[], url: string, sha256: string): string | undefined {
  const hash = sha256.toLowerCase()
  return nodes.find(base => url === `${base}/${hash}`)
}
