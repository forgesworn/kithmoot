import type { SignetSession } from 'signet-login'
import type { DeviceStore } from './device-store.js'
import { boardContextTitle, listBoardContexts, readBoardContext, saveBoardContext, type BoardContext } from './board-context.js'
import { girnelAccess, type GirnelBoard, type GirnelWindow } from './girnel-host.js'
import './boards-panel.css'
import popupStyles from './boards-panel.css?inline'
import type { RoomBoard } from '../../src/room-boards.js'

interface Scope { id: string; name: string }
function errorText(error: unknown): string {
  // Errors from an embedded window have a different realm's Error prototype.
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : 'The board could not open.'
}
interface BoardView {
  frame: HTMLIFrameElement
  abort: AbortController
  account: SignetSession
  context?: BoardContext
  project?: Scope
  room?: Scope
  popup?: Window
  share?: () => void
}

/** The frame contains the actual Girnel app, served and precached locally.
 * Window context is personal navigation metadata, never a membership grant. */
export class BoardsPanel {
  readonly dialog: HTMLDialogElement
  #view?: BoardView
  #popups = new Set<BoardView>()
  #return?: HTMLElement
  #status: HTMLElement
  #context: HTMLElement
  #project: HTMLSelectElement
  #room: HTMLSelectElement
  #pop: HTMLButtonElement
  #link: HTMLButtonElement
  #scope: HTMLElement
  #saved: HTMLElement
  #share: HTMLButtonElement
  #navigationState = ''
  #timer: ReturnType<typeof setInterval>
  constructor(readonly root: Document, readonly options: {
    session(): SignetSession | undefined
    store: DeviceStore
    projects(): Scope[]
    rooms(project?: string): Scope[]
    currentRoom(): Scope | undefined
    currentProject(): Scope | undefined
    signIn(): void
    roomTasks(from: HTMLElement): void
    roomInvitation(id: string): string | undefined
    agentRoom(id: string): Promise<import('./board-agent-room.js').BoardAgentRoom>
    discuss(context: BoardContext, card: {id: string; title: string; description?: string}): Promise<void>
    showChat(): void
    roomBoards(id: string): RoomBoard[]
    shareBoard(room: Scope, board: RoomBoard): Promise<void>
  }) {
    this.dialog = root.createElement('dialog'); this.dialog.id = 'boardsPanel'; this.dialog.setAttribute('aria-labelledby', 'boardsTitle')
    const shell = this.el('div'); shell.className = 'boardsShell'
    const bar = this.el('div'); bar.className = 'boardsBar'
    const title = this.el('h2', 'Boards'); title.id = 'boardsTitle'; title.tabIndex = -1
    this.#pop = this.button('Pop out', () => {void this.popOut()}); this.#pop.id = 'boardsPopOut'
    const picker = this.button('Choose another board', () => {void (async () => {
      const view = this.#view
      if (view) {
        await (view.frame.contentWindow as GirnelWindow).girnelEmbed?.prepareMove()
        if (this.#view === view && !view.abort.signal.aborted) view.frame.contentWindow!.location.hash = '#/'
      } else this.open(this.#return ?? picker)
    })().catch(error => this.report(error))})
    const tasks = this.button('Room tasks', () => {this.dialog.close(); this.options.roomTasks(tasks)})
    const invite = this.button('Open board link', () => {linkForm.hidden = !linkForm.hidden; if (!linkForm.hidden) linkInput.focus()})
    const close = this.button('Close', () => this.dialog.close()); close.id = 'boardsClose'
    bar.append(title, picker, invite, tasks, this.#pop, close)
    const linkForm = root.createElement('form'); linkForm.className = 'boardsLink'; linkForm.hidden = true
    const linkLabel = this.el('label', 'Board invitation or card link'), linkInput = root.createElement('input')
    linkInput.type = 'password'; linkInput.autocomplete = 'off'; linkInput.maxLength = 32768
    linkLabel.append(linkInput)
    const openLink = this.button('Open this board link', () => {}); openLink.type = 'submit'; linkForm.append(linkLabel, openLink)
    linkForm.onsubmit = event => {event.preventDefault(); void this.openLink(linkInput.value).then(() => {linkInput.value = ''; linkForm.hidden = true}).catch(error => this.report(error))}
    this.#context = this.el('p', 'Boards · KithMoot'); this.#context.className = 'boardsContext'; this.#context.id = 'boardsContext'
    this.#saved = this.el('nav'); this.#saved.id = 'boardsSaved'; this.#saved.className = 'boardsSaved'; this.#saved.setAttribute('aria-label', 'Your boards')
    this.#scope = this.el('div'); this.#scope.className = 'boardsScopes'
    this.#project = root.createElement('select'); this.#project.id = 'boardsProject'
    this.#room = root.createElement('select'); this.#room.id = 'boardsRoom'
    for (const [text, select] of [['Project', this.#project], ['Chat', this.#room]] as const) {
      const label = this.el('label', text); label.append(select); this.#scope.append(label)
    }
    this.#link = this.button('Use these labels', () => this.associate()); this.#link.id = 'boardsAssociate'
    this.#share = this.button('Share with this chat', () => this.#view?.share?.()); this.#share.id = 'boardsShareRoom'; this.#share.disabled = true
    this.#scope.append(this.#link, this.#share)
    this.#project.onchange = () => {this.fillRooms(); this.#link.disabled = !this.#view?.context}
    this.#room.onchange = () => {this.#link.disabled = !this.#view?.context}
    this.#status = this.el('p'); this.#status.id = 'boardsStatus'; this.#status.setAttribute('role', 'status')
    shell.append(bar, linkForm, this.#context, this.#saved, this.#scope, this.#status); this.dialog.append(shell); root.body.append(this.dialog)
    this.dialog.addEventListener('close', () => {if (this.#return?.isConnected) this.#return.focus({preventScroll: true})})
    this.#timer = setInterval(() => this.sync(), 1000)
    window.addEventListener('pagehide', () => {this.reset(); clearInterval(this.#timer)})
  }
  private el(tag: string, text = '') {const element = this.root.createElement(tag); element.textContent = text; return element}
  private button(text: string, run: () => void) {const button = this.root.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = run; return button}
  private scope(select: HTMLSelectElement): Scope | undefined {return select.value ? {id: select.value, name: select.selectedOptions[0]!.textContent!} : undefined}
  private fillRooms(selected = this.#room.value) {
    this.#room.replaceChildren(new Option('No linked chat', ''), ...this.options.rooms(this.#project.value || undefined).map(room => new Option(room.name, room.id)))
    this.#room.value = [...this.#room.options].some(option => option.value === selected) ? selected : ''
  }
  private labels(view: BoardView) {
    if (!view.context && view.popup) {view.popup.document.title = 'Boards · KithMoot'; return}
    if (!view.context) {this.#context.textContent = view.room ? `Create a board to share with ${view.room.name}, or choose an existing board.` : 'Choose or create a personal board, or link a chat to share it.'; this.#pop.disabled = this.#link.disabled = this.#share.disabled = true; return}
    const title = boardContextTitle(view.context)
    if (view.popup) {
      view.popup.document.title = title
      const label = view.popup.document.querySelector<HTMLElement>('.boardsContext'); if (label) label.textContent = title
      view.frame.title = title
    } else {
      this.#context.textContent = title; this.#pop.disabled = this.#link.disabled = false; view.frame.title = title
      this.#share.disabled = !view.share || !view.context.room
      this.#share.textContent = view.context.room ? `Share with ${view.context.room.name}` : 'Share with this chat'
    }
  }
  private associate() {
    const view = this.#view
    if (!view?.context || this.options.session() !== view.account) return
    view.project = this.scope(this.#project); view.room = this.scope(this.#room)
    view.context = {boardId: view.context.boardId, boardName: view.context.boardName,
      ...(view.context.cardId ? {cardId: view.context.cardId} : {}),
      ...(view.project ? {project: view.project} : {}), ...(view.room ? {room: view.room} : {})}
    try {saveBoardContext(this.options.store, view.account.pubkey, view.context); this.labels(view); this.navigation(); this.#status.textContent = 'Labels saved on this browser. Board membership is unchanged.'}
    catch (error) {this.report(error)}
  }
  private report(error: unknown) {this.#status.textContent = errorText(error)}
  private navigation() {
    const account = this.options.session()?.pubkey, room = this.options.currentRoom()
    const contexts = account ? listBoardContexts(this.options.store, account) : []
    const shared = room && account ? this.options.roomBoards(room.id) : []
    for (const board of shared) {
      const index = contexts.findIndex(context => context.boardId === board.boardId && context.room?.id === room!.id)
      const context: BoardContext = {boardId: board.boardId, boardName: board.name, room}
      if (index >= 0) contexts[index] = {...contexts[index], ...context}; else contexts.push(context)
    }
    const state = JSON.stringify([account, room?.id, contexts, [...this.#popups].filter(view => !view.popup?.closed).map(view => view.context?.boardId)])
    if (state === this.#navigationState) return
    this.#navigationState = state
    const button = (context: BoardContext, full: boolean) => {
      const popped = [...this.#popups].some(view => view.account.pubkey === account && view.context?.boardId === context.boardId && !view.popup?.closed)
      const open = this.button(`${full ? [context.project?.name, context.room?.name, context.boardName].filter(Boolean).join(' · ') : context.boardName}${popped ? ' · Open in window' : ''}`, () => {void this.reopen(open, context).catch(error => this.report(error))})
      open.dataset.boardId = context.boardId; open.title = boardContextTitle(context)
      return open
    }
    this.#saved.replaceChildren(...contexts.map(context => button(context, true)))
    this.#saved.hidden = !contexts.length
    const linked = this.root.getElementById('roomBoards')
    if (linked) {
      const boards = contexts.filter(context => context.room?.id === room?.id && !!room)
      linked.replaceChildren(...boards.map(context => button(context, false))); linked.hidden = !boards.length
    }
  }
  private async reopen(from: HTMLElement, context: BoardContext) {
    const account = this.options.session()
    const popped = [...this.#popups].find(view => view.account === account && view.context?.boardId === context.boardId && !view.popup?.closed)
    if (popped?.popup) {popped.popup.focus(); this.dialog.close(); this.options.showChat(); return}
    await (this.#view?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
    if (this.options.session() !== account) return
    const shared = context.room && this.options.roomBoards(context.room.id).find(board => board.boardId === context.boardId)
    this.open(from, context, shared?.invitation)
  }
  private async openLink(value: string) {
    const account = this.options.session()
    if (!account) throw new Error('Sign in with Nostr before opening a shared board.')
    let hash: string
    try {
      const url = new URL(value.trim())
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash.length > 32768 ||
          !/^#(?:[A-Za-z0-9_-]+|\/b\/[a-zA-Z0-9_-]+(?:\/c\/[a-zA-Z0-9_-]+)?)$/.test(url.hash)) throw new Error()
      hash = url.hash
    } catch {throw new Error('Paste the whole board invitation or card link, including the part after #.')}
    await (this.#view?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
    if (this.options.session() !== account) throw new Error('Your account changed before the board could open.')
    this.closeView(this.#view)
    this.#view = this.mount(this.dialog.querySelector('.boardsShell')!, account, undefined, this.scope(this.#project), this.scope(this.#room), undefined, hash)
    this.#status.textContent = 'Opening the board link. Review the board invitation before joining.'
  }
  open(from: HTMLElement, context?: BoardContext, invitation?: string) {
    this.#return = from
    const session = this.options.session()
    if (!session) {this.#status.textContent = 'Sign in with your Nostr account to use shared boards.'; this.#pop.disabled = this.#link.disabled = true}
    else {
      const current = context ?? this.#view?.context
      const project = current?.project ?? this.options.currentProject(), room = current?.room ?? this.options.currentRoom()
      this.#project.replaceChildren(new Option('No project', ''), ...this.options.projects().map(project => new Option(project.name, project.id)))
      this.#project.value = project?.id ?? ''; this.fillRooms(room?.id)
      if (!this.#view || this.#view.account !== session || invitation) {
        this.closeView(this.#view)
        this.#view = this.mount(this.dialog.querySelector('.boardsShell')!, session, context, project, room, undefined, invitation ? new URL(invitation).hash : undefined)
      } else if (context) {
        this.#view.project = context.project; this.#view.room = context.room
        this.#view.frame.contentWindow!.location.hash = `#/b/${context.boardId}`
      }
      this.#status.textContent = ''
    }
    if (!this.dialog.open) this.dialog.showModal()
    this.navigation()
    this.root.getElementById('boardsTitle')!.focus()
    if (!session) {
      let button = this.root.getElementById('boardsSignIn') as HTMLButtonElement | null
      if (!button) {button = this.button('Sign in with Nostr', () => {this.dialog.close(); this.options.signIn()}); button.id = 'boardsSignIn'; this.#status.after(button)}
      button.hidden = false
    } else {const button = this.root.getElementById('boardsSignIn'); if (button) button.hidden = true}
  }
  private mount(container: Element, account: SignetSession, context?: BoardContext, project?: Scope, room?: Scope, popup?: Window, route?: string): BoardView {
    const doc = container.ownerDocument, frame = doc.createElement('iframe'), abort = new AbortController()
    frame.className = 'boardsFrame'; frame.title = context ? boardContextTitle(context) : 'Shared boards'
    frame.allow = 'clipboard-write'
    frame.referrerPolicy = 'no-referrer'
    const url = new URL('girnel/embedded/index.html', new URL(import.meta.env.BASE_URL, location.origin))
    if (context) url.hash = `#/b/${context.boardId}${'cardId' in context && typeof context.cardId === 'string' ? `/c/${context.cardId}` : ''}`
    if (route) url.hash = route
    frame.src = url.href
    const view: BoardView = {frame, abort, account, context, project, room, popup}
    const current = () => !abort.signal.aborted && this.options.session() === account && (!popup || !popup.closed)
    frame.addEventListener('load', () => {
      if (!current()) return
      const child = frame.contentWindow as GirnelWindow
      const start = () => {
        if (!current() || !child.girnelEmbed) return
        void child.girnelEmbed.start({signal: abort.signal,
          access: girnelAccess(account, current, () => {
            this.closeView(view)
            if (this.#view === view) {this.#view = undefined; this.dialog.close()}
            popup?.close()
          }),
          onBoard: (board: GirnelBoard | null) => {
            if (!current()) return
            if (!board) {view.context = undefined; this.labels(view); return}
            const saved = readBoardContext(this.options.store, account.pubkey, board.boardId)
            view.context = {boardId: board.boardId, boardName: board.name, ...(board.cardId ? {cardId: board.cardId} : {}),
              ...(saved?.project ? {project: saved.project} : {}), ...(saved?.room ? {room: saved.room} : {})}
            // A new board takes the explicitly selected creation context. An
            // existing board retains its own labels when the main chat changes.
            if (!saved && view.project) view.context.project = view.project
            if (!saved && view.room) view.context.room = view.room
            try {saveBoardContext(this.options.store, account.pubkey, view.context)} catch (error) {this.report(error)}
            this.labels(view)
            this.navigation()
          },
          onBoards: boards => {
            if (!current()) return
            try {
              for (const board of boards) {
                const saved = readBoardContext(this.options.store, account.pubkey, board.boardId)
                saveBoardContext(this.options.store, account.pubkey, {...saved, boardId: board.boardId, boardName: board.name})
              }
              this.navigation()
            } catch (error) {this.report(error)}
          },
          roomInvitation: () => view.context?.room ? this.options.roomInvitation(view.context.room.id) : undefined,
          agentRoom: async () => {
            const room = view.context?.room ?? view.room
            if (!room || !current()) throw new Error('Choose this board’s chat before assigning a card')
            const connection = await this.options.agentRoom(room.id)
            if (!current()) {await connection.close(); throw new Error('Your board account changed')}
            return connection
          },
          roomShare: () => {
            const room = view.context?.room ?? view.room
            if (!room || !current()) return
            return {name: room.name, publish: async (board, invitation) => {
              if (!current()) throw new Error('Your account changed before sharing the board.')
              await this.options.shareBoard(room, {...board, invitation})
              if (!current()) throw new Error('Reopen Boards to check the shared board.')
              this.navigation()
            }}
          },
          onRoomShareReady: share => {if (current()) {view.share = share ?? undefined; this.labels(view)}},
          discuss: (_board, card) => {if (current() && view.context) {this.dialog.close(); void this.options.discuss(view.context, card).catch(error => {this.report(error); if (!this.dialog.open) this.dialog.showModal()})}},
        }).catch(error => {if (current()) this.report(error)})
      }
      if (child.girnelEmbed) start(); else child.addEventListener('girnel-ready', start, {once: true})
    })
    container.append(frame)
    if (context) this.labels(view)
    return view
  }
  async popOut() {
    const view = this.#view, context = view?.context
    if (!view || !context || this.options.session() !== view.account) return
    const existing = [...this.#popups].find(other => other.account === view.account && other.context?.boardId === context.boardId && !other.abort.signal.aborted && !other.popup?.closed)
    if (existing?.popup) {existing.popup.focus(); return}
    // Open synchronously under the click gesture before any save/lock awaits.
    const popup = window.open('', '_blank', 'popup,width=1180,height=800')
    if (!popup) {this.#status.textContent = 'Your browser blocked the board window. Allow pop-ups for KithMoot, then try again.'; return}
    try {
      await (view.frame.contentWindow as GirnelWindow).girnelEmbed?.prepareMove()
      if (this.options.session() !== view.account || view.abort.signal.aborted) throw new Error('Your account changed before the board could move.')
      this.closeView(view); this.#view = undefined
      this.mountPopup(popup, view.account, context)
      this.#context.textContent = `${boardContextTitle(context)} · Open in its own window`
      this.#status.textContent = 'This board is open in its own window. You can open another board here.'
      this.#pop.disabled = this.#link.disabled = true
      this.dialog.close()
      this.options.showChat()
      this.navigation()
    } catch (error) {popup.close(); this.report(error)}
  }
  private mountPopup(popup: Window, account: SignetSession, context: BoardContext): BoardView {
    const doc = popup.document
    doc.title = boardContextTitle(context); doc.documentElement.lang = 'en-GB'
    doc.body.replaceChildren(); doc.body.className = 'boardsPopup'
    const meta = doc.createElement('meta'); meta.name = 'referrer'; meta.content = 'no-referrer'; doc.head.append(meta)
    // A blank window does not reliably load the parent's stylesheet links.
    // Give it the small board stylesheet directly, with the host's colours.
    const style = doc.createElement('style'); style.textContent = popupStyles; doc.head.append(style)
    const colours = getComputedStyle(this.root.body)
    for (const name of ['--bg', '--text', '--border']) doc.body.style.setProperty(name, colours.getPropertyValue(name))
    const bar = doc.createElement('header'); bar.className = 'boardsBar'
    const heading = doc.createElement('h1'); heading.className = 'boardsContext'; heading.textContent = boardContextTitle(context); heading.style.fontSize = '1rem'
    const back = doc.createElement('button'); back.type = 'button'; back.textContent = 'Return to workspace'
    bar.append(heading, back); doc.body.append(bar)
    const report = doc.createElement('p'); report.setAttribute('role', 'status'); report.style.margin = '0 1rem'; doc.body.append(report)
    const detached = this.mount(doc.body, account, context, context.project, context.room, popup); this.#popups.add(detached)
    back.onclick = () => {void (async () => {
      try {
        await (detached.frame.contentWindow as GirnelWindow).girnelEmbed?.prepareMove()
        await (this.#view?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
        if (this.options.session() !== account || detached.abort.signal.aborted || popup.closed) throw new Error('Your account changed before the board could return.')
        const returning = detached.context ?? context
        this.closeView(this.#view); this.#view = undefined
        this.closeView(detached); popup.close(); window.focus()
        this.open(this.#return ?? this.root.getElementById('homeWork')!, returning)
      } catch (error) {report.textContent = errorText(error)}
    })()}
    popup.addEventListener('pagehide', () => detached.abort.abort(new Error('Board window reloading')), {once: true})
    return detached
  }
  private closeView(view?: BoardView) {if (!view) return; view.abort.abort(new Error('Board connection closed')); view.frame.remove(); this.#popups.delete(view)}
  sync() {
    const session = this.options.session()
    if (this.#view && this.#view.account !== session) {this.closeView(this.#view); this.#view = undefined; this.dialog.close()}
    for (const view of [...this.#popups]) {
      if (view.account !== session || view.popup?.closed) {this.closeView(view); view.popup?.close()}
      else if (view.abort.signal.aborted && view.popup && view.context) {
        // Reloading a blank pop-out retains its account and board in the host.
        // Reopen only through that still-current host, with the normal writer fence.
        const popup = view.popup, context = view.context
        try {
          if (popup.document.readyState === 'loading') continue
          this.closeView(view); this.mountPopup(popup, view.account, context)
        } catch {
          // A manually navigated window no longer hosts our board. Release
          // its borrowed access without touching the new page.
          this.closeView(view)
        }
      }
    }
    this.navigation()
  }
  reset() {this.closeView(this.#view); this.#view = undefined; for (const view of this.#popups) {this.closeView(view); view.popup?.close()}; this.dialog.close()}
  get hasPendingEdits(): boolean {
    return [this.#view, ...this.#popups].some(view => {
      if (!view || view.abort.signal.aborted || view.popup?.closed) return false
      try {return !!(view.frame.contentWindow as GirnelWindow)?.girnelEmbed?.hasPendingEdits?.()} catch {return true}
    })
  }
}
