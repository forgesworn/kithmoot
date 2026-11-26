import * as Y from 'yjs'
import { nip44 } from 'nostr-tools'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { base64 } from '@scure/base'
import type { ExpirationDeadline } from './expiration.js'
import { decodeChatEvent, deriveChannel, encodeChatEvent, type EpochRoot } from './chat.js'
import { verifyDeviceCredential } from './credential.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import type { AgentOwnership, DeviceCredential, KindredProof, RoomPolicy } from './types.js'
import { ROOM_BOARD_CACHE_KEY_INFO, ROOM_BOARD_CHANNEL, type BoardPart, type RoomBoardStorage } from './room-board-wire.js'
import { RoomBoardSync, type RoomBoardCopy, type RoomBoardCopyRecord, type RoomBoardStatus, type RoomBoardSyncTiming } from './room-board-sync.js'

export type { RoomBoardRecord, RoomBoardStorage } from './room-board-wire.js'
export { ROOM_BOARD_REMOTE, type RoomBoardStatus } from './room-board-sync.js'

export interface RoomBoardLogOptions {
  roomId: string
  roomKey: Uint8Array
  transport: RelayTransport
  deviceSk: Uint8Array
  /** This device's current room credential: what every envelope carries. */
  credential: () => DeviceCredential | undefined
  /** Asked once when the credential has run out, before a send is refused. */
  renewCredential?: () => Promise<unknown>
  policy?: RoomPolicy
  proof?: KindredProof
  owner?: AgentOwnership
  name?: string
  /** The epoch the room is in. Omit for epoch 0. */
  epoch?: EpochRoot
  storage: RoomBoardStorage
  /** Unix seconds. */
  now?: () => number
  /** A conference room's end: every envelope carries it as an expiration. */
  expiresAt?: ExpirationDeadline
  /** Test seams. Milliseconds. */
  timing?: RoomBoardSyncTiming
}

/** Bytes of the board one local record holds: its base64 form stays inside
 *  a NIP-44 plaintext. */
const CACHE_CHUNK_BYTES = 30_000
const MAX_CACHE_CHUNKS = 4096
const MAX_RECORDS_READ = 4096
const encoder = new TextEncoder()
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The key a device seals its own copy of one room's board under. Never on the wire. */
export function roomBoardCacheKey(roomId: string, roomKey: Uint8Array): Uint8Array {
  return hkdf(sha256, roomKey, undefined, encoder.encode(`${ROOM_BOARD_CACHE_KEY_INFO}:${roomId}`), 32)
}

/**
 * This device's copy of the board in `storage`, each record sealed under `key`
 * (`roomBoardCacheKey`): the board's bytes in chunks, each NIP-44 encrypted.
 * A record that is not one this key sealed, whole, around a well-formed update
 * is counted and left exactly as it is.
 */
export function sealedRoomBoardCopy(storage: RoomBoardStorage, key: Uint8Array): RoomBoardCopy {
  const seal = (bytes: Uint8Array): string => {
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += CACHE_CHUNK_BYTES) {
      chunks.push(nip44.v2.encrypt(base64.encode(bytes.subarray(offset, offset + CACHE_CHUNK_BYTES)), key))
    }
    return JSON.stringify({ v: 1, update: chunks })
  }
  const unseal = (raw: string): Uint8Array => {
    const record: unknown = JSON.parse(raw)
    if (!object(record) || record.v !== 1 || Object.keys(record).length !== 2 || !Object.hasOwn(record, 'update')) throw new Error('Invalid board record')
    const chunks = record.update
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_CACHE_CHUNKS) throw new Error('Invalid board record')
    const pieces: Uint8Array[] = []
    let total = 0
    for (const chunk of chunks) {
      if (typeof chunk !== 'string') throw new Error('Invalid board record')
      const piece = base64.decode(nip44.v2.decrypt(chunk, key))
      if (piece.byteLength === 0 || piece.byteLength > CACHE_CHUNK_BYTES) throw new Error('Invalid board record')
      pieces.push(piece)
      total += piece.byteLength
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength }
    Y.decodeUpdate(bytes)
    return bytes
  }
  return {
    read: async () => {
      const records = await storage.list()
      if (!Array.isArray(records)) throw new Error('Invalid board copy')
      const opened: RoomBoardCopyRecord[] = []
      let unread = 0
      for (const entry of records.slice(0, MAX_RECORDS_READ)) {
        try {
          if (!object(entry) || typeof entry.id !== 'string' || typeof entry.record !== 'string') throw new Error('Invalid board record')
          opened.push({ id: entry.id, update: unseal(entry.record) })
        } catch { unread++ }
      }
      if (records.length > MAX_RECORDS_READ) unread += records.length - MAX_RECORDS_READ
      return { records: opened, unread }
    },
    add: update => storage.add(seal(update)),
    remove: ids => storage.remove(ids),
  }
}

