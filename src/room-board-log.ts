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
import {
  BoardAssembler, MAX_BOARD_BLOB_BYTES, ROOM_BOARD_CACHE_KEY_INFO, ROOM_BOARD_CHANNEL, roomBoardGenesis, splitBoardBlob,
  type BoardBlob, type BoardBlobKind, type BoardPart, type RoomBoardRecord, type RoomBoardStorage,
} from './room-board-wire.js'

export type { RoomBoardRecord, RoomBoardStorage } from './room-board-wire.js'

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
  timing?: {
    /** Quiet time after an edit before it is sent. */
    flushMs?: number
    /** The longest an edit waits while more keep arriving. */
    flushMaxMs?: number
    /** After the stream has been read, how long to wait (a random moment in
     *  this range) before sending what it lacks, so several devices that
     *  hold the same board do not all send it. */
    settleMs?: readonly [number, number]
    /** Wait after a failed send or save before the next try; doubles to 60 s. */
    retryMs?: number
    /** Quiet time before changes are written to this device. */
    persistMs?: number
    random?: () => number
  }
}

export interface RoomBoardStatus {
  /** The room's stream has been read to its end in the current epoch. */
  ready: boolean
  /** This device holds changes the room's relays are not known to hold. */
  pending: boolean
  /** What last went wrong sending or saving, until it goes right. */
  error?: string
}

/** A board with this many update events since the last whole copy gets a
 *  new whole copy, so a relay's newest page always holds a place to start. */
const SNAPSHOT_EVERY = 100
/** Events read from one epoch's stream before the rest are left unread. */
const MAX_STREAM_EVENTS = 20_000
/** Bytes of the board one local record holds: its base64 form stays inside
 *  a NIP-44 plaintext. */
const CACHE_CHUNK_BYTES = 30_000
const MAX_CACHE_CHUNKS = 4096
/** Records this device keeps before it writes the whole board as one and
 *  forgets the ones that record now covers. */
const COMPACT_RECORDS = 32
const MAX_RECORDS_READ = 4096
const encoder = new TextEncoder()
const utf8 = (value: string): number => encoder.encode(value).byteLength
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Marks a change that came from the room, as the source a listener sees. */
export const ROOM_BOARD_REMOTE = 'remote'
const CACHE = Symbol('room-board-cache')
const LOCAL = 'local'

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.()
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
 */
export class RoomBoardLog {
  readonly #opts: RoomBoardLogOptions
  readonly #cacheKey: Uint8Array
  readonly #listeners = new Set<(update: Uint8Array, source: unknown) => void>()
  readonly #statusListeners = new Set<() => void>()
  readonly #assembler = new BoardAssembler()
  #doc: Y.Doc
  #stream: Y.Doc
  #epoch?: EpochRoot
  #unsub?: () => void
  #generation = 0
  #opened = false
  #closed = false
  #ready = false
  #dirty = true
  #firstDirtyAt?: number
  #sendError?: string
  #saveError?: string
  #readError?: string
  #seen = new Set<string>()
  #snapshotAt?: number
  #updateTimes: number[] = []
  #flushTimer?: ReturnType<typeof setTimeout>
  #flushing?: Promise<void>
  #again = false
  #retryMs = 0
  #persistQueue: Uint8Array[] = []
  #persistTimer?: ReturnType<typeof setTimeout>
  #persistTail: Promise<void> = Promise.resolve()
  /** The records this log has read and applied, or written: the only ones
   *  it may ever remove. Name to size. */
  #kept = new Map<string, number>()
  #copyWarning?: string

  constructor(opts: RoomBoardLogOptions) {
    this.#opts = opts
    this.#epoch = opts.epoch
    this.#cacheKey = hkdf(sha256, opts.roomKey, undefined, encoder.encode(`${ROOM_BOARD_CACHE_KEY_INFO}:${opts.roomId}`), 32)
    this.#doc = this.#fresh()
    this.#stream = this.#fresh()
    this.#doc.on('update', (update: Uint8Array, origin: unknown) => this.#changed(update, origin))
  }

