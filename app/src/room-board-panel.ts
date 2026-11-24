import type { RoomBoardLog } from '../../src/room-board-log.js'
import { roomBoardRecordId, type RoomBoardStorage } from '../../src/room-board-wire.js'
import './boards-panel.css'
import './room-board-panel.css'

/** The room view's own entry in the bundled Girnel package: see `girnel-assets.ts`. */
interface RoomBoardHost {
  state(): Uint8Array
  push(update: Uint8Array): void
  subscribe(listener: (update: Uint8Array) => void): () => void
  self: string
  members(): Array<{ pubkey: string; name: string }>
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
 * The frame holds Girnel's board view and nothing else. The room keeps the
 * board (`RoomBoardLog`): this panel hands the view the board's state and
 * its later changes, and hands the room each edit the view accepts. No key,
 * signer or relay crosses into the frame.
 */
export class RoomBoardPanel {
  readonly dialog: HTMLDialogElement
  #view?: View
  #return?: HTMLElement
  readonly #title: HTMLElement
  readonly #status: HTMLElement
  readonly #shell: HTMLElement
  readonly #tasks: HTMLButtonElement
  #others!: HTMLButtonElement
  #watch?: ReturnType<typeof setInterval>

  constructor(readonly root: Document, readonly options: {
    /** The room now open, or undefined when there is none. */
    current(): object | undefined
    /** The room's tasks. */
    roomTasks(from: HTMLElement): void
    /** Boards kept outside the room and shared with it (the older Boards
     *  view), and how many this room has been handed. */
    otherBoards(from: HTMLElement): void
    otherBoardsCount(): number
  }) {
    this.dialog = root.createElement('dialog'); this.dialog.id = 'roomBoardPanel'; this.dialog.setAttribute('aria-labelledby', 'roomBoardTitle')
    this.#shell = this.el('div'); this.#shell.className = 'boardsShell'
    const bar = this.el('div'); bar.className = 'boardsBar'
    this.#title = this.el('h2', 'Board'); this.#title.id = 'roomBoardTitle'; this.#title.tabIndex = -1
    this.#tasks = this.button('Room tasks', () => { const opener = this.#return; this.dialog.close(); this.options.roomTasks(opener?.isConnected ? opener : this.#tasks) }); this.#tasks.id = 'roomBoardTasks'
    const others = this.button('Other boards', () => { const opener = this.#return; this.dialog.close(); this.options.otherBoards(opener?.isConnected ? opener : others) }); others.id = 'roomBoardOthers'
    this.#others = others
    const close = this.button('Close', () => this.dialog.close()); close.id = 'roomBoardClose'
    bar.append(this.#title, this.#tasks, others, close)
    this.#status = this.el('p'); this.#status.id = 'roomBoardStatus'; this.#status.className = 'roomBoardStatus'; this.#status.setAttribute('role', 'status')
    this.#shell.append(bar, this.#status); this.dialog.append(this.#shell); root.body.append(this.dialog)
    this.dialog.addEventListener('close', () => {
      if (this.#watch) { clearInterval(this.#watch); this.#watch = undefined }
      if (this.#return?.isConnected) this.#return.focus({ preventScroll: true })
    })
    window.addEventListener('pagehide', () => this.reset())
  }
  private el(tag: string, text = '') { const element = this.root.createElement(tag); element.textContent = text; return element }
  private button(text: string, run: () => void) { const button = this.root.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = run; return button }

  /** Open the board of `room`. Shown at once; the board follows as soon as
   *  this device's copy has been read. */
  open(from: HTMLElement, room: RoomBoardRoom): void {
    this.#return = from
    if (this.#view && (this.#view.room.key !== room.key || this.#view.abort.signal.aborted || this.#view.log?.closed)) this.closeView()
    this.#title.textContent = `Board · ${room.name}`
    this.labelOthers()
    if (!this.#view) this.mount(room)
    else { this.#view.room = room; this.render() }
    if (!this.dialog.open) this.dialog.showModal()
    // A room left or changed under an open board takes the board with it.
    this.#watch ??= setInterval(() => this.sync(), 1000)
    this.#title.focus()
  }

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
              // The view is this edit's source, so its own echo is not sent back to it.
              push: update => { if (current()) log.apply(Uint8Array.from(update), view) },
              subscribe: listener => {
                const stop = log.onUpdate((update, source) => { if (source !== view && current()) listener(update) })
                view.abort.signal.addEventListener('abort', stop, { once: true })
                return stop
              },
              signal: view.abort.signal,
            })
          } catch (error) { if (current()) this.#status.textContent = errorText(error) }
        }
        if (child.girnelRoomBoard) start(); else child.addEventListener('girnel-room-ready', start, { once: true })
      })
      view.frame = frame
      this.#shell.append(frame)
      this.render()
    }).catch(error => { if (current()) this.#status.textContent = errorText(error) })
  }

  /** Boards shared with this room before it had one of its own stay one step away. */
  private labelOthers(): void {
    const count = this.options.otherBoardsCount()
    this.#others.textContent = count > 0 ? `Other boards (${count})` : 'Other boards'
  }

  private render(): void {
    this.labelOthers()
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
    if (this.dialog.open) this.dialog.close()
  }

  reset(): void {
    this.closeView()
    if (this.dialog.open) this.dialog.close()
  }

  /** Text typed into the open board and not yet saved to it. What is saved
   *  but not yet sent is kept on this device, and is not counted. */
  get hasPendingEdits(): boolean {
    const view = this.#view
    if (!view?.frame || view.abort.signal.aborted) return false
    try { return !!(view.frame.contentWindow as RoomBoardWindow | null)?.girnelRoomBoard?.hasPendingEdits() } catch { return true }
  }
}
