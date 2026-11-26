import { base64 } from '@scure/base'
import { RoomBoardSync, type RoomBoardCopyRecord, type RoomBoardEnvelope, type RoomBoardStream, type RoomBoardSyncTiming } from './room-board-sync.js'
import { validBoardPart, type BoardPart } from './room-board-wire.js'
import { roomBoardStatusWords } from './room-board-words.js'

/**
 * The room's board on a page that holds none of the room's keys, kept in step
 * through a message port by the app that holds them.
 *
 * The page runs the board (`RoomBoardSync`) and, when it is on screen,
 * Girnel's board view over it. The app at the other end of the port (the
 * native side) holds the room's key, this device's key and credential, and
 * the relays. It opens and checks every event of the board's stream and hands
 * the page the part inside; it seals and signs each part the page asks it
 * to, and publishes it; it keeps this device's copy; and it answers the
 * view's buttons (Invite, Discuss in chat, Assign to agent, a card's files)
 * as the room does anywhere else. No key, credential, relay address or
 * account crosses the port. `docs/room-board-port.md` is the contract.
 */

export const ROOM_BOARD_PORT_VERSION = 1
/** The longest message either side sends, in characters. */
export const ROOM_BOARD_PORT_MAX_MESSAGE = 48_000
/** Bytes of a copy record or a file that one message carries: 40,000
 *  characters of base64. */
export const ROOM_BOARD_PORT_CHUNK_BYTES = 30_000
/** Pieces one copy record is carried in. */
const MAX_RECORD_CHUNKS = 4096
/** Records the page reads from the copy. More are counted as unread. */
const MAX_RECORDS_READ = 4096
const MAX_RECORD_ID = 128
const REMOVE_BATCH = 256
const HEX64 = /^[0-9a-f]{64}$/
const MAX_WORDS = 500
const MAX_NAME = 4096
const MAX_TYPE = 255

/** A message port: a browser's `MessagePort`, or an Android WebView's port
 *  as the page sees it. Messages are strings. */
export interface RoomBoardPort {
  postMessage(message: string): void
  onmessage: ((event: { data: unknown }) => void) | null
  start?(): void
}

/** What the native side says first, once. */
export interface RoomBoardPortStart {
  /** This person, as 64 lower-case hex characters. */
  self: string
  /** Whether the room offers Invite people, Assign to agent and a card's files. */
  invite: boolean
  assign: boolean
  files: boolean
}

export interface RoomBoardPortFile { hash: string; key: string; name: string; type: string; size: number; encryptedSize: number; servers: string[] }
export interface RoomBoardPortCard { id: string; title: string; description: string }

/** What Girnel's room view is started with (`girnelRoomBoard.start`): its
 *  `RoomBoardHost` (Girnel `src/embedded-room.ts`), kept to the same shape. */
export interface RoomBoardPortViewHost {
  self: string
  members(): Array<{ pubkey: string; name: string }>
  state(): Uint8Array
  push(update: Uint8Array): void
  subscribe(listener: (update: Uint8Array) => void): () => void
  /** Where the board stands, drawn by the view itself: a page has no bar of the room's around it. */
  status(): string | null
  changed(listener: () => void): () => void
  discuss?(card: RoomBoardPortCard): void
  invite?(): void
  assign?(card: RoomBoardPortCard): void
  files?: { add(file: File, signal: AbortSignal, said: (words: string) => void): Promise<RoomBoardPortFile>; open(file: RoomBoardPortFile, how: 'open' | 'download'): void }
  signal: AbortSignal
}

export interface RoomBoardOverPort {
  readonly sync: RoomBoardSync
  readonly start: RoomBoardPortStart
  /** The host to start Girnel's room view with. Each view has its own:
   *  its own edits do not come back to it, and `signal` ends it. */
  view(signal: AbortSignal): RoomBoardPortViewHost
  close(): Promise<void>
}

export interface RoomBoardOverPortOptions {
  timing?: RoomBoardSyncTiming
  /** Text typed into the view and not yet saved to the board: what the
   *  native side asks before it takes the page away. */
  pendingEdits?: () => boolean
}

type Message = Record<string, unknown>
interface Waiting { resolve(value: Message): void; reject(error: Error): void; chunk?(message: Message): void }

const object = (value: unknown): value is Message => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max