  /** The board. Edit it directly (an agent does) or through `apply`. Every
   *  change made here is saved and sent, whoever made it. */
  get doc(): Y.Doc { return this.#doc }
  get roomId(): string { return this.#opts.roomId }
  get closed(): boolean { return this.#closed }

  /** The whole board as one Yjs update: what a view starts from. */
  state(): Uint8Array { return Y.encodeStateAsUpdate(this.#doc) }

  status(): RoomBoardStatus {
    const error = this.#sendError ?? this.#saveError ?? this.#copyWarning ?? this.#readError
    return { ready: this.#ready && !this.#closed, pending: this.#dirty, ...(error ? { error } : {}) }
  }

  /** Told of every change to the board after `open`, with where it came
   *  from: `ROOM_BOARD_REMOTE` for the room's, otherwise the `source` its
   *  `apply` named. A view ignores its own. */
  onUpdate(cb: (update: Uint8Array, source: unknown) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  onStatus(cb: () => void): () => void {
    this.#statusListeners.add(cb)
    return () => this.#statusListeners.delete(cb)
  }

  /** Read this device's copy, then start listening to the room. Resolves
   *  once the copy is in `doc`; `status().ready` follows when the room's
   *  stream has been read. */
  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error('Board log already opened or closed')
    this.#opened = true
    await this.#load()
    if (this.#closed) return
    this.#subscribe()
  }

  /** A change made on this device, as a Yjs update. `source` comes back to
   *  `onUpdate` listeners so the view that made it can ignore the echo. */
  apply(update: Uint8Array, source: unknown = LOCAL): void {
    if (this.#closed || !this.#opened) throw new Error('This board is not open')
    if (source === ROOM_BOARD_REMOTE || source === CACHE) throw new Error('Invalid board change source')
    if (update.byteLength === 0 || update.byteLength > MAX_BOARD_BLOB_BYTES) throw new Error('This change is too large for the board')
    const bytes = new Uint8Array(update)
    Y.decodeUpdate(bytes)
    Y.applyUpdate(this.#doc, bytes, source)
  }

  /** Send now whatever the room lacks, rather than after the usual pause.
   *  Resolves when that try has finished, sent or not: see `status()`. */
  async flush(): Promise<void> {
    if (this.#closed || !this.#ready) return
    this.#clearFlushTimer()
    await this.#flush()
  }

  /** The room has moved to a new epoch: listen there, and hand it the board. */
  rekey(epoch: EpochRoot): void {
    if (this.#closed) return
    this.#epoch = epoch
    if (this.#opened && this.#unsub) this.#subscribe()
  }

  /** Stop listening and sending, and finish writing this device's copy. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    ++this.#generation
    this.#unsub?.()
    this.#unsub = undefined
    this.#clearFlushTimer()
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = undefined }
    await this.#persist().catch(() => {})
    this.#listeners.clear()
    this.#statusListeners.clear()
    this.#assembler.clear()
  }

  // -------------------------------------------------------------------
  // The room's stream
  // -------------------------------------------------------------------

  #fresh(): Y.Doc {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, roomBoardGenesis(), CACHE)
    return doc
  }

  #now(): number { return (this.#opts.now ?? (() => Math.floor(Date.now() / 1000)))() }

  #emitStatus(): void { for (const cb of [...this.#statusListeners]) { try { cb() } catch { /* a listener's problem */ } } }

  #decodeOptions() {
    return { roomId: this.#opts.roomId, roomKey: this.#opts.roomKey, channel: ROOM_BOARD_CHANNEL,
      epoch: this.#epoch, policy: this.#opts.policy, now: this.#now() }
  }

  #subscribe(): void {
    this.#unsub?.()
    const generation = ++this.#generation
    // Nothing is known about what the new stream holds until it is read.
    this.#stream.destroy()
    this.#stream = this.#fresh()
    this.#assembler.clear()
    this.#seen = new Set()
    this.#snapshotAt = undefined
    this.#updateTimes = []
    this.#ready = false
    this.#dirty = true
    this.#readError = undefined
    this.#clearFlushTimer()
    const root = this.#epoch ?? { id: this.#opts.roomId, key: this.#opts.roomKey }
    const { id } = deriveChannel(root.id, root.key, ROOM_BOARD_CHANNEL)
    this.#unsub = this.#opts.transport.subscribe([{ kinds: [KINDS.CHAT], '#d': [id] }], outer => {
      if (generation !== this.#generation || this.#closed) return
      this.#receive(outer)
    }, () => {
      if (generation !== this.#generation || this.#closed || this.#ready) return
      this.#ready = true
      if (this.#inStep()) {
        this.#dirty = false
        this.#firstDirtyAt = undefined
      } else {
        // Several devices may hold what this stream lacks. Each waits a
        // different moment, and looks again before it sends.
        const [low, high] = this.#opts.timing?.settleMs ?? [1_500, 6_000]
        this.#schedule(low + Math.floor((this.#opts.timing?.random ?? Math.random)() * Math.max(0, high - low)))
      }
      this.#emitStatus()
    })
    this.#emitStatus()
  }

  #receive(outer: Event): void {
    if (this.#seen.has(outer.id)) return
    if (this.#seen.size >= MAX_STREAM_EVENTS) {
      if (!this.#readError) { this.#readError = 'This board has more history than this device will read'; this.#emitStatus() }
      return
    }
    this.#seen.add(outer.id)
    const message = decodeChatEvent(outer, this.#decodeOptions())
    if (!message?.board) return
    const blob = this.#assembler.add(message.device, message.board)
    if (blob) this.#accept(blob, message.sentAt)
  }

  #accept(blob: BoardBlob, sentAt: number): void {
    // Refused whole before either document is touched: a malformed update
    // must not get half way into the board.
    try { Y.decodeUpdate(blob.bytes) } catch { return }
    try {
      Y.applyUpdate(this.#stream, blob.bytes, ROOM_BOARD_REMOTE)
      Y.applyUpdate(this.#doc, blob.bytes, ROOM_BOARD_REMOTE)
    } catch { return }
    this.#noteStreamBlob(blob.kind, sentAt)
  }

  #noteStreamBlob(kind: BoardBlobKind, at: number): void {
    if (kind === 'snapshot') {
      this.#snapshotAt = Math.max(this.#snapshotAt ?? 0, at)
      this.#updateTimes = this.#updateTimes.filter(time => time > this.#snapshotAt!)
    } else if (this.#snapshotAt === undefined || at > this.#snapshotAt) {
      this.#updateTimes.push(at)
      if (this.#updateTimes.length > 4 * SNAPSHOT_EVERY) this.#updateTimes.splice(0, this.#updateTimes.length - 4 * SNAPSHOT_EVERY)
    }
  }

  // -------------------------------------------------------------------
  // What this device owes the room
  // -------------------------------------------------------------------

  #changed(update: Uint8Array, origin: unknown): void {
    if (origin === CACHE || this.#closed) return
    this.#persistQueue.push(update)
    this.#schedulePersist()
    for (const cb of [...this.#listeners]) { try { cb(update, origin) } catch { /* a listener's problem */ } }
    if (origin === ROOM_BOARD_REMOTE) return
    const wasDirty = this.#dirty
    this.#dirty = true
    if (!wasDirty) this.#emitStatus()
    // A failed send is already waiting its turn; more edits do not hurry it.
    if (this.#retryMs && this.#flushTimer) return
    this.#firstDirtyAt ??= Date.now()
    const quiet = this.#opts.timing?.flushMs ?? 1_200
    const longest = this.#opts.timing?.flushMaxMs ?? 5_000
    this.#schedule(Math.max(0, Math.min(quiet, this.#firstDirtyAt + longest - Date.now())))
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = undefined }
  }

  #schedule(delay: number): void {
    if (this.#closed) return
    this.#clearFlushTimer()
    this.#flushTimer = setTimeout(() => { this.#flushTimer = undefined; void this.#flush() }, delay)
    unref(this.#flushTimer)
  }

  #inStep(): boolean {
    return Y.equalSnapshots(Y.snapshot(this.#doc), Y.snapshot(this.#stream))
  }

  #flush(): Promise<void> {
    if (this.#flushing) { this.#again = true; return this.#flushing }
    const run = this.#send().finally(() => {
      this.#flushing = undefined
      if (this.#again && !this.#closed) { this.#again = false; this.#schedule(0) }
    })
    this.#flushing = run
    return run
  }

  async #send(): Promise<void> {
    if (this.#closed || !this.#ready) return
    const generation = this.#generation
    try {
      // More than one round only when the board changed while a blob was
      // on its way; each round sends everything the stream then lacks.
      for (let round = 0; round < 8; round++) {
        if (this.#inStep()) {
          this.#dirty = false
          this.#firstDirtyAt = undefined
          this.#sendError = undefined
          this.#retryMs = 0
          return
        }
        let whole = this.#snapshotAt === undefined || this.#updateTimes.length >= SNAPSHOT_EVERY
        let bytes = whole ? Y.encodeStateAsUpdate(this.#doc) : Y.encodeStateAsUpdate(this.#doc, Y.encodeStateVector(this.#stream))
        if (whole && bytes.byteLength > MAX_BOARD_BLOB_BYTES) {
          // Too large to hand over whole. What the stream lacks still goes.
          whole = false
          bytes = Y.encodeStateAsUpdate(this.#doc, Y.encodeStateVector(this.#stream))
        }
        if (bytes.byteLength > MAX_BOARD_BLOB_BYTES) throw new Error('This board has grown too large to share')
        const sentAt = await this.#publish(whole ? 'snapshot' : 'update', bytes, generation)
        if (generation !== this.#generation || this.#closed) return
        const before = Y.snapshot(this.#stream)
        Y.applyUpdate(this.#stream, bytes, ROOM_BOARD_REMOTE)
        this.#noteStreamBlob(whole ? 'snapshot' : 'update', sentAt)
        if (Y.equalSnapshots(before, Y.snapshot(this.#stream))) throw new Error('The board could not be brought into step with the room')
      }
      this.#again = true
    } catch (e) {
      if (generation !== this.#generation || this.#closed) return
      this.#sendError = e instanceof Error ? e.message : String(e)
      this.#firstDirtyAt = undefined
      this.#retryMs = Math.min(60_000, this.#retryMs ? this.#retryMs * 2 : this.#opts.timing?.retryMs ?? 5_000)
      this.#schedule(this.#retryMs)
    } finally {
      this.#emitStatus()
    }
  }

  async #publish(kind: BoardBlobKind, bytes: Uint8Array, generation: number): Promise<number> {
    let sentAt = this.#now()
    for (const part of splitBoardBlob(kind, bytes, bytesToHex(randomBytes(16)))) {
      if (generation !== this.#generation || this.#closed) return sentAt
      const outer = await this.#envelope(part)
      if (generation !== this.#generation || this.#closed) return sentAt
      sentAt = outer.created_at
      this.#seen.add(outer.id)
      await this.#opts.transport.publish(outer)
    }
    return sentAt
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

  // -------------------------------------------------------------------
  // This device's copy
  // -------------------------------------------------------------------

  #seal(bytes: Uint8Array): string {
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.byteLength; offset += CACHE_CHUNK_BYTES) {
      chunks.push(nip44.v2.encrypt(base64.encode(bytes.subarray(offset, offset + CACHE_CHUNK_BYTES)), this.#cacheKey))
    }
    return JSON.stringify({ v: 1, update: chunks })
  }

  /** The update a record holds. Throws on anything but a record this key
   *  sealed, whole, around a well-formed update. */
  #unseal(raw: string): Uint8Array {
    const record: unknown = JSON.parse(raw)
    if (!object(record) || record.v !== 1 || Object.keys(record).length !== 2 || !Object.hasOwn(record, 'update')) throw new Error('Invalid board record')
    const chunks = record.update
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_CACHE_CHUNKS) throw new Error('Invalid board record')
    const pieces: Uint8Array[] = []
    let total = 0
    for (const chunk of chunks) {
      if (typeof chunk !== 'string') throw new Error('Invalid board record')
      const piece = base64.decode(nip44.v2.decrypt(chunk, this.#cacheKey))
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

  async #load(): Promise<void> {
    let records: RoomBoardRecord[]
    try {
      records = await this.#opts.storage.list()
      if (!Array.isArray(records)) throw new Error('Invalid board copy')
    } catch {
      // Nothing can be read here. The board still opens from the room, and
      // says that this device is not keeping it.
      this.#saveError = 'This board could not be read from this device; it is open here from the room'
      return
    }
    let unread = 0
    for (const entry of records.slice(0, MAX_RECORDS_READ)) {
      let bytes: Uint8Array
      try {
        if (!object(entry) || typeof entry.id !== 'string' || typeof entry.record !== 'string') throw new Error('Invalid board record')
        bytes = this.#unseal(entry.record)
      } catch {
        // Left exactly as it is, and never counted among the records this
        // log may remove: it may hold work that was never sent.
        unread++
        continue
      }
      try { Y.applyUpdate(this.#doc, bytes, CACHE) } catch { unread++; continue }
      this.#kept.set(entry.id, utf8(entry.record))
    }
    if (records.length > MAX_RECORDS_READ) unread += records.length - MAX_RECORDS_READ
    if (unread) this.#copyWarning = 'Part of the copy of this board kept on this device could not be read. It has been left as it is; the rest is open'
  }

  #schedulePersist(): void {
    if (this.#persistTimer || this.#closed) return
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined
      void this.#persist().catch(() => {})
    }, this.#opts.timing?.persistMs ?? 250)
    unref(this.#persistTimer)
  }

  #persist(): Promise<void> {
    const task = this.#persistTail.then(async () => {
      if (!this.#persistQueue.length) return
      const queued = this.#persistQueue.splice(0)
      try {
        const record = this.#seal(queued.length === 1 ? queued[0]! : Y.mergeUpdates(queued))
        this.#kept.set(await this.#opts.storage.add(record), utf8(record))
        if (this.#kept.size >= COMPACT_RECORDS) await this.#compact()
        if (this.#saveError) { this.#saveError = undefined; this.#emitStatus() }
      } catch (e) {
        // Still held in memory and still sent; written again with the next
        // change or the next try, whichever comes first.
        this.#persistQueue.unshift(...queued)
        if (!this.#saveError) { this.#saveError = 'This board could not be saved on this device; it stays open here and with the room'; this.#emitStatus() }
        if (!this.#closed) {
          if (this.#persistTimer) clearTimeout(this.#persistTimer)
          this.#persistTimer = setTimeout(() => { this.#persistTimer = undefined; void this.#persist().catch(() => {}) }, this.#opts.timing?.retryMs ?? 5_000)
          unref(this.#persistTimer)
        }
        throw e
      }
    })
    this.#persistTail = task.catch(() => {})
    return task
  }

  /** Write the whole board as one record, then forget the records it now
   *  covers: those this log read or wrote, and no others. A record another
   *  tab added meanwhile is not among them, so it stays. Stopping half way
   *  leaves more records than needed and loses nothing. */
  async #compact(): Promise<void> {
    const covered = [...this.#kept.keys()]
    const record = this.#seal(Y.encodeStateAsUpdate(this.#doc))
    const id = await this.#opts.storage.add(record)
    this.#kept = new Map([[id, utf8(record)]])
    await this.#opts.storage.remove(covered.filter(old => old !== id)).catch(() => {})
  }
}
