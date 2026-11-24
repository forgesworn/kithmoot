import { base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * The room's own board on the wire.
 *
 * Every room has one board. It is not a second circle with a keeper, an
 * invitation and a membership of its own: it rides the room's key, epoch
 * and roster exactly as chat does, in the channel named here, so whoever
 * is in the room has the board and whoever is removed from the room loses
 * it at the same rekey. (`room-boards.ts`, plural, is the older catalogue
 * of separately kept boards somebody chose to share with a room.)
 *
 * The board itself is a Yjs document. Its changes are opaque bytes here:
 * a `BoardPart` is one piece of one blob of them, carried as the single
 * statement of a chat envelope, which is what authenticates the device and
 * the participant that sent it. Blobs merge in any order and any number of
 * times, so nothing has to be first and nobody has to be asked.
 */
export const ROOM_BOARD_CHANNEL = 'board'

/** Bytes of a blob one envelope carries: 22 KiB, the figure Girnel's own
 *  sync settled on. Its base64 form is 30,040 characters, which with the
 *  credential, proof and name the envelope also carries stays inside 32,768
 *  bytes of plaintext. NIP-44 pads that to 32,768 and no further, so the
 *  whole event is about 45 KB: inside the 64 KB that common relays stop at,
 *  with room to spare. Two kibibytes more and the padding steps up to
 *  40,960 bytes and the event to about 55 KB. */
export const MAX_BOARD_PART_BYTES = 22 * 1024
/** Parts in one blob: a whole board of up to 2,162,688 bytes (about 2 MiB). */
export const MAX_BOARD_PARTS = 96
export const MAX_BOARD_BLOB_BYTES = MAX_BOARD_PART_BYTES * MAX_BOARD_PARTS

/** `update` is some changes; `snapshot` is the sender's whole board, which
 *  lets a late arrival start from it. Both merge. Neither replaces what a
 *  reader already holds. */
export type BoardBlobKind = 'update' | 'snapshot'

export interface BoardPart {
  v: 1
  kind: BoardBlobKind
  /** The blob this is a part of: 32 lower-case hex characters, random. */
  blob: string
  /** This part's place, from 0. */
  index: number
  /** How many parts the blob has, from 1 to `MAX_BOARD_PARTS`. */
  count: number
  /** This part's bytes, as padded standard base64. */
  data: string
}

const PART_KEYS = ['blob', 'count', 'data', 'index', 'kind', 'v']
const BLOB_ID = /^[0-9a-f]{32}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_PART_CHARS = Math.ceil(MAX_BOARD_PART_BYTES / 3) * 4

/** Whether `value` is a board part in its one honest shape: exactly these
 *  fields, nothing else, every bound kept. Never throws. */
export function validBoardPart(value: unknown): value is BoardPart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const part = value as Record<string, unknown>
  const keys = Object.keys(part).sort()
  if (keys.length !== PART_KEYS.length || keys.some((key, i) => key !== PART_KEYS[i])) return false
  if (part.v !== 1 || (part.kind !== 'update' && part.kind !== 'snapshot')) return false
  if (typeof part.blob !== 'string' || !BLOB_ID.test(part.blob)) return false
  if (!Number.isSafeInteger(part.count) || (part.count as number) < 1 || (part.count as number) > MAX_BOARD_PARTS) return false
  if (!Number.isSafeInteger(part.index) || (part.index as number) < 0 || (part.index as number) >= (part.count as number)) return false
  if (typeof part.data !== 'string' || part.data.length === 0 || part.data.length > MAX_PART_CHARS || !BASE64.test(part.data)) return false
  return true
}

/** Cut a blob into the parts that carry it. Throws on an empty blob, one
 *  past `MAX_BOARD_BLOB_BYTES`, or an id that is not 32 hex characters. */
export function splitBoardBlob(kind: BoardBlobKind, bytes: Uint8Array, blob: string): BoardPart[] {
  if (!BLOB_ID.test(blob)) throw new Error('Invalid board blob id')
  if (bytes.byteLength === 0) throw new Error('An empty board change carries nothing')
  if (bytes.byteLength > MAX_BOARD_BLOB_BYTES) throw new Error('This board is too large to share in one piece')
  const count = Math.ceil(bytes.byteLength / MAX_BOARD_PART_BYTES)
  const parts: BoardPart[] = []
  for (let index = 0; index < count; index++) {
    const slice = bytes.subarray(index * MAX_BOARD_PART_BYTES, (index + 1) * MAX_BOARD_PART_BYTES)
    parts.push({ v: 1, kind, blob, index, count, data: base64.encode(slice) })
  }
  return parts
}

export interface BoardBlob {
  kind: BoardBlobKind
  bytes: Uint8Array
}

interface Gathering {
  kind: BoardBlobKind
  count: number
  parts: Map<number, Uint8Array>
  bytes: number
}

/** How many unfinished blobs are kept, across every sender, and how many
 *  bytes of them. The oldest goes first: a sender who never finishes one
 *  costs a bounded amount of memory and nothing else. */
const MAX_GATHERING = 32
const MAX_GATHERING_BYTES = 8 * 1024 * 1024

/**
 * Puts blobs back together from parts that arrive in any order.
 *
 * A blob belongs to the device that sent it: parts under one id from two
 * devices never join, so nobody can finish, or spoil, a blob somebody else
 * began. `device` must be the envelope's authenticated device.
 */
export class BoardAssembler {
  readonly #gathering = new Map<string, Gathering>()
  #bytes = 0