/**
 * The room's own board, kept in step with every other member's.
 *
 * `doc` is the board: a Yjs document that every member edits and nobody
 * keeps. This log does three things for it, and nothing else.
 *
 * It reads the room's board stream, a channel of the room under the room's
 * current epoch, authenticated envelope by envelope exactly as chat is, and
 * merges every change into `doc`.
 *
 * It keeps a second document, the stream's: everything the room's relays
 * are known to hold in this epoch. Whatever `doc` holds that the stream's
 * does not is what this device still owes the room, whether because it was
 * written offline, because a relay forgot it, or because the room has moved
 * to an epoch whose stream starts empty. One rule covers all three: send
 * the difference. That is the outbox, the repair and the hand-over after a
 * rekey, and it is why the board needs no keeper: any device that holds the
 * board puts it back.
 *
 * It keeps this device's copy, encrypted, so the board opens without a
 * relay and survives every relay forgetting it.
 *
 * Every member of the room, agents included, edits on equal terms. A change
 * is authenticated as coming from a member; what it says inside the board
 * (who wrote a comment, who moved a card) is that member's claim.
 *
 * What it does with the board's bytes is `RoomBoardSync`, which holds no key;
 * this adds the room's keys: opening and checking what the stream carries,
 * sealing and signing what this device sends, and sealing its copy.
 */
export class RoomBoardLog {
  readonly #opts: RoomBoardLogOptions
  readonly #sync: RoomBoardSync<Event>
  #epoch?: EpochRoot
  #listening = false

