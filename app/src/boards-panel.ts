import type { SignetSession } from 'signet-login'
import type { DeviceStore } from './device-store.js'
import { boardContextTitle, readBoardContext, saveBoardContext, type BoardContext } from './board-context.js'
import { girnelAccess, type GirnelBoard, type GirnelWindow } from './girnel-host.js'
import './boards-panel.css'

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
    newRoomTask(): Promise<void>
    roomInvitation(id: string): string | undefined
    discuss(context: BoardContext, card: {id: string; title: string; description?: string}): Promise<void>
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
    const createTask = this.button('New room task', () => {this.dialog.close(); void this.options.newRoomTask().catch(error => {this.report(error); if (!this.dialog.open) this.dialog.showModal()})})
    bar.append(title, picker, invite, tasks, createTask, this.#pop, close)
    const linkForm = root.createElement('form'); linkForm.className = 'boardsLink'; linkForm.hidden = true
    const linkLabel = this.el('label', 'Board invitation or card link'), linkInput = root.createElement('input')
    linkInput.type = 'password'; linkInput.autocomplete = 'off'; linkInput.maxLength = 32768
    linkLabel.append(linkInput)
    const openLink = this.button('Open this board link', () => {}); openLink.type = 'submit'; linkForm.append(linkLabel, openLink)
    linkForm.onsubmit = event => {event.preventDefault(); void this.openLink(linkInput.value).then(() => {linkInput.value = ''; linkForm.hidden = true}).catch(error => this.report(error))}
    this.#context = this.el('p', 'Boards · KithMoot'); this.#context.className = 'boardsContext'; this.#context.id = 'boardsContext'
    this.#scope = this.el('div'); this.#scope.className = 'boardsScopes'
    this.#project = root.createElement('select'); this.#project.id = 'boardsProject'
    this.#room = root.createElement('select'); this.#room.id = 'boardsRoom'
    for (const [text, select] of [['Project', this.#project], ['Chat', this.#room]] as const) {
      const label = this.el('label', text); label.append(select); this.#scope.append(label)
    }
    this.#link = this.button('Use these labels', () => this.associate()); this.#link.id = 'boardsAssociate'
    this.#scope.append(this.#link)
    this.#project.onchange = () => {this.fillRooms(); this.#link.disabled = !this.#view?.context}
    this.#room.onchange = () => {this.#link.disabled = !this.#view?.context}
    this.#status = this.el('p'); this.#status.id = 'boardsStatus'; this.#status.setAttribute('role', 'status')
    shell.append(bar, linkForm, this.#context, this.#scope, this.#status); this.dialog.append(shell); root.body.append(this.dialog)
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
    if (!view.context) {this.#context.textContent = 'Choose or create a board. Labels organise this browser; access comes from the board invitation.'; this.#pop.disabled = this.#link.disabled = true; return}
    const title = boardContextTitle(view.context)
    if (view.popup) {
      view.popup.document.title = title
      const label = view.popup.document.querySelector<HTMLElement>('.boardsContext'); if (label) label.textContent = title
      view.frame.title = title
    } else {
      this.#context.textContent = title; this.#pop.disabled = this.#link.disabled = false; view.frame.title = title
    }
  }
  private associate() {
    const view = this.#view
    if (!view?.context || this.options.session() !== view.account) return
    view.project = this.scope(this.#project); view.room = this.scope(this.#room)
    view.context = {boardId: view.context.boardId, boardName: view.context.boardName,
      ...(view.context.cardId ? {cardId: view.context.cardId} : {}),
      ...(view.project ? {project: view.project} : {}), ...(view.room ? {room: view.room} : {})}
    try {saveBoardContext(this.options.store, view.account.pubkey, view.context); this.labels(view); this.#status.textContent = 'Labels saved on this browser. Board membership is unchanged.'}
    catch (error) {this.report(error)}
  }
  private report(error: unknown) {this.#status.textContent = errorText(error)}
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
  open(from: HTMLElement, context?: BoardContext) {
    this.#return = from
    const session = this.options.session()
    if (!session) {this.#status.textContent = 'Sign in with your Nostr account to use shared boards.'; this.#pop.disabled = this.#link.disabled = true}
    else {
      const project = context?.project ?? this.options.currentProject(), room = context?.room ?? this.options.currentRoom()
      this.#project.replaceChildren(new Option('No project', ''), ...this.options.projects().map(project => new Option(project.name, project.id)))
      this.#project.value = project?.id ?? ''; this.fillRooms(room?.id)
      if (!this.#view || this.#view.account !== session) {
        this.closeView(this.#view)
        this.#view = this.mount(this.dialog.querySelector('.boardsShell')!, session, context, project, room)
      } else if (context) {
        this.#view.frame.contentWindow!.location.hash = `#/b/${context.boardId}`
      }
      this.#status.textContent = ''
    }
    if (!this.dialog.open) this.dialog.showModal()
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
          },
          onBoards: () => {},
          roomInvitation: () => view.context?.room ? this.options.roomInvitation(view.context.room.id) : undefined,
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
    // Open synchronously under the click gesture before any save/lock awaits.
    const popup = window.open('', `kithmoot-board-${view.account.pubkey}-${context.boardId}`, 'popup,width=1180,height=800')
    if (!popup) {this.#status.textContent = 'Your browser blocked the board window. Allow pop-ups for KithMoot, then try again.'; return}
    const existing = [...this.#popups].find(other => other.popup === popup && !other.abort.signal.aborted)
    if (existing) {popup.focus(); return}
    try {
      await (view.frame.contentWindow as GirnelWindow).girnelEmbed?.prepareMove()
      if (this.options.session() !== view.account || view.abort.signal.aborted) throw new Error('Your account changed before the board could move.')
      this.closeView(view); this.#view = undefined
      this.mountPopup(popup, view.account, context)
      this.#context.textContent = `${boardContextTitle(context)} · Open in its own window`
      this.#status.textContent = 'This board is open in its own window. You can open another board here.'
      this.#pop.disabled = this.#link.disabled = true
    } catch (error) {popup.close(); this.report(error)}
  }
  private mountPopup(popup: Window, account: SignetSession, context: BoardContext): BoardView {
    const doc = popup.document; doc.title = boardContextTitle(context)
    doc.documentElement.lang = 'en-GB'; doc.body.replaceChildren(); doc.body.className = 'boardsPopup'
    // The home-page width rule also matches this document without a room.
    // A board window owns the full width, including at desktop sizes.
    doc.body.style.maxWidth = 'none'
    const meta = doc.createElement('meta'); meta.name = 'referrer'; meta.content = 'no-referrer'; doc.head.append(meta)
    // Clone only the host's stylesheet links; no code or inline event handlers.
    for (const sheet of this.root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) doc.head.append(sheet.cloneNode(true))
    for (const style of this.root.querySelectorAll('style')) doc.head.append(style.cloneNode(true))
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
  }
  reset() {this.closeView(this.#view); this.#view = undefined; for (const view of this.#popups) {this.closeView(view); view.popup?.close()}; this.dialog.close()}
  get hasPendingEdits(): boolean {
    return [this.#view, ...this.#popups].some(view => {
      if (!view || view.abort.signal.aborted || view.popup?.closed) return false
      try {return !!(view.frame.contentWindow as GirnelWindow)?.girnelEmbed?.hasPendingEdits?.()} catch {return true}
    })
  }
}
