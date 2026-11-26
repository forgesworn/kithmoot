import * as Y from 'yjs'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import {
  BoardAssembler, MAX_BOARD_BLOB_BYTES, roomBoardGenesis, splitBoardBlob, validBoardPart,
  type BoardBlob, type BoardBlobKind, type BoardPart,
} from './room-board-wire.js'

/**
 * The part of the room's board that holds no key.
 *
 * `RoomBoardLog` is the board for a device that holds the room's key: it reads
 * and writes the room's stream and seals this device's copy. Everything it does
 * with the board's bytes is here, and none of what it does with keys. This
 * keeps the board (a Yjs document), knows what the room's stream holds, sends
 * whatever the board holds that the stream lacks, and keeps a copy on the
 * device. It never opens, seals, signs or verifies anything: its host does that
 * and hands it parts already authenticated, and seals each part it sends.
 *
 * That is so that a host which keeps the room's key somewhere else, such as an
 * app whose board screen is a web page kept apart from its keys, runs the same
 * board as the web does and no copy of its rules.
 */

/** What the host makes of a part it sends: an event of the room's board stream,
 *  sealed and signed. This only reads its id and its time. */
export interface RoomBoardEnvelope {
  /** The event's id, as the stream will carry it. */
  id: string
  /** Unix seconds: the time the event says it was sent. */
  created_at: number
}

/** One record of this device's copy, opened. */
export interface RoomBoardCopyRecord { id: string; update: Uint8Array }

/**
 * This device's copy of the board, as its host keeps it: a set of records, each
 * some of the board's changes as a Yjs update. The host seals them (or keeps
 * them somewhere already private); this only adds whole updates and removes
 * records it has read or written. See `RoomBoardStorage` for the rules a copy
 * keeps.
 */
export interface RoomBoardCopy {
  /** Every record that could be opened, and how many could not. A record that
   *  could not be opened is the host's to leave exactly as it is. Throws when
   *  nothing can be read. */
  read(): Promise<{ records: RoomBoardCopyRecord[]; unread: number }>
  /** Keep one more record, durably, and say what it is called. */
  add(update: Uint8Array): Promise<string>
  /** Forget these. A name that is not kept is not an error. */
  remove(ids: readonly string[]): Promise<void>
}

export interface RoomBoardSyncTiming {
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

export interface RoomBoardSyncOptions<E extends RoomBoardEnvelope = RoomBoardEnvelope> {
  /** One part as an event of the room's board stream, sealed and signed by this
   *  device, and checked as a reader would check it. Rejects, in words for the
   *  person, when it cannot be: the change then waits and is tried again. */
  envelope(part: BoardPart): Promise<E>
  /** Hand one sealed event to the room's relays. Resolves once a relay has
   *  taken it, and rejects when none has: until it resolves, the board counts
   *  the change as not yet the room's. */
  publish(envelope: E): Promise<void>
  copy: RoomBoardCopy
  /** Test seams. Milliseconds. */
  timing?: RoomBoardSyncTiming
}

export interface RoomBoardStatus {
  /** The room's stream has been read to its end in the current epoch. */
  ready: boolean
  /** This device holds changes the room's relays are not known to hold. */
  pending: boolean
  /** What last went wrong sending or saving, until it goes right. */
  error?: string
}

/**
 * One reading of the room's board stream, from its start. The host listens to
 * the stream and hands each event here; a newer reading (after the room moves
 * epoch) makes this one stale, and a stale reading takes nothing.
 */
export interface RoomBoardStream {
  /** Whether to open this event: false for one already read in this reading,
   *  for one past the most this device will read, and once the reading is
   *  stale. Ask before opening an event, and open it only on true. */
  admit(eventId: string): boolean
  /** One part from an event the host has opened and authenticated as a
   *  member's, in this room, this epoch and the board's channel. `device` is
   *  the event's authenticated device; `sentAt` the time it says it was sent,
   *  in Unix seconds. */
  receive(device: string, part: BoardPart, sentAt: number): void
  /** Every event the stream held when the reading began has been handed over. */
  caughtUp(): void
}

/** A board with this many update events since the last whole copy gets a
 *  new whole copy, so a relay's newest page always holds a place to start. */
const SNAPSHOT_EVERY = 100
/** Events read from one epoch's stream before the rest are left unread. */
const MAX_STREAM_EVENTS = 20_000
/** Records this device keeps before it writes the whole board as one and
 *  forgets the ones that record now covers. */
const COMPACT_RECORDS = 32

/** Marks a change that came from the room, as the source a listener sees. */
export const ROOM_BOARD_REMOTE = 'remote'
const CACHE = Symbol('room-board-cache')
const LOCAL = 'local'

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.()
}

/**
 * The room's own board, kept in step with every other member's, by a host that
 * holds the keys. See `RoomBoardLog` for the board as a whole.
 *
 * `doc` is the board: a Yjs document that every member edits and nobody
 * keeps. Beside it is a second document, the stream's: everything the room's
 * relays are known to hold in this epoch. Whatever `doc` holds that the
 * stream's does not is what this device still owes the room, whether because
 * it was written offline, because a relay forgot it, or because the room has
 * moved to an epoch whose stream starts empty. One rule covers all three: send
 * the difference.
 */
