import type { AssignmentLogSnapshot } from '../../src/assignment-log.js'
import { assignmentHumanAction, type Assignment } from '../../src/assignments.js'
import type { ChatMessage } from '../../src/chat.js'
import { classifyMessage, mentionedBy, resolveConversation, type Named, type MessageRef } from '../../src/messages.js'
import type { KnownRoom } from './rooms-store.js'
import './workspace-work.css'

export function workspaceDecision(s: Assignment, participant: string): string | undefined {
  if (s.creator === participant) {
    const action = assignmentHumanAction(s)
    if (action) return action
  }
  if (s.owner === participant && s.status === 'offered') return 'Choose whether to start this work'
  if (s.owner === participant && s.status === 'stopping') return 'Confirm work has stopped'
  return undefined
}

export function workspaceMentions(messages: readonly ChatMessage[], participant: string, room: KnownRoom, people: readonly Named[]): Array<{ ref: MessageRef; text: string; reason: string; at: number }> {
  return [...resolveConversation(messages).byKey.values()].flatMap(message => {
    const shown = message.shown, original = message.original
    if (message.retracted || classifyMessage(shown, participant, people) !== 'person') return []
    if (original.sentAt < room.readAt || (original.sentAt === room.readAt && room.readIds?.includes(original.id))) return []
    const reply = shown.reply?.participant === participant
    if (!reply && !mentionedBy(shown, participant, people)) return []
    return [{ ref: { messageId: original.id, participant: original.participant }, text: shown.text,
      reason: reply ? 'Reply to you' : 'Mentioned you', at: original.sentAt }]
  }).sort((a, b) => b.at - a.at || a.ref.messageId.localeCompare(b.ref.messageId))
}

export interface WorkspaceObservation {
  snapshot(): { work: AssignmentLogSnapshot; messages: ChatMessage[]; people: Named[]; error?: string }
  close(): void
  valid(): boolean
}