  /** Take one part. Returns the blob it completes, if it completes one.
   *  A part that contradicts those before it under the same id drops the
   *  whole blob: no conformant sender produces that. */
  add(device: string, part: BoardPart): BoardBlob | undefined {
    let data: Uint8Array
    try { data = base64.decode(part.data) } catch { return undefined }
    if (data.byteLength === 0 || data.byteLength > MAX_BOARD_PART_BYTES) return undefined
    if (part.count === 1) return { kind: part.kind, bytes: data }
    const key = `${device}:${part.blob}`
    let entry = this.#gathering.get(key)
    if (entry && (entry.kind !== part.kind || entry.count !== part.count)) { this.#drop(key); return undefined }
    if (!entry) {
      entry = { kind: part.kind, count: part.count, parts: new Map(), bytes: 0 }
      this.#gathering.set(key, entry)
    }
    if (entry.parts.has(part.index)) return undefined
    entry.parts.set(part.index, data)
    entry.bytes += data.byteLength
    this.#bytes += data.byteLength
    if (entry.parts.size === entry.count) {
      this.#drop(key)
      const bytes = new Uint8Array(entry.bytes)
      let offset = 0
      for (let index = 0; index < entry.count; index++) {
        const piece = entry.parts.get(index)!
        bytes.set(piece, offset)
        offset += piece.byteLength
      }
      return { kind: entry.kind, bytes }
    }
    while (this.#gathering.size > MAX_GATHERING || this.#bytes > MAX_GATHERING_BYTES) {
      const oldest = this.#gathering.keys().next().value
      if (oldest === undefined) break
      this.#drop(oldest)
    }
    return undefined
  }

  clear(): void {
    this.#gathering.clear()
    this.#bytes = 0
  }

  #drop(key: string): void {
    const entry = this.#gathering.get(key)
    if (!entry) return
    this.#bytes -= entry.bytes
    this.#gathering.delete(key)
  }
}

/**
 * The state every room board starts from, as padded standard base64: three
 * columns and the board view, written by a fixed Yjs client with fixed ids
 * and no clock reading. Every member applies exactly these 402 bytes, so
 * two who open an empty room at once hold one set of columns rather than a
 * set each. Girnel's `roomBoardGenesis()` builds them and its tests hold it
 * to this constant; `room-board.vectors.json` carries them for any other
 * implementation.
 */
export const ROOM_BOARD_GENESIS =
  'ARkBACgBBG1ldGEHYm9hcmRJZAF3BHJvb20oAQRtZXRhBG5hbWUBdwVCb2FyZCgBBG1ldGEJY3JlYXRlZEF0AX0AJwEHY29sdW1ucwR0b2RvASgAAQMCaWQB' +
  'dwR0b2RvKAABAwRuYW1lAXcFVG8gZG8oAAEDBW9yZGVyAXcBNSgAAQMGaXNEb25lAXkoAAEDCGFyY2hpdmVkAXknAQdjb2x1bW5zBWRvaW5nASgAAQkCaWQB' +
  'dwVkb2luZygAAQkEbmFtZQF3BURvaW5nKAABCQVvcmRlcgF3AjU1KAABCQZpc0RvbmUBeSgAAQkIYXJjaGl2ZWQBeScBB2NvbHVtbnMEZG9uZQEoAAEPAmlk' +
  'AXcEZG9uZSgAAQ8EbmFtZQF3BERvbmUoAAEPBW9yZGVyAXcDNTU1KAABDwZpc0RvbmUBeCgAAQ8IYXJjaGl2ZWQBeScBBXZpZXdzBWJvYXJkASgAARUCaWQB' +
  'dwVib2FyZCgAARUEdHlwZQF3BWJvYXJkKAABFQRuYW1lAXcFQm9hcmQA'

export function roomBoardGenesis(): Uint8Array {
  return base64.decode(ROOM_BOARD_GENESIS)
}

/** One record of this device's copy: already encrypted, named by its hash. */
export interface RoomBoardRecord { id: string; record: string }

/**
 * This device's own copy of the board: a set of records, not a file.
 *
 * Each record is some of the board's changes, and they merge in any order,
 * so the copy needs no head, no chain and no single writer. Two tabs of one
 * browser, or two processes over one directory, add records side by side and
 * neither can undo the other: a writer only ever removes records whose
 * contents it has read and has written again in a record of its own. An
 * adapter must make each `add` durable before it resolves and must report
 * failures; it never needs a lock.
 */
export interface RoomBoardStorage {
  /** Every record kept, in any order. */
  list(): Promise<RoomBoardRecord[]>
  /** Keep one more, and say what it is called: `roomBoardRecordId`. */
  add(record: string): Promise<string>
  /** Forget these. A name that is not kept is not an error. */
  remove(ids: readonly string[]): Promise<void>
}

/** A record's name: the SHA-256 of its text, as lower-case hex. */
export function roomBoardRecordId(record: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(record)))
}

/** A copy kept in memory: for tests, for an agent with nowhere to keep one,
 *  and for a board that must leave nothing behind. */
export function memoryRoomBoardStorage(records = new Map<string, string>()): RoomBoardStorage & { readonly records: Map<string, string> } {
  return {
    records,
    list: async () => [...records].map(([id, record]) => ({ id, record })),
    add: async record => { const id = roomBoardRecordId(record); records.set(id, record); return id },
    remove: async ids => { for (const id of ids) records.delete(id) },
  }
}

/** HKDF info for the key a device seals its own copy of the board under,
 *  followed by `:` and the room id. Never on the wire. */
export const ROOM_BOARD_CACHE_KEY_INFO = 'kithmoot/v1/room-board-cache'

/** Every versioned label this module owns, for `labels.test.ts`. Pure data:
 *  adding it changes no runtime behaviour. */
export const ROOM_BOARD_LABELS = [
  'kithmoot/v1/room-board-cache',
] as const