function file(value: unknown): RoomBoardPortFile | undefined {
  if (!object(value) || !text(value.hash, 64) || !HEX64.test(value.hash) || !text(value.key, 256) || !text(value.name, MAX_NAME) || !text(value.type, MAX_TYPE)
    || !count(value.size, Number.MAX_SAFE_INTEGER) || !count(value.encryptedSize, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(value.servers) || value.servers.length > 16 || !value.servers.every(server => text(server, 2048))) return undefined
  return { hash: value.hash, key: value.key, name: value.name, type: value.type, size: value.size as number, encryptedSize: value.encryptedSize as number, servers: [...value.servers as string[]] }
}

/**
 * Wait for the native side's `start` on `port`, open the board from this
 * device's copy, and start reading the room's stream. Resolves once the copy
 * is in the board; `sync.status().ready` follows when the stream has been read.
 */
export function openRoomBoardOverPort(port: RoomBoardPort, options: RoomBoardOverPortOptions = {}): Promise<RoomBoardOverPort> {
  const waiting = new Map<string, Waiting>()
  let next = 0
  let reading: { generation: number; stream: RoomBoardStream } | undefined
  let listening = false
  const membersChanged = new Set<() => void>()
  let generation = 0
  let members: Array<{ pubkey: string; name: string }> = []
  let started: RoomBoardPortStart | undefined
  let sync: RoomBoardSync | undefined
  let closed = false
  let opening: ((start: RoomBoardPortStart) => void) | undefined
  let board: RoomBoardOverPort | undefined

  const close = async () => {
    if (closed) return
    await sync?.close()
    closed = true
    for (const entry of waiting.values()) entry.reject(new Error('This board is closed'))
    waiting.clear()
    port.postMessage(JSON.stringify({ v: ROOM_BOARD_PORT_VERSION, t: 'closed' }))
  }

  const post = (message: Message) => {
    const raw = JSON.stringify({ v: ROOM_BOARD_PORT_VERSION, ...message })
    if (raw.length > ROOM_BOARD_PORT_MAX_MESSAGE) throw new Error('This board message is too long to send')
    port.postMessage(raw)
  }
  const ask = (t: string, body: Message = {}, chunk?: (message: Message) => void): Promise<Message> => {
    if (closed) return Promise.reject(new Error('This board is closed'))
    const re = `r${++next}`
    return new Promise<Message>((resolve, reject) => {
      waiting.set(re, { resolve, reject, ...(chunk ? { chunk } : {}) })
      try { post({ t, re, ...body }) } catch (e) { waiting.delete(re); reject(e instanceof Error ? e : new Error(String(e))) }
    })
  }
  const answer = (message: Message) => {
    const entry = typeof message.re === 'string' ? waiting.get(message.re) : undefined
    if (!entry) return
    waiting.delete(message.re as string)
    if (message.ok === true) entry.resolve(message)
    // The native side's words, for the person; nothing else is shown.
    else entry.reject(new Error(text(message.error, MAX_WORDS) && message.error ? message.error : 'The app could not do that'))
  }

  const listen = () => {
    listening = true
    sync!.listen(stream => {
      const mine = ++generation
      reading = { generation: mine, stream }
      post({ t: 'listen', gen: mine })
      return () => {
        if (reading?.generation === mine) reading = undefined
        if (!closed) post({ t: 'unlisten', gen: mine })
      }
    })
  }

  const build = (start: RoomBoardPortStart): RoomBoardSync => new RoomBoardSync<RoomBoardEnvelope>({
    envelope: async (part: BoardPart) => {
      const reply = await ask('seal', { part })
      if (!text(reply.event, 64) || !HEX64.test(reply.event) || !Number.isSafeInteger(reply.createdAt)) throw new Error('The app sealed this board change wrongly')
      return { id: reply.event, created_at: reply.createdAt as number }
    },
    publish: async envelope => { await ask('publish', { event: envelope.id }) },
    copy: {
      read: async () => {
        const records = new Map<string, { count: number; pieces: Map<number, string> }>()
        let broken = 0
        const reply = await ask('copy.read', {}, chunk => {
          const { record, index, count: total, data } = chunk
          if (!text(record, MAX_RECORD_ID) || !count(total, MAX_RECORD_CHUNKS) || total === 0 || !count(index, total - 1) || !text(data, ROOM_BOARD_PORT_MAX_MESSAGE)) { broken++; return }
          let entry = records.get(record)
          if (!entry) {
            if (records.size >= MAX_RECORDS_READ) { broken++; return }
            entry = { count: total, pieces: new Map() }
            records.set(record, entry)
          }
          if (entry.count !== total) { entry.count = -1; return }
          entry.pieces.set(index, data)
        })
        if (!count(reply.unread, Number.MAX_SAFE_INTEGER)) throw new Error('The app sent this board’s copy wrongly')
        const opened: RoomBoardCopyRecord[] = []
        let unread = (reply.unread as number) + broken
        for (const [id, entry] of records) {
          try {
            if (entry.count < 1 || entry.pieces.size !== entry.count) throw new Error('Incomplete record')
            const pieces = Array.from({ length: entry.count }, (_, i) => base64.decode(entry.pieces.get(i)!))
            const update = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.byteLength, 0))
            let offset = 0
            for (const piece of pieces) { update.set(piece, offset); offset += piece.byteLength }
            opened.push({ id, update })
          } catch { unread++ }
        }
        return { records: opened, unread }
      },
      add: async update => {
        const total = Math.max(1, Math.ceil(update.byteLength / ROOM_BOARD_PORT_CHUNK_BYTES))
        if (total > MAX_RECORD_CHUNKS) throw new Error('This board is too large to keep on this device')
        // One request, many pieces: the native side keeps the record once it holds the last.
        const re = `r${++next}`
        const reply = new Promise<Message>((resolve, reject) => waiting.set(re, { resolve, reject }))
        for (let index = 0; index < total; index++) {
          post({ t: 'copy.add', re, index, count: total, data: base64.encode(update.subarray(index * ROOM_BOARD_PORT_CHUNK_BYTES, (index + 1) * ROOM_BOARD_PORT_CHUNK_BYTES)) })
        }
        const done = await reply
        if (!text(done.record, MAX_RECORD_ID) || !done.record) throw new Error('The app kept this board’s copy wrongly')
        return done.record
      },
      remove: async ids => {
        const wanted = ids.filter(id => text(id, MAX_RECORD_ID))
        for (let i = 0; i < wanted.length; i += REMOVE_BATCH) await ask('copy.remove', { records: wanted.slice(i, i + REMOVE_BATCH) })
      },
    },
    ...(options.timing ? { timing: options.timing } : {}),
  })

  port.onmessage = event => {
    let message: unknown
    try {
      if (typeof event.data !== 'string' || event.data.length > ROOM_BOARD_PORT_MAX_MESSAGE) return
      message = JSON.parse(event.data)
    } catch { return }
    if (!object(message) || message.v !== ROOM_BOARD_PORT_VERSION || typeof message.t !== 'string') return
    switch (message.t) {
      case 'start':
        if (started || !opening || !text(message.self, 64) || !HEX64.test(message.self)) return
        started = { self: message.self, invite: message.invite === true, assign: message.assign === true, files: message.files === true }
        opening(started)
        return
      case 'members':
        if (Array.isArray(message.members)) {
          members = message.members.filter((m): m is { pubkey: string; name: string } => object(m) && text(m.pubkey, 64) && HEX64.test(m.pubkey) && text(m.name, 200))
            .map(m => ({ pubkey: m.pubkey, name: m.name }))
          for (const cb of [...membersChanged]) { try { cb() } catch { /* a view's problem */ } }
        }
        return
      case 'part': {
        const current = reading
        if (!current || message.gen !== current.generation || !text(message.event, 64) || !HEX64.test(message.event)) return
        if (!text(message.device, 64) || !HEX64.test(message.device) || !Number.isSafeInteger(message.sentAt) || !validBoardPart(message.part)) return
        if (current.stream.admit(message.event)) current.stream.receive(message.device, message.part, message.sentAt as number)
        return
      }
      case 'caughtUp':
        if (reading && message.gen === reading.generation) reading.stream.caughtUp()
        return
      case 'rekey':
        // Before the copy is read there is no reading yet: the first one starts in the current epoch.
        if (listening && !closed) listen()
        return
      case 'copy.record':
      case 'file.ack':
      case 'file.said': {
        const entry = typeof message.re === 'string' ? waiting.get(message.re) : undefined
        entry?.chunk?.(message)
        return
      }
      case 'reply':
        answer(message)
        return
      case 'flush':
        void sync?.flush().finally(() => { if (!closed && text(message.re, 32)) post({ t: 'flushed', re: message.re }) })
        return
      case 'pendingEdits?': {
        let value = true
        try { value = options.pendingEdits?.() ?? false } catch { /* asked of a view that has gone: say there may be some */ }
        if (text(message.re, 32)) post({ t: 'pendingEdits', re: message.re, value })
        return
      }
      case 'close':
        void close()
        return
      default:
        // Said by a side newer than this page: not understood, so not acted on.
        return
    }
  }

  return new Promise<RoomBoardOverPort>((resolve, reject) => {
    opening = start => {
      opening = undefined
      const own = build(start)
      sync = own
      own.onStatus(() => { if (!closed) post({ t: 'status', ...own.status() }) })
      void own.open().then(() => {
        if (own.closed) throw new Error('This board was closed before it opened')
        listen()
        board = {
          sync: own,
          start,
          view: signal => viewHost(own, start, signal),
          close,
        }
        resolve(board)
      }).catch(reject)
    }
    port.start?.()
    post({ t: 'ready' })
  })

  function viewHost(own: RoomBoardSync, start: RoomBoardPortStart, signal: AbortSignal): RoomBoardPortViewHost {
    const source = {}
    const live = () => !signal.aborted && !closed
    // What comes back from the view is another realm's: read as plain text and nothing more.
    const card = (value: { id: unknown; title: unknown; description: unknown }): RoomBoardPortCard =>
      ({ id: String(value.id).slice(0, 200), title: String(value.title).slice(0, 2_000), description: String(value.description).slice(0, 20_000) })
    const safePost = (message: Message) => { try { post(message) } catch { /* too long to send: nothing is done */ } }
    return {
      self: start.self,
      members: () => members.map(m => ({ ...m })),
      state: () => own.state(),
      push: update => {
        if (!live()) throw new Error('The room changed, so this edit was not saved.')
        own.apply(Uint8Array.from(update), source)
      },
      subscribe: listener => {
        const stop = own.onUpdate((update, from) => { if (from !== source && live()) listener(update) })
        signal.addEventListener('abort', stop, { once: true })
        return stop
      },
      status: () => roomBoardStatusWords(own.status()).words,
      changed: listener => {
        const told = () => { if (live()) listener() }
        const stopStatus = own.onStatus(told)
        membersChanged.add(told)
        const stop = () => { stopStatus(); membersChanged.delete(told) }
        signal.addEventListener('abort', stop, { once: true })
        return stop
      },
      discuss: value => { if (live()) safePost({ t: 'discuss', card: card(value) }) },
      ...(start.invite ? { invite: () => { if (live()) safePost({ t: 'invite' }) } } : {}),
      ...(start.assign ? { assign: (value: RoomBoardPortCard) => { if (live()) safePost({ t: 'assign', card: card(value) }) } } : {}),
      ...(start.files ? {
        files: {
          add: (picked, aborted, said) => addFile(picked, aborted, said),
          open: (value, how) => {
            const reference = file(value)
            if (live() && reference) safePost({ t: 'file.open', file: reference, how: how === 'download' ? 'download' : 'open' })
          },
        },
      } : {}),
      signal,
    }

    async function addFile(picked: File, aborted: AbortSignal, said: (words: string) => void): Promise<RoomBoardPortFile> {
      if (!live()) throw new Error('The room changed. Nothing was uploaded.')
      const re = `r${++next}`
      let acknowledged: ((value: void) => void) | undefined
      let sent = -1
      const reply = new Promise<Message>((resolve, reject) => waiting.set(re, {
        resolve, reject,
        chunk: message => {
          if (message.t === 'file.said') { if (text(message.words, MAX_WORDS) && !aborted.aborted) said(message.words) }
          else if (message.t === 'file.ack' && message.offset === sent) { const done = acknowledged; acknowledged = undefined; done?.() }
        },
      }))
      const cancel = () => { safePost({ t: 'file.cancel', re }); waiting.get(re)?.reject(new Error('Stopped. Nothing was uploaded.')); waiting.delete(re) }
      aborted.addEventListener('abort', cancel, { once: true })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        post({ t: 'file.add', re, name: String(picked.name).slice(0, MAX_NAME), type: String(picked.type).slice(0, MAX_TYPE), size: picked.size })
        // One acknowledged piece at a time, so neither side holds the whole file in messages.
        for (let offset = 0; offset < picked.size; offset += ROOM_BOARD_PORT_CHUNK_BYTES) {
          if (!waiting.has(re)) break
          const piece = new Uint8Array(await picked.slice(offset, offset + ROOM_BOARD_PORT_CHUNK_BYTES).arrayBuffer())
          const ack = new Promise<void>(resolve => { acknowledged = resolve })
          sent = offset
          post({ t: 'file.chunk', re, offset, data: base64.encode(piece) })
          await Promise.race([ack, reply.then(() => {}, () => {})])
        }
        const done = await reply
        const reference = file(done.file)
        if (!reference) throw new Error('The app sent this file’s details wrongly. It may not have been shared.')
        return reference
      } finally {
        aborted.removeEventListener('abort', cancel)
        signal.removeEventListener('abort', cancel)
      }
    }
  }
}