  constructor(opts: RoomBoardLogOptions) {
    this.#opts = opts
    this.#epoch = opts.epoch
    this.#sync = new RoomBoardSync<Event>({
      envelope: part => this.#envelope(part),
      publish: outer => opts.transport.publish(outer),
      copy: sealedRoomBoardCopy(opts.storage, roomBoardCacheKey(opts.roomId, opts.roomKey)),
      ...(opts.timing ? { timing: opts.timing } : {}),
    })
  }

  /** The board. Edit it directly (an agent does) or through `apply`. Every
   *  change made here is saved and sent, whoever made it. */
  get doc(): Y.Doc { return this.#sync.doc }
  get roomId(): string { return this.#opts.roomId }
  get closed(): boolean { return this.#sync.closed }

  /** The whole board as one Yjs update: what a view starts from. */
  state(): Uint8Array { return this.#sync.state() }

  status(): RoomBoardStatus { return this.#sync.status() }

  /** Told of every change to the board after `open`, with where it came
   *  from: `ROOM_BOARD_REMOTE` for the room's, otherwise the `source` its
   *  `apply` named. A view ignores its own. */
  onUpdate(cb: (update: Uint8Array, source: unknown) => void): () => void { return this.#sync.onUpdate(cb) }

  onStatus(cb: () => void): () => void { return this.#sync.onStatus(cb) }

  /** Read this device's copy, then start listening to the room. Resolves
   *  once the copy is in `doc`; `status().ready` follows when the room's
   *  stream has been read. */
  async open(): Promise<void> {
    await this.#sync.open()
    if (this.#sync.closed) return
    this.#listen()
  }

  /** A change made on this device, as a Yjs update. `source` comes back to
   *  `onUpdate` listeners so the view that made it can ignore the echo. */
  apply(update: Uint8Array, source?: unknown): void {
    if (source === undefined) this.#sync.apply(update)
    else this.#sync.apply(update, source)
  }

  /** Send now whatever the room lacks, rather than after the usual pause.
   *  Resolves when that try has finished, sent or not: see `status()`. */
  flush(): Promise<void> { return this.#sync.flush() }

  /** The room has moved to a new epoch: listen there, and hand it the board. */
  rekey(epoch: EpochRoot): void {
    if (this.#sync.closed) return
    this.#epoch = epoch
    if (this.#listening) this.#listen()
  }

  /** Stop listening and sending, and finish writing this device's copy. */
  close(): Promise<void> { return this.#sync.close() }

  // -------------------------------------------------------------------
  // The room's stream, opened and sealed
  // -------------------------------------------------------------------

  #now(): number { return (this.#opts.now ?? (() => Math.floor(Date.now() / 1000)))() }

  #decodeOptions() {
    return { roomId: this.#opts.roomId, roomKey: this.#opts.roomKey, channel: ROOM_BOARD_CHANNEL,
      epoch: this.#epoch, policy: this.#opts.policy, now: this.#now() }
  }

  #listen(): void {
    this.#listening = true
    this.#sync.listen(stream => {
      const root = this.#epoch ?? { id: this.#opts.roomId, key: this.#opts.roomKey }
      const { id } = deriveChannel(root.id, root.key, ROOM_BOARD_CHANNEL)
      return this.#opts.transport.subscribe([{ kinds: [KINDS.CHAT], '#d': [id] }], outer => {
        if (!stream.admit(outer.id)) return
        const message = decodeChatEvent(outer, this.#decodeOptions())
        if (message?.board) stream.receive(message.device, message.board, message.sentAt)
      }, () => stream.caughtUp())
    })
  }

  async #envelope(part: BoardPart): Promise<Event> {
    const usable = (credential: DeviceCredential | undefined, now: number): credential is DeviceCredential =>
      !!credential && verifyDeviceCredential(credential, { roomId: this.#opts.roomId, now }).ok
    let credential = this.#opts.credential()
    if (!usable(credential, this.#now())) {
      await this.#opts.renewCredential?.()
      credential = this.#opts.credential()
    }
    const sentAt = this.#now()
    if (!usable(credential, sentAt)) throw new Error("This device's access to the room ran out, so the board change was not sent")
    const verdict = verifyDeviceCredential(credential, { roomId: this.#opts.roomId, now: sentAt })
    if (!verdict.ok) throw new Error("This device's access to the room ran out, so the board change was not sent")
    const opts = this.#opts
    const outer = encodeChatEvent({
      id: bytesToHex(randomBytes(16)), participant: verdict.participant, device: getPublicKey(opts.deviceSk),
      credential, text: 'Board update', sentAt, board: part,
      ...(opts.name ? { name: opts.name } : {}), ...(opts.proof ? { proof: opts.proof } : {}),
      ...(opts.owner ? { owner: opts.owner } : {}),
    }, { roomId: opts.roomId, roomKey: opts.roomKey, deviceSk: opts.deviceSk, channel: ROOM_BOARD_CHANNEL, epoch: this.#epoch, expiresAt: opts.expiresAt })
    // A relay can accept what every reader will refuse. Check as a reader.
    if (!decodeChatEvent(outer, this.#decodeOptions())?.board) throw new Error('Room access changed, so the board change was not sent')
    return outer
  }
}
