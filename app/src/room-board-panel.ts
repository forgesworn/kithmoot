import type { RoomBoardLog } from '../../src/room-board-log.js'
import { roomBoardRecordId, type RoomBoardStorage } from '../../src/room-board-wire.js'
import './boards-panel.css'
import './room-board-panel.css'

/** A file on a card: where the sealed file is kept, the key that opens it, and what it says it is. The same thing as a file
 *  shared in the room's conversation, in the words a card uses. */
export interface RoomBoardFile { hash: string; key: string; name: string; type: string; size: number; encryptedSize: number; servers: string[] }

/**
 * The server a card would name for a file kept at `url`, or undefined where a
 * card cannot carry it. A card's reference is a server and the envelope's
 * hash, so the file must be on an https server that keeps it at its hash. A
 * Blossom server may add an extension to the address it hands back; the hash
 * alone always answers, so that is accepted. Anything else (a path of the
 * server's own, a query, credentials, another scheme) is not.
 */
export function roomBoardFileServer(url: string, sha256: string): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined
  let address: URL
  try { address = new URL(url) } catch { return undefined }
  const atHash = address.pathname === `/${sha256}` || /^\.[A-Za-z0-9]{1,16}$/.test(address.pathname.slice(sha256.length + 1)) && address.pathname.startsWith(`/${sha256}.`)
  if (address.protocol !== 'https:' || !atHash || address.search || address.hash || address.username || address.password) return undefined
  return `${address.origin}/`
}

/** The room view's own entry in the bundled Girnel package: see `girnel-assets.ts`. */
interface RoomBoardHost {
  state(): Uint8Array
  push(update: Uint8Array): void
  subscribe(listener: (update: Uint8Array) => void): () => void
  self: string
  members(): Array<{ pubkey: string; name: string }>
  discuss?(card: { id: string; title: string; description: string }): void
  invite?(): void
  assign?(card: { id: string; title: string; description: string }): void
  files?: { add(file: File, signal: AbortSignal, said: (words: string) => void): Promise<RoomBoardFile>; open(file: RoomBoardFile, how: 'open' | 'download'): void }
  signal?: AbortSignal
}
type RoomBoardWindow = Window & { girnelRoomBoard?: { start(host: RoomBoardHost): void; hasPendingEdits(): boolean } }

/** The room whose board is open. `key` is the session's identity: a room
 *  entered again is another session, and its board is opened afresh. */
export interface RoomBoardRoom {
  key: object
  roomId: string
  name: string
  /** This person, as 64 lower-case hex characters. */
  self: string
  members(): Array<{ pubkey: string; name: string }>
  /** The session's one board log, opened on first use. */
  board(): Promise<RoomBoardLog>
  /** Whether this room can be invited to. A private chat cannot. */
  canInvite: boolean
}

interface View {
  room: RoomBoardRoom
  abort: AbortController
  frame?: HTMLIFrameElement
  log?: RoomBoardLog
}

type BoardRecords = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
const RECORD_ID = /^[0-9a-f]{64}$/

/** This device's copy of one room's board: one browser-storage entry per
 *  record, `<root>.r.<sha-256 of the record>`. There is no head to keep in
 *  step, so two tabs in one room write side by side. */
export function browserRoomBoardStorage(root: string, storage: BoardRecords): RoomBoardStorage {
  const prefix = `${root}.r.`
  return {
    list: async () => {
      const records: Array<{ id: string; record: string }> = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key?.startsWith(prefix)) continue
        const record = storage.getItem(key)
        if (record !== null) records.push({ id: key.slice(prefix.length), record })
      }
      return records
    },
    add: async record => { const id = roomBoardRecordId(record); storage.setItem(prefix + id, record); return id },
    remove: async ids => { for (const id of ids) if (RECORD_ID.test(id)) storage.removeItem(prefix + id) },
  }
}

function errorText(error: unknown): string {
  // Errors from the embedded window have another realm's Error prototype.
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'The board could not open.'
}

