import type { SignetSession } from 'signet-login'
import type { BoardContextCustody } from './board-context-custody.js'
import { BoardContextView } from './board-context-view.js'
import { boardContextTitle, type BoardContext } from './board-context.js'
import { girnelAccess, type GirnelBoard, type GirnelWindow, type GirnelBorrowedAccess } from './girnel-host.js'
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
  custody: BoardContextView
  selection: number
  boardGeneration: number
  boardId?: string
  access?: GirnelBorrowedAccess
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
  #closing = new Set<Promise<void>>()
  #navigationView?: {account: SignetSession; custody: BoardContextView; abort: AbortController}
  #navigationBusy = false
  constructor(readonly root: Document, readonly options: {
    session(): SignetSession | undefined
    contexts(account: SignetSession, current: () => boolean, stop: () => void): Promise<BoardContextCustody>
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
        await view.custody.run(async () => {})
        if (this.#view === view && !view.abort.signal.aborted && this.options.session() === view.account) view.frame.contentWindow!.location.hash = '#/'
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
    this.#link = this.button('Use these labels', () => {void this.associate()}); this.#link.id = 'boardsAssociate'
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
  private async associate() {
    const view = this.#view
    if (!view?.context || this.options.session() !== view.account) return
    const selection = view.selection, project = this.scope(this.#project), room = this.scope(this.#room)
    const context = {boardId: view.context.boardId, boardName: view.context.boardName,
      ...(view.context.cardId ? {cardId: view.context.cardId} : {}),
      ...(project ? {project} : {}), ...(room ? {room} : {})}
    try {
      await view.custody.run(async custody => {
        if (view.selection !== selection) throw new Error('The board changed before its labels could save.')
        await custody.save(context,() => this.options.session() === view.account && !view.abort.signal.aborted && view.selection === selection)
      })
      if (view.selection !== selection || this.#view !== view) return
      view.project = project; view.room = room; view.context = context
      this.labels(view); this.navigation(); this.#status.textContent = 'Labels saved on this browser. Board membership is unchanged.'
    } catch (error) {if (this.#view === view && !view.abort.signal.aborted) this.report(error)}
  }
  private report(error: unknown) {this.#status.textContent = errorText(error)}
  private navigation() {
    if (this.#navigationBusy) return
    this.#navigationBusy = true
    void (async () => {
      const account = this.options.session(), room = this.options.currentRoom()
      if (this.#navigationView && this.#navigationView.account !== account) this.closeNavigation()
      if (!account) {
        this.#navigationState = ''; this.#saved.replaceChildren(); this.#saved.hidden = true
        const linked = this.root.getElementById('roomBoards'); if (linked) {linked.replaceChildren(); linked.hidden = true}
        return
      }
      if (!this.#navigationView) {
        const abort = new AbortController(), person = account.pubkey, signer = account.signer, method = account.method, expiry = account.expiresAt
        const current = () => !abort.signal.aborted && this.options.session() === account && account.pubkey === person && account.signer === signer &&
          account.method === method && account.expiresAt === expiry && (expiry === undefined || Number.isFinite(expiry) && Date.now() < expiry)
        const custody = new BoardContextView(current, () => this.options.contexts(account,current,() => abort.abort()))
        this.#navigationView = {account,custody,abort}
      }
      const navigation = this.#navigationView
      const contexts = await navigation.custody.run(storage => storage.list())
      if (this.#navigationView !== navigation || this.options.session() !== account || this.options.currentRoom()?.id !== room?.id) return
      const shared = room ? this.options.roomBoards(room.id) : []
      for (const board of shared) {
        const index = contexts.findIndex(context => context.boardId === board.boardId && context.room?.id === room!.id)
        const context: BoardContext = {boardId: board.boardId, boardName: board.name, room}
        if (index >= 0) contexts[index] = {...contexts[index], ...context}; else contexts.push(context)
      }
      const state = JSON.stringify([account.pubkey, room?.id, contexts, [...this.#popups].filter(view => !view.popup?.closed).map(view => view.context?.boardId)])
      if (state === this.#navigationState) return
      this.#navigationState = state
      const button = (context: BoardContext, full: boolean) => {
        const popped = [...this.#popups].some(view => view.account === account && view.context?.boardId === context.boardId && !view.popup?.closed)
        const open = this.button(`${full ? [context.project?.name, context.room?.name, context.boardName].filter(Boolean).join(' · ') : context.boardName}${popped ? ' · Open in window' : ''}`, () => {void this.reopen(open, context).catch(error => this.report(error))})
        open.dataset.boardId = context.boardId; open.title = boardContextTitle(context)
        return open
      }
      this.#saved.replaceChildren(...contexts.map(context => button(context, true))); this.#saved.hidden = !contexts.length
      const linked = this.root.getElementById('roomBoards')
      if (linked) {
        const boards = contexts.filter(context => context.room?.id === room?.id && !!room)
        linked.replaceChildren(...boards.map(context => button(context, false))); linked.hidden = !boards.length
      }
    })().catch(error => {if (this.#navigationView && !this.#navigationView.abort.signal.aborted) this.report(error)})
      .finally(() => {this.#navigationBusy = false})
  }
  private closeNavigation() {
    const navigation = this.#navigationView
    if (!navigation) return
    this.#navigationView = undefined; navigation.abort.abort(); navigation.custody.revoke()
    this.#saved.replaceChildren(); this.#saved.hidden = true
    const linked = this.root.getElementById('roomBoards'); if(linked) {linked.replaceChildren(); linked.hidden = true}
    const closing = navigation.custody.close(); this.#closing.add(closing)
    void closing.finally(() => this.#closing.delete(closing)).catch(() => {})
  }
  private async reopen(from: HTMLElement, context: BoardContext) {
    const account = this.options.session()
    const popped = [...this.#popups].find(view => view.account === account && view.context?.boardId === context.boardId && !view.popup?.closed)
    if (popped?.popup) {popped.popup.focus(); this.dialog.close(); this.options.showChat(); return}
    const previous = this.#view
    await (previous?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
    await previous?.custody.run(async () => {})
    if (this.options.session() !== account || this.#view !== previous) return
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
    const previous = this.#view
    await (previous?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
    await previous?.custody.run(async () => {})
    if (this.options.session() !== account || this.#view !== previous) throw new Error('Your account or board changed before the board could open.')
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
    const person = account.pubkey, signer = account.signer, method = account.method, expiry = account.expiresAt
    const current = () => !abort.signal.aborted && this.options.session() === account && (!popup || !popup.closed) &&
      account.pubkey === person && account.signer === signer && account.method === method && account.expiresAt === expiry &&
      (expiry === undefined || Number.isFinite(expiry) && expiry > Date.now())
    const custody = new BoardContextView(current, () => this.options.contexts(account,current,() => abort.abort(new Error('Board context custody held.'))))
    const view: BoardView = {frame, abort, account, context, project, room, popup, custody, selection: 0, boardGeneration: 0}
    abort.signal.addEventListener('abort', () => custody.revoke(), {once: true})
    frame.addEventListener('load', () => {
      if (!current()) return
      const child = frame.contentWindow as GirnelWindow
      const start = async () => {
        if (!current() || !child.girnelEmbed) return
        try { await custody.ready; if (!current()) return
        view.access?.revoke(); await view.access?.close(); if (!current()) return
        const access = girnelAccess(account, current, () => {
            this.closeView(view)
            if (this.#view === view) {this.#view = undefined; this.dialog.close()}
            popup?.close()
          })
        view.access = access
        abort.signal.addEventListener('abort', () => access.revoke(), {once: true})
        await child.girnelEmbed.start({signal: abort.signal, access,
          onBoard: (board: GirnelBoard | null) => {
            if (!current()) return
            const selection = ++view.selection
            const boardId = board?.boardId
            if (view.boardId !== boardId) {view.boardId = boardId; view.boardGeneration++}
            if (!board) {view.context = undefined; this.labels(view); return}
            const chosen = {...board}, project = view.project && {...view.project}, room = view.room && {...view.room}
            view.context = undefined; this.labels(view)
            void custody.run(async storage => {
            if (view.selection !== selection) return
            const saved = await storage.read(chosen.boardId)
            if (!current() || view.selection !== selection) return
            const context: BoardContext = {boardId: chosen.boardId, boardName: chosen.name, ...(chosen.cardId ? {cardId: chosen.cardId} : {}),
              ...(saved?.project ? {project: saved.project} : {}), ...(saved?.room ? {room: saved.room} : {})}
            // A new board takes the explicitly selected creation context. An
            // existing board retains its own labels when the main chat changes.
            if (!saved && project) context.project = project
            if (!saved && room) context.room = room
            await storage.save(context,() => current() && view.selection === selection)
            if (!current() || view.selection !== selection) return
            view.context = context
            this.labels(view); this.navigation()
            }).catch(error => {if (current() && view.selection === selection) this.report(error)})
          },
          onBoards: boards => {
            if (!current()) return
            const captured = boards.map(board => ({...board}))
            void custody.run(async storage => {
              for (const board of captured) {
                if (!current()) return
                const saved = await storage.read(board.boardId)
                await storage.save({...saved,boardId:board.boardId,boardName:board.name},current)
              }
              if (current()) this.navigation()
            }).catch(error => {if (current()) this.report(error)})
          },
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
            const linked = {...room}
            return {name:linked.name,publish:async (board,invitation) => {
              const chosen = {...board,invitation}, generation = view.boardGeneration
              const selected = () => current() && view.boardGeneration === generation && view.boardId === chosen.boardId &&
                (view.context?.room ?? view.room)?.id === linked.id
              try {
                await custody.run(storage => storage.list())
                if (!selected()) throw new Error('Your account or board changed before sharing the board.')
                await this.options.shareBoard(linked,chosen)
                await custody.run(storage => storage.list())
                if (!selected()) throw new Error('Reopen Boards to check the shared board.')
                this.navigation()
              } catch(error) {if(current()) this.report(error); throw error}
            }}
          },
          onRoomShareReady: share => {if (current()) {view.share = share ? () => {if(current()) share()} : undefined; this.labels(view)}},
          roomInvitation: () => current() && view.context?.room ? this.options.roomInvitation(view.context.room.id) : undefined,
          discuss: (_board, card) => {if (current() && view.context) {this.dialog.close(); void this.options.discuss(view.context, card).catch(error => {if (current()) {this.report(error); if (!this.dialog.open) this.dialog.showModal()}})}},
        }) } catch (error) {if (current()) this.report(error)}
      }
      if (child.girnelEmbed) void start(); else child.addEventListener('girnel-ready', () => {void start()}, {once: true})
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
      await view.custody.run(async () => {})
      if (this.options.session() !== view.account || view.abort.signal.aborted) throw new Error('Your account changed before the board could move.')
      if (view.context?.boardId !== context.boardId) throw new Error('The board changed before it could move.')
      const moving = view.context
      this.closeView(view); this.#view = undefined
      this.mountPopup(popup, view.account, moving)
      this.#context.textContent = `${boardContextTitle(moving)} · Open in its own window`
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
        await detached.custody.run(async () => {})
        await (this.#view?.frame.contentWindow as GirnelWindow | undefined)?.girnelEmbed?.prepareMove()
        await this.#view?.custody.run(async () => {})
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
  private closeView(view?: BoardView) {
    if (!view) return
    view.abort.abort(new Error('Board connection closed')); view.custody.revoke(); view.access?.revoke(); view.frame.remove(); this.#popups.delete(view)
    const closing = Promise.allSettled([view.custody.close(),view.access?.close()]).then(() => {}); this.#closing.add(closing)
    void closing.finally(() => this.#closing.delete(closing)).catch(() => {})
  }
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
  reset(): Promise<void> {this.closeNavigation(); this.#navigationState = ''; this.closeView(this.#view); this.#view = undefined; for (const view of this.#popups) {this.closeView(view); view.popup?.close()}; this.dialog.close(); return Promise.allSettled([...this.#closing]).then(() => {})}
  get hasPendingEdits(): boolean {
    return this.#navigationBusy || this.#closing.size !== 0 || [this.#view, ...this.#popups].some(view => {
      if (!view || view.abort.signal.aborted || view.popup?.closed) return false
      try {return view.custody.pending || !!(view.frame.contentWindow as GirnelWindow)?.girnelEmbed?.hasPendingEdits?.()} catch {return true}
    })
  }
}