export class RoomBoardSync<E extends RoomBoardEnvelope = RoomBoardEnvelope> {
  readonly #opts: RoomBoardSyncOptions<E>
  readonly #listeners = new Set<(update: Uint8Array, source: unknown) => void>()
  readonly #statusListeners = new Set<() => void>()
  readonly #assembler = new BoardAssembler()
  #doc: Y.Doc
  #stream: Y.Doc
  #unlisten?: () => void
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
  /** The records this board has read and applied, or written: the only ones
   *  it may ever remove. */
  #kept = new Set<string>()
  #copyWarning?: string

  constructor(opts: RoomBoardSyncOptions<E>) {
    this.#opts = opts
    this.#doc = this.#fresh()
    this.#stream = this.#fresh()
    this.#doc.on('update', (update: Uint8Array, origin: unknown) => this.#changed(update, origin))
  }

  /** The board. Edit it directly (an agent does) or through `apply`. Every
   *  change made here is saved and sent, whoever made it. */
  get doc(): Y.Doc { return this.#doc }
  get opened(): boolean { return this.#opened }
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

  /** Read this device's copy into `doc`. Then `listen` to the room. */
  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error('Board log already opened or closed')
    this.#opened = true
    await this.#load()
  }

  /**
   * Start reading the room's stream from its start: after `open`, and again
   * whenever the room moves to a new epoch, whose stream this device must
   * hand the board to. `subscribe` starts the host listening, handing what
   * it hears to the stream it is given, and returns how to stop; it is
   * stopped when the next reading begins or the board closes.
   */
  listen(subscribe: (stream: RoomBoardStream) => () => void): void {
    if (this.#closed) return
    this.#unlisten?.()
    this.#unlisten = undefined
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
    const current = () => generation === this.#generation && !this.#closed
    this.#unlisten = subscribe({
      admit: eventId => {
        if (!current() || typeof eventId !== 'string' || this.#seen.has(eventId)) return false
        if (this.#seen.size >= MAX_STREAM_EVENTS) {
          if (!this.#readError) { this.#readError = 'This board has more history than this device will read'; this.#emitStatus() }
          return false
        }
        this.#seen.add(eventId)
        return true
      },
      receive: (device, part, sentAt) => {
        if (!current() || typeof device !== 'string' || !Number.isSafeInteger(sentAt) || !validBoardPart(part)) return
        const blob = this.#assembler.add(device, part)
        if (blob) this.#accept(blob, sentAt)
      },
      caughtUp: () => {
        if (!current() || this.#ready) return
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
      },
    })
    this.#emitStatus()
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

  /** Stop listening and sending, and finish writing this device's copy. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    ++this.#generation
    this.#unlisten?.()
    this.#unlisten = undefined
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

  #emitStatus(): void { for (const cb of [...this.#statusListeners]) { try { cb() } catch { /* a listener's problem */ } } }

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
    let sentAt = Math.floor(Date.now() / 1000)
    for (const part of splitBoardBlob(kind, bytes, bytesToHex(randomBytes(16)))) {
      if (generation !== this.#generation || this.#closed) return sentAt
      const outer = await this.#opts.envelope(part)
      if (generation !== this.#generation || this.#closed) return sentAt
      sentAt = outer.created_at
      this.#seen.add(outer.id)
      await this.#opts.publish(outer)
    }
    return sentAt
  }

  // -------------------------------------------------------------------
  // This device's copy
  // -------------------------------------------------------------------

  async #load(): Promise<void> {
    let copy: { records: RoomBoardCopyRecord[]; unread: number }
    try {
      copy = await this.#opts.copy.read()
      if (!copy || !Array.isArray(copy.records) || !Number.isSafeInteger(copy.unread) || copy.unread < 0) throw new Error('Invalid board copy')
    } catch {
      // Nothing can be read here. The board still opens from the room, and
      // says that this device is not keeping it.
      this.#saveError = 'This board could not be read from this device; it is open here from the room'
      return
    }
    let unread = copy.unread
    for (const record of copy.records) {
      // Never counted among the records this board may remove: it may hold
      // work that was never sent.
      if (!record || typeof record.id !== 'string' || !(record.update instanceof Uint8Array)) { unread++; continue }
      try { Y.applyUpdate(this.#doc, record.update, CACHE) } catch { unread++; continue }
      this.#kept.add(record.id)
    }
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
        this.#kept.add(await this.#opts.copy.add(queued.length === 1 ? queued[0]! : Y.mergeUpdates(queued)))
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
   *  covers: those this board read or wrote, and no others. A record another
   *  tab added meanwhile is not among them, so it stays. Stopping half way
   *  leaves more records than needed and loses nothing. */
  async #compact(): Promise<void> {
    const covered = [...this.#kept]
    const id = await this.#opts.copy.add(Y.encodeStateAsUpdate(this.#doc))
    this.#kept = new Set([id])
    await this.#opts.copy.remove(covered.filter(old => old !== id)).catch(() => {})
  }
}