/**
 * The room's own board. Every room has one, and everybody in the room has
 * it: there is nothing to create, name, share or join, and no account to
 * sign in to beyond being in the room.
 *
 * It is shown in the Boards destination, as the tab named after the room
 * (`WorkspaceWorkPanel` gives it the container). The frame holds Girnel's
 * whole board screen. The room keeps the board (`RoomBoardLog`): this panel
 * hands the screen the board's state and its later changes, and hands the
 * room each edit the screen accepts. No key, signer or relay crosses into
 * the frame.
 */
export class RoomBoardPanel {
  readonly element: HTMLElement
  #view?: View
  readonly #status: HTMLElement
  #watch?: ReturnType<typeof setInterval>

  constructor(readonly root: Document, readonly options: {
    /** The room now open, or undefined when there is none. */
    current(): object | undefined
    /** Back to the room's conversation. */
    back(): void
    /** Take a card into the room's conversation: its title, into the draft. */
    discuss(card: { id: string; title: string; description: string }): void
    /** The room's own invitation, for somebody who is to have the board. */
    invite(): void
    /** A card as the start of a room task for an agent: the room's own task form, filled in from it. */
    assign(card: { id: string; title: string; description: string }): void
    /** One file for a card, sealed and uploaded as the room shares any file. `said` takes each stage as it is reached,
     *  in a few words. Rejects with words for the person, which the card shows beside Try again. */
    addFile(file: File, signal: AbortSignal, said: (words: string) => void): Promise<RoomBoardFile>
    /** Show a card's file as the room shows any file: fetched only when the person asks, checked, and never trusted for what it says it is. */
    openFile(file: RoomBoardFile, from: HTMLElement): void
  }) {
    this.element = root.createElement('section'); this.element.id = 'roomBoardPanel'; this.element.className = 'roomBoardSurface'
    this.#status = root.createElement('p'); this.#status.id = 'roomBoardStatus'; this.#status.className = 'roomBoardStatus'; this.#status.setAttribute('role', 'status')
    // One line over the board: where it stands with the room, and the way
    // back to the conversation, which a phone has no rail to offer.
    const bar = root.createElement('div'); bar.className = 'roomBoardBar'
    const back = root.createElement('button'); back.type = 'button'; back.id = 'roomBoardBack'; back.className = 'quiet'; back.textContent = 'Back to chat'
    back.onclick = () => this.options.back()
    bar.append(this.#status, back)
    this.element.append(bar)
    window.addEventListener('pagehide', () => this.reset())
  }

  /** Show the board of `room` in `container`. Shown at once; the board
   *  follows as soon as this device's copy has been read. Asked again for a
   *  board already showing, it changes nothing. */
  show(container: HTMLElement, room: RoomBoardRoom): void {
    if (this.#view && (this.#view.room.key !== room.key || this.#view.abort.signal.aborted || this.#view.log?.closed)) this.closeView()
    if (this.element.parentElement !== container) container.append(this.element)
    this.element.setAttribute('aria-label', `Board · ${room.name}`)
    if (!this.#view) this.mount(room)
    else { this.#view.room = room; if (this.#view.frame) this.#view.frame.title = `Board · ${room.name}`; this.render() }
    // A room left or changed under an open board takes the board with it.
    this.#watch ??= setInterval(() => this.sync(), 1000)
  }

  /** Another tab was chosen, or Boards was left. The board stays as it is,
   *  out of sight, so what was half typed is still there on the way back. */
  hide(): void {
    if (this.#watch) { clearInterval(this.#watch); this.#watch = undefined }
  }

  /** Whether a board is showing for the room `key`. */
  showing(key: object): boolean { return this.#view?.room.key === key && !this.#view.abort.signal.aborted }

  private mount(room: RoomBoardRoom): void {
    const view: View = { room, abort: new AbortController() }
    this.#view = view
    const current = () => this.#view === view && !view.abort.signal.aborted && this.options.current() === room.key
    this.#status.textContent = 'Opening the board…'
    void room.board().then(log => {
      if (!current()) return
      view.log = log
      const stopStatus = log.onStatus(() => { if (current()) this.render() })
      view.abort.signal.addEventListener('abort', stopStatus, { once: true })
      const frame = this.root.createElement('iframe')
      frame.className = 'boardsFrame'; frame.title = `Board · ${room.name}`
      frame.allow = 'clipboard-write'; frame.referrerPolicy = 'no-referrer'
      frame.src = new URL('girnel/embedded/room.html', new URL(import.meta.env.BASE_URL, location.origin)).href
      frame.addEventListener('load', () => {
        if (!current()) return
        const child = frame.contentWindow as RoomBoardWindow
        const start = () => {
          if (!current() || !child.girnelRoomBoard) return
          try {
            child.girnelRoomBoard.start({
              self: room.self,
              members: () => view.room.members(),
              state: () => log.state(),
              // The view is this edit's source, so its own echo is not sent back to it. An edit the room cannot take
              // (the room has changed, or the board is closed) is refused by throwing: the view then undoes it, and
              // never holds a change the room lacks.
              push: update => {
                if (!current()) throw new Error('The room changed, so this edit was not saved.')
                log.apply(Uint8Array.from(update), view)
              },
              subscribe: listener => {
                const stop = log.onUpdate((update, source) => { if (source !== view && current()) listener(update) })
                view.abort.signal.addEventListener('abort', stop, { once: true })
                return stop
              },
              // What comes back from the frame is another realm's: read as plain text and nothing more.
              discuss: card => { if (current()) this.options.discuss({ id: String(card.id), title: String(card.title), description: String(card.description) }) },
              ...(room.canInvite ? { invite: () => { if (current()) this.options.invite() } } : {}),
              assign: card => { if (current()) this.options.assign({ id: String(card.id), title: String(card.title), description: String(card.description) }) },
              files: {
                add: (file, signal, said) => current()
                  ? this.options.addFile(file, signal, words => { if (current() && !signal.aborted) said(String(words)) })
                  : Promise.reject(new Error('The room changed. Nothing was uploaded.')),
                // A reference is something any member can write: every field is read as plain text or a number, and the
                // room's own reader decides what to make of it.
                open: file => { if (current()) this.options.openFile({ hash: String(file.hash), key: String(file.key), name: String(file.name), type: String(file.type),
                  size: Number(file.size), encryptedSize: Number(file.encryptedSize), servers: Array.from(file.servers, server => String(server)) }, frame) },
              },
              signal: view.abort.signal,
            })
          } catch (error) { if (current()) this.#status.textContent = errorText(error) }
        }
        if (child.girnelRoomBoard) start(); else child.addEventListener('girnel-room-ready', start, { once: true })
      })
      view.frame = frame
      this.element.append(frame)
      this.render()
    }).catch(error => { if (current()) this.#status.textContent = errorText(error) })
  }

  private render(): void {
    const log = this.#view?.log
    if (!log) return
    const status = log.status()
    this.#status.dataset.state = status.error ? 'held' : status.pending || !status.ready ? 'busy' : 'shared'
    this.#status.textContent = status.error
      ? `${status.error}. Your changes are kept on this device and sent when they can be.`
      : !status.ready ? 'Reading the room’s board…'
        : status.pending ? 'Sending your changes to the room…'
          : 'Shared with everyone in this room.'
  }

  private closeView(): void {
    const view = this.#view
    if (!view) return
    this.#view = undefined
    view.abort.abort(new Error('Board closed'))
    view.frame?.remove()
    this.#status.textContent = ''
    delete this.#status.dataset.state
  }

  /** Called when the room or the account may have changed. */
  sync(): void {
    const view = this.#view
    if (!view) return
    if (this.options.current() === view.room.key && !view.log?.closed) return
    this.closeView()
  }

  reset(): void {
    this.closeView()
    this.hide()
  }

  /** Text typed into the open board and not yet saved to it. What is saved
   *  but not yet sent is kept on this device, and is not counted. */
  get hasPendingEdits(): boolean {
    const view = this.#view
    if (!view?.frame || view.abort.signal.aborted) return false
    try { return !!(view.frame.contentWindow as RoomBoardWindow | null)?.girnelRoomBoard?.hasPendingEdits() } catch { return true }
  }
}