/** A view of canonical room data, never a task store or a signing surface. */
export class WorkspaceWorkPanel {
  readonly dialog: HTMLDialogElement
  #account?: string
  #mode: 'inbox' | 'work' = 'inbox'
  #observations = new Map<string, WorkspaceObservation>()
  #unavailable = new Map<string, string>()
  #forgotten = new Set<string>()
  #return?: HTMLElement
  #timer?: ReturnType<typeof setInterval>
  #opening = false
  #error?: string
  #frame?: number
  #renderKey?: string
  constructor(readonly root: Document, readonly options: {
    account(): string | undefined
    rooms(): KnownRoom[]
    label(room: KnownRoom): string
    projects(): Array<{ key: string; name: string }>
    inProject(room: KnownRoom, project: string): boolean
    projectLabel(room: KnownRoom): string | undefined
    person(pubkey: string): string
    agent(room: KnownRoom, pubkey: string): boolean
    showMobileNavigation(): boolean
    openProjects(from: HTMLElement): void
    observe(room: KnownRoom, changed: () => void): WorkspaceObservation | string
    openOrigin(room: KnownRoom, target: { assignment: string } | { message: MessageRef }): Promise<void>
    signIn(): void
  }) {
    this.dialog = this.el('workspaceWorkPanel') as HTMLDialogElement
    for (const scope of ['home', 'workspace', 'switcher', 'mobileWorkspace']) for (const mode of ['Inbox', 'Work'] as const) {
      const button = this.el(scope + mode)
      button.onclick = () => {
        ;(this.root.getElementById('roomSwitcher') as HTMLDialogElement).close()
        this.open(mode === 'Inbox' ? 'inbox' : 'work', button)
      }
    }
    this.el('workspaceWorkClose').onclick = () => this.dialog.close()
    this.el('mobileWorkspaceProjects').onclick = () => this.options.openProjects(this.el('mobileWorkspaceProjects'))
    this.el('workspaceWorkSignIn').onclick = () => { this.dialog.close(); this.options.signIn() }
    this.el('workspaceInboxTab').onclick = () => { this.#mode = 'inbox'; this.render() }
    this.el('workspaceWorkTab').onclick = () => { this.#mode = 'work'; this.render() }
    this.el('workspaceWorkProject').onchange = () => this.render()
    this.el('workspaceWorkRefresh').onclick = () => { this.stop(); this.sync() }
    this.dialog.addEventListener('close', () => {
      this.stop(); this.el('workspaceWorkCards').replaceChildren(); this.#error = undefined; this.#renderKey = undefined
      if (this.#return?.isConnected && this.#return.getClientRects().length) this.#return.focus({ preventScroll: true })
    })
  }
  el(id: string): HTMLElement { return this.root.getElementById(id)! }
  open(mode: 'inbox' | 'work', from: HTMLElement): void {
    this.#mode = mode; this.#return = from
    if (!this.dialog.open) this.dialog.showModal()
    this.sync()
    this.#timer ??= setInterval(() => this.sync(), 5_000)
    this.el('workspaceWorkTitle').focus({ preventScroll: true })
  }
  /** Scope is re-read after account, admission, project or room changes. */
  sync(): void {
    this.el('mobileWorkspaceDestinations').hidden = !this.options.showMobileNavigation()
    if (!this.dialog.open) return
    const account = this.options.account()
    if (account !== this.#account) this.stop()
    this.#account = account
    const rooms = account ? this.options.rooms().filter(r => !this.#forgotten.has(r.roomId) && r.endedAt === undefined && r.endsAt === undefined && !r.destruct) : []
    const allowed = new Set(rooms.map(r => r.roomId))
    for (const [id, observation] of this.#observations) if (!allowed.has(id) || !observation.valid()) { observation.close(); this.#observations.delete(id) }
    for (const id of this.#unavailable.keys()) if (!allowed.has(id)) this.#unavailable.delete(id)
    for (const room of rooms) if (!this.#observations.has(room.roomId)) {
      let result: WorkspaceObservation | string
      try { result = this.options.observe(room, () => {
        if (this.dialog.open && this.#frame === undefined) this.#frame = requestAnimationFrame(() => { this.#frame = undefined; this.render() })
      }) }
      catch (error) { result = error instanceof Error ? error.message : 'Room activity could not connect.' }
      if (typeof result === 'string') this.#unavailable.set(room.roomId, result)
      else { this.#unavailable.delete(room.roomId); this.#observations.set(room.roomId, result) }
    }
    this.#timer ??= setInterval(() => this.sync(), 5_000)
    this.render()
  }
  forget(room: string): void {
    this.#forgotten.add(room)
    this.#observations.get(room)?.close(); this.#observations.delete(room); this.#unavailable.delete(room)
    if (this.dialog.open) this.render()
  }
  reset(): void { this.stop(); this.#account = undefined; this.dialog.close(); this.el('workspaceWorkCards').replaceChildren() }
  private stop(): void {
    clearInterval(this.#timer); this.#timer = undefined
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame)
    this.#frame = undefined; this.#renderKey = undefined
    for (const observation of this.#observations.values()) observation.close()
    this.#observations.clear(); this.#unavailable.clear(); this.#forgotten.clear()
  }
  private button(text: string, action: () => void): HTMLButtonElement {
    const button = this.root.createElement('button'); button.type = 'button'; button.textContent = text
    button.disabled = this.#opening; button.onclick = action; return button
  }
  private text(tag: string, text: string, className?: string): HTMLElement {
    const el = this.root.createElement(tag); el.textContent = text; if (className) el.className = className; return el
  }
  private async openOrigin(room: KnownRoom, target: { assignment: string } | { message: MessageRef }): Promise<void> {
    if (this.#opening) return
    const account = this.#account
    if (!account || account !== this.options.account()) { this.reset(); return }
    this.#opening = true; this.#error = undefined; this.render()
    // Release the modal before origin controls, including admission or call
    // switching confirmations, need to take focus. Opening is deliberate.
    this.dialog.close()
    try { await this.options.openOrigin(room, target) }
    catch (e) {
      if (account === this.options.account()) {
        this.#error = e instanceof Error ? e.message : 'The originating room could not open.'
        this.open(this.#mode, this.#return!)
      }
    } finally { this.#opening = false; if (this.dialog.open) this.render() }
  }
  render(): void {
    if (!this.dialog.open) return
    if (this.#account !== this.options.account()) { this.reset(); return }
    const signedIn = !!this.#account
    this.el('workspaceWorkSignIn').hidden = signedIn
    this.el('workspaceWorkTitle').textContent = this.#mode === 'inbox' ? 'Inbox' : 'Work across projects'
    this.el('workspaceInboxTab').setAttribute('aria-pressed', String(this.#mode === 'inbox'))
    this.el('workspaceWorkTab').setAttribute('aria-pressed', String(this.#mode === 'work'))
    const select = this.el('workspaceWorkProject') as HTMLSelectElement, selected = select.value || '*'
    const projects = [{ key: '*', name: 'All projects' }, ...this.options.projects(), { key: '', name: 'No project' }]
    if (JSON.stringify([...select.options].map(o => [o.value, o.textContent])) !== JSON.stringify(projects.map(p => [p.key, p.name]))) {
      select.replaceChildren(...projects.map(p => new Option(p.name, p.key)))
      select.value = projects.some(p => p.key === selected) ? selected : '*'
    }
    const rooms = this.options.rooms().filter(r => !this.#forgotten.has(r.roomId) && r.endedAt === undefined && r.endsAt === undefined && !r.destruct && this.options.inProject(r, select.value))
    const sources = rooms.map(room => ({ room, snapshot: this.#observations.get(room.roomId)?.snapshot() }))
    const key = JSON.stringify([this.#account, this.#mode, select.value, this.#opening, this.#error, sources.map(({ room, snapshot }) => [room.roomId,
      this.options.label(room), this.options.projectLabel(room), room.readAt, room.readIds, this.#unavailable.get(room.roomId), snapshot?.error,
      snapshot?.work.ready, snapshot?.work.error, snapshot?.work.pendingSends, snapshot?.work.assignments.map(s => [s.id, s.head, this.options.person(s.owner), this.options.agent(room, s.owner)]),
      snapshot?.messages.map(m => [m.id, m.text, m.mentions, m.reply, m.retracts, m.replaces, this.options.person(m.participant)]), snapshot?.people])])
    if (key === this.#renderKey) return
    this.#renderKey = key
    const cards = this.el('workspaceWorkCards'); cards.replaceChildren()
    const unavailableNotes: HTMLElement[] = []
    let count = 0, unavailable = 0, loading = 0
    for (const { room, snapshot } of signedIn ? sources : []) {
      const error = this.#unavailable.get(room.roomId) ?? snapshot?.error ?? snapshot?.work.error
      if (error || !snapshot) {
        unavailable++
        const note = this.text('article', '', 'workspaceWorkCard'); note.dataset.room = room.roomId
        note.append(this.text('h3', this.options.label(room)), this.text('p', this.options.projectLabel(room) ?? 'No project', 'workMeta'),
          this.text('p', error ?? 'Open this room to check its work.'), this.button('Open room', () => { void this.openOrigin(room, { assignment: '' }) }))
        unavailableNotes.push(note); continue
      }
      if (!snapshot.work.ready) loading++
      if (snapshot.work.pendingSends) {
        const warning = this.text('article', '', 'workspaceWorkCard')
        warning.append(this.text('h3', this.options.label(room)), this.text('p', 'Saved updates need checking in this room.'),
          this.button('Open room', () => { void this.openOrigin(room, { assignment: '' }) })); cards.append(warning)
      }
      for (const assignment of snapshot.work.assignments) {
        const decision = workspaceDecision(assignment, this.#account!)
        if (this.#mode === 'inbox' && !decision) continue
        if (this.#mode === 'work' && ['accepted', 'cancelled'].includes(assignment.status)) continue
        count++
        const card = this.text('article', '', 'workspaceWorkCard'); card.dataset.room = room.roomId; card.dataset.assignment = assignment.id
        card.append(this.text('p', `${this.options.projectLabel(room) ?? 'No project'} · ${this.options.label(room)}`, 'workMeta'),
          this.text('h3', assignment.objective), this.text('p', `Responsible: ${snapshot.people.find(p => p.participant === assignment.owner)?.name ?? this.options.person(assignment.owner)}${this.options.agent(room, assignment.owner) || snapshot.people.some(p => p.participant === assignment.owner && p.agent) ? ' (agent)' : ''} · ${assignment.status}`))
        if (decision) card.append(this.text('p', decision, 'workDecision'))
        else card.append(this.text('p', assignment.next))
        card.append(this.button('Open task in room', () => { void this.openOrigin(room, { assignment: assignment.id }) })); cards.append(card)
      }
      if (this.#mode === 'inbox') for (const message of workspaceMentions(snapshot.messages, this.#account!, room, snapshot.people)) {
        count++
        const card = this.text('article', '', 'workspaceWorkCard'); card.dataset.room = room.roomId; card.dataset.messageId = message.ref.messageId
        card.append(this.text('p', `${this.options.projectLabel(room) ?? 'No project'} · ${this.options.label(room)}`, 'workMeta'),
          this.text('h3', `${this.options.person(message.ref.participant)} · ${message.reason}`), this.text('p', message.text.slice(0, 400)),
          this.button('Open message in room', () => { void this.openOrigin(room, { message: message.ref }) })); cards.append(card)
      }
    }
    this.el('workspaceWorkStatus').textContent = this.#error ?? (!signedIn ? 'Sign in with Nostr to see your projects and work across conversations.'
      : `${count} ${this.#mode === 'inbox' ? (count === 1 ? 'item needs attention' : 'items need attention') : (count === 1 ? 'active task' : 'active tasks')}.${loading ? ` ${loading} ${loading === 1 ? 'room is loading or has' : 'rooms are loading or have'} missing task history.` : ''}${unavailable ? ` ${unavailable} ${unavailable === 1 ? 'room needs' : 'rooms need'} opening.` : ''}`)
    this.el('workspaceWorkCoverage').hidden = !signedIn
    if (signedIn && !count) cards.prepend(this.text('p', 'No matching items in the recent activity loaded here. Open a room to check older work.', 'workEmpty'))
    if (unavailableNotes.length) {
      const details = this.root.createElement('details'); details.className = 'workspaceWorkUnavailable'
      details.append(this.text('summary', `Check activity in ${unavailableNotes.length} ${unavailableNotes.length === 1 ? 'room' : 'rooms'}`), ...unavailableNotes)
      cards.append(details)
    }
  }
}
