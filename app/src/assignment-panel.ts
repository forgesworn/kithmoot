import type { AssignmentLog, AssignmentStorage } from '../../src/assignment-log.js'
import { assignmentHumanAction, type Assignment, type AssignmentAction, type AssignmentOperation } from '../../src/assignments.js'
import type { RoomSession } from '../../src/session.js'
import { confirmAction } from './confirm-action.js'

interface WorkDraft {
  objective: string
  criteria: string
  owner: string
  action: string
  inputs: Map<string, string>
  open: boolean
  notes: Map<string, string>
  pendingCreate?: string
}

export interface AssignmentPerson { pubkey: string; label: string; agent: boolean; ownerDevice?: string; actions?: AssignmentAction[] }
export class AssignmentPanel {
  #log?: AssignmentLog
  #off?: () => void
  #release?: () => void
  #dialog: HTMLDialogElement
  #cards: HTMLElement
  #status: HTMLElement
  #button: HTMLButtonElement
  #busy = false
  #epoch = 0
  #owner: HTMLSelectElement
  #action: HTMLSelectElement
  #inputs: HTMLElement
  #peopleKey = ''
  #drafts = new Map<string, string>()
  #roomKey?: string
  #roomDrafts = new Map<string, WorkDraft>()
  #pendingCreate?: string
  #decisionsOnly = false
  #wide = matchMedia('(min-width: 1280px)')
  constructor(readonly root: Document, readonly people: () => AssignmentPerson[], readonly changed: () => void = () => {}) {
    this.#dialog = root.getElementById('assignmentPanel') as HTMLDialogElement
    this.#cards = root.getElementById('assignmentCards')!
    this.#status = root.getElementById('assignmentStatus')!
    this.#button = root.getElementById('openAssignments') as HTMLButtonElement
    this.#owner = root.getElementById('assignmentOwner') as HTMLSelectElement
    this.#action = root.getElementById('assignmentAction') as HTMLSelectElement
    this.#inputs = root.getElementById('assignmentInputs')!
    this.#button.onclick = () => { this.#decisionsOnly = false; this.#open() }
    root.getElementById('reviewWork')!.onclick = () => { this.#decisionsOnly = true; this.#open() }
    for (const [id, decisions] of [['assignmentAll', false], ['assignmentDecisions', true]] as const) {
      root.getElementById(id)!.onclick = () => { this.#decisionsOnly = decisions; this.#render() }
    }
    this.#wide.addEventListener('change', () => {
      if (!this.#dialog.open) return
      this.#dialog.close()
      this.#open()
    })
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.#dialog.open && !root.querySelector('dialog:modal')) {
        event.preventDefault(); this.#dialog.close()
      }
    })
    root.getElementById('assignmentClose')!.onclick = () => this.#dialog.close()
    this.#dialog.addEventListener('close', () => {
      if (this.#dialog.open) return
      this.#button.setAttribute('aria-expanded', 'false')
      if (this.#roomKey) this.#button.focus({ preventScroll: true })
    })
    this.#dialog.addEventListener('click', event => { if (event.target === this.#dialog) {
      const bounds = this.#dialog.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.#dialog.close()
    } })
    this.#dialog.addEventListener('input', event => { (event.target as HTMLElement).removeAttribute('aria-invalid'); this.changed() })
    this.#owner.onchange = () => this.#actions()
    this.#action.onchange = () => this.#actionInputs()
    const create = root.getElementById('assignmentCreate') as HTMLFormElement
    create.noValidate = true
    create.onsubmit = e => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const invalid = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:invalid, textarea:invalid, select:invalid')
      if (invalid) {
        invalid.setAttribute('aria-invalid', 'true')
        this.#status.textContent = 'Complete the highlighted field before sharing this assignment.'
        invalid.focus()
        return
      }
      const data = new FormData(form)
      const values: Record<string, string> = {}
      for (const input of this.#inputs.querySelectorAll<HTMLInputElement>('input')) if (input.value.trim()) values[input.name] = input.value.trim()
      const operation: AssignmentOperation = { op: 'create', objective: String(data.get('objective') ?? '').trim(), criteria: String(data.get('criteria') ?? '').trim(), owner: this.#owner.value,
        ...(this.people().find(p => p.pubkey === this.#owner.value)?.ownerDevice ? { ownerDevice: this.people().find(p => p.pubkey === this.#owner.value)!.ownerDevice! } : {}),
        ...(this.#action.value ? { action: this.#action.value, inputs: values } : {}) }
      const epoch = this.#epoch
      void this.#run(async log => {
        this.#pendingCreate = this.#formValue()
        await log.submit(undefined, operation, crypto.randomUUID())
        if (epoch !== this.#epoch) return
        this.#finishCreate()
      })
    }
    root.getElementById('assignmentRetry')!.onclick = () => {
      const epoch = this.#epoch
      void this.#run(async log => { await log.retry(); if (epoch === this.#epoch) this.#finishCreate() })
    }
    root.getElementById('assignmentDiscard')!.onclick = async () => {
      const epoch = this.#epoch
      if (!await confirmAction({ title: 'Discard this assignment draft?', message: 'The objective, criteria and action inputs in this form will be cleared. Shared assignments stay in the room.', confirmLabel: 'Discard draft', danger: true, isCurrent: () => epoch === this.#epoch })) return
      create.reset(); this.#owners(); this.changed()
    }
  }
  get busy(): boolean { return this.#busy }
  #open(): void {
    this.#owners(); this.#render()
    if (!this.#dialog.open) {
      if (this.#wide.matches) this.#dialog.show()
      else this.#dialog.showModal()
    }
    this.#button.setAttribute('aria-expanded', 'true')
    this.root.getElementById('assignmentTitle')!.focus({ preventScroll: true })
  }
  #needsYou(s: Assignment): boolean {
    const participant = this.#log?.participant
    return (s.creator === participant && Boolean(assignmentHumanAction(s))) ||
      (s.owner === participant && ['offered', 'stopping'].includes(s.status))
  }
  /** Choosing an advertised capability prepares a form; only sharing submits it. */
  offerTo(owner: string, action: string): void {
    if (!this.#roomKey) return
    const form = this.root.getElementById('assignmentCreate') as HTMLFormElement
    const objective = form.elements.namedItem('objective') as HTMLTextAreaElement
    const criteria = form.elements.namedItem('criteria') as HTMLTextAreaElement
    form.closest('details')!.open = true
    this.#decisionsOnly = false
    this.#open()
    if (this.#busy || [objective.value, criteria.value, ...[...this.#inputs.querySelectorAll<HTMLInputElement>('input')].map(input => input.value)].some(Boolean)) {
      this.#status.textContent = this.#busy ? 'Wait for the current update to finish.' : 'You have an unfinished assignment. Share or discard that draft before starting another.'
      this.#status.focus({ preventScroll: true })
      return
    }
    this.#owners()
    if (!this.people().find(person => person.pubkey === owner)?.actions?.some(candidate => candidate.id === action)) {
      this.#status.textContent = 'That action is no longer available. Choose an owner and action from the current list.'
      this.#status.focus({ preventScroll: true })
      return
    }
    this.#owner.value = owner
    this.#actions()
    this.#action.value = action
    this.#actionInputs()
    objective.focus()
  }
  #formValue(): string {
    const form = this.root.getElementById('assignmentCreate') as HTMLFormElement
    return JSON.stringify([(form.elements.namedItem('objective') as HTMLTextAreaElement).value, (form.elements.namedItem('criteria') as HTMLTextAreaElement).value, this.#owner.value, this.#action.value,
      [...this.#inputs.querySelectorAll<HTMLInputElement>('input')].map(input => [input.name, input.value])])
  }
  #finishCreate(): void {
    if (this.#pendingCreate === this.#formValue()) {
      ;(this.root.getElementById('assignmentCreate') as HTMLFormElement).reset()
      this.#owners()
      ;(this.root.getElementById('assignmentNew') as HTMLDetailsElement).open = false
      this.#decisionsOnly = false
    }
    this.#pendingCreate = undefined
  }
  get hasDrafts(): boolean {
    this.#remember()
    return [...this.#roomDrafts.values()].some(draft => Boolean(draft.objective.trim() || draft.criteria.trim() || [...draft.inputs.values(), ...draft.notes.values()].some(text => text.trim())))
  }
  #remember(): void {
    if (!this.#roomKey) return
    const form = this.root.getElementById('assignmentCreate') as HTMLFormElement
    this.#roomDrafts.set(this.#roomKey, {
      objective: (form.elements.namedItem('objective') as HTMLTextAreaElement).value,
      criteria: (form.elements.namedItem('criteria') as HTMLTextAreaElement).value,
      owner: this.#owner.value, action: this.#action.value,
      inputs: new Map([...this.#inputs.querySelectorAll<HTMLInputElement>('input')].map(input => [input.name, input.value])),
      open: form.closest('details')!.open, notes: this.#drafts, pendingCreate: this.#pendingCreate,
    })
  }
  #restore(key: string): void {
    const draft = this.#roomDrafts.get(key)
    this.#roomKey = key
    this.#drafts = draft?.notes ?? new Map()
    this.#pendingCreate = draft?.pendingCreate
    this.#owners()
    if (!draft) return
    const form = this.root.getElementById('assignmentCreate') as HTMLFormElement
    ;(form.elements.namedItem('objective') as HTMLTextAreaElement).value = draft.objective
    ;(form.elements.namedItem('criteria') as HTMLTextAreaElement).value = draft.criteria
    if ([...this.#owner.options].some(option => option.value === draft.owner)) this.#owner.value = draft.owner
    this.#actions()
    if ([...this.#action.options].some(option => option.value === draft.action)) this.#action.value = draft.action
    this.#actionInputs()
    for (const input of this.#inputs.querySelectorAll<HTMLInputElement>('input')) input.value = draft.inputs.get(input.name) ?? ''
    form.closest('details')!.open = draft.open
  }
  #require(): AssignmentLog { if (!this.#log) throw new Error('Assignments are not connected'); return this.#log }
  async attach(session: RoomSession): Promise<void> {
    this.detach()
    const epoch = this.#epoch
    const key = `kithmoot.assignments.v1.${session.participant}.${session.roomId}`
    this.#restore(key)
    let releaseOwn: (() => void) | undefined
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely lock assignment storage')
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request(key, { ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error('Assignments are open in another tab for this room. Use that tab or close it first.')); return }
          await new Promise<void>(release => { releaseOwn = release; resolve() })
        }).catch(reject)
      })
      if (epoch !== this.#epoch) { releaseOwn?.(); return }
      this.#release = releaseOwn
      const store: AssignmentStorage = { async load() { return localStorage.getItem(key) ?? undefined }, async save(value) { localStorage.setItem(key, value) } }
      const log = await session.assignments(store)
      if (epoch !== this.#epoch) { log.close(); releaseOwn?.(); return }
      this.#log = log; this.#off = log.onChange(() => this.#render()); this.#render()
    } catch (e) {
      releaseOwn?.()
      if (epoch !== this.#epoch) return
      this.#status.textContent = e instanceof Error ? e.message : 'Assignments could not connect'
      this.#release = undefined
    }
  }
  detach(): void {
    this.#remember()
    this.#roomKey = undefined
    ++this.#epoch; this.#off?.(); this.#off = undefined; this.#log = undefined; this.#release?.(); this.#release = undefined
    this.#busy = false; this.#dialog.close(); this.#cards.replaceChildren()
    const form = this.root.getElementById('assignmentCreate') as HTMLFormElement
    form.reset(); form.closest('details')!.open = false
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid')
    this.#owner.replaceChildren(); this.#action.replaceChildren(); this.#inputs.replaceChildren()
    this.#peopleKey = ''; this.#drafts = new Map(); this.#pendingCreate = undefined
    this.#status.textContent = 'Connecting assignments…'; this.#button.textContent = 'Work'
    this.#button.removeAttribute('data-attention')
    this.root.getElementById('workAttention')!.hidden = true
    this.#decisionsOnly = false
    ;(this.root.getElementById('assignmentFields') as HTMLFieldSetElement).disabled = false
    ;(form.querySelector('button[type=submit]') as HTMLButtonElement).disabled = true
    ;(this.root.getElementById('assignmentDiscard') as HTMLButtonElement).disabled = false
    this.root.getElementById('assignmentRetry')!.hidden = true
  }
  #owners(): void {
    const selected = this.#owner.value
    const action = this.#action.value
    const inputs = new Map([...this.#inputs.querySelectorAll<HTMLInputElement>('input')].map(i => [i.name, i.value]))
    this.#owner.replaceChildren(new Option('Choose an owner', ''))
    for (const p of this.people()) { const o = this.root.createElement('option'); o.value = p.pubkey; o.textContent = `${p.label}${p.agent ? ' (agent)' : ''}`; this.#owner.append(o) }
    this.#owner.value = [...this.#owner.options].some(o => o.value === selected) ? selected : ''
    this.#actions()
    if (this.#owner.value === selected && [...this.#action.options].some(o => o.value === action)) {
      this.#action.value = action; this.#actionInputs()
      for (const i of this.#inputs.querySelectorAll<HTMLInputElement>('input')) i.value = inputs.get(i.name) ?? ''
    }
  }
  refreshPeople(): void {
    const key = JSON.stringify(this.people())
    if (key === this.#peopleKey) return
    this.#peopleKey = key; this.#owners()
  }
  #actions(): void {
    this.#action.replaceChildren(new Option('Describe the work', ''))
    for (const action of this.people().find(p => p.pubkey === this.#owner.value)?.actions ?? []) this.#action.append(new Option(action.label, action.id))
    this.#actionInputs()
  }
  #actionInputs(): void {
    this.#inputs.replaceChildren()
    const action = this.people().find(p => p.pubkey === this.#owner.value)?.actions?.find(a => a.id === this.#action.value)
    if (!action) return
    const description = this.root.createElement('p'); description.textContent = action.description; this.#inputs.append(description)
    for (const i of action.inputs) {
      const label = this.root.createElement('label'); label.textContent = i.label
      const input = this.root.createElement('input'); input.name = i.id; input.required = i.required; input.maxLength = 1000
      label.append(input); this.#inputs.append(label)
    }
  }
  async #run(action: (log: AssignmentLog) => Promise<unknown>): Promise<void> {
    if (this.#busy) return
    const epoch = this.#epoch
    this.#busy = true; this.#render()
    this.changed()
    try { await action(this.#require()); if (epoch === this.#epoch) this.#status.textContent = 'Update saved and acknowledged by a relay.' }
    catch (e) { if (epoch === this.#epoch) this.#status.textContent = e instanceof Error ? e.message : 'Update failed' }
    finally { if (epoch === this.#epoch) { this.#busy = false; this.#render(false); this.changed() } }
  }
  #render(updateStatus = true): void {
    const snapshot = this.#log?.snapshot()
    if (!snapshot) return
    const active = snapshot.assignments.filter(s => !['accepted', 'cancelled'].includes(s.status))
    const decisions = snapshot.assignments.filter(s => this.#needsYou(s))
    this.#button.textContent = active.length ? `Work (${active.length})` : 'Work'
    this.#button.toggleAttribute('data-attention', decisions.length > 0)
    this.root.getElementById('workAttention')!.hidden = decisions.length === 0 || !snapshot.ready
    this.root.getElementById('workAttentionText')!.textContent = `${decisions.length} ${decisions.length === 1 ? 'assignment needs' : 'assignments need'} your attention`
    this.root.getElementById('assignmentAll')!.setAttribute('aria-pressed', String(!this.#decisionsOnly))
    this.root.getElementById('assignmentDecisions')!.setAttribute('aria-pressed', String(this.#decisionsOnly))
    this.root.getElementById('assignmentDecisions')!.textContent = `Needs you (${decisions.length})`
    if (updateStatus) this.#status.textContent = snapshot.error ?? (snapshot.pendingHistory ? 'Some assignment history is missing. Restore it before acting.' : !snapshot.ready ? 'Loading assignment history…' : snapshot.pendingSends ? 'An update is awaiting delivery. Retry the saved update.' : '')
    const focused = this.root.activeElement
    const key = focused instanceof HTMLElement && this.#cards.contains(focused) ? focused.dataset.workField : undefined
    const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const : undefined
    const scroll = this.#dialog.scrollTop
    const expanded = new Map([...this.#cards.querySelectorAll<HTMLDetailsElement>('details')].map(details => [details.dataset.workField, details.open]))
    this.#cards.replaceChildren()
    const shown = this.#decisionsOnly ? decisions : snapshot.assignments
    const ordered = [...shown].sort((a, b) => Number(this.#needsYou(b)) - Number(this.#needsYou(a)))
    for (const s of ordered) this.#cards.append(this.#card(s))
    if (!shown.length) {
      const p = this.root.createElement('p'); p.className = 'workEmpty'
      p.textContent = this.#decisionsOnly ? 'Nothing needs your decision. Follow progress in All work.' : 'Describe an outcome to start shared work with a person or agent.'
      this.#cards.append(p)
    }
    for (const button of this.#dialog.querySelectorAll<HTMLButtonElement>('button:not(#assignmentClose)')) {
      const localDraft = ['assignmentDiscard', 'assignmentAll', 'assignmentDecisions'].includes(button.id)
      const retry = button.id === 'assignmentRetry'
      button.disabled = this.#busy || (!localDraft && (!snapshot.ready || snapshot.pendingHistory > 0 || (!retry && snapshot.pendingSends > 0)))
    }
    ;(this.root.getElementById('assignmentFields') as HTMLFieldSetElement).disabled = this.#busy
    this.root.getElementById('assignmentRetry')!.hidden = snapshot.pendingSends === 0
    for (const details of this.#cards.querySelectorAll<HTMLDetailsElement>('details')) details.open = expanded.get(details.dataset.workField) ?? details.open
    if (key) {
      const replacement = [...this.#cards.querySelectorAll<HTMLElement>('[data-work-field]')].find(element => element.dataset.workField === key)
      if (replacement) {
        replacement.focus({ preventScroll: true })
        if (replacement instanceof HTMLTextAreaElement && selection) replacement.setSelectionRange(...selection)
      } else this.#status.focus({ preventScroll: true })
      this.#dialog.scrollTop = scroll
    }
  }
  #card(s: Assignment): HTMLElement {
    const visibleDrafts = new Set<string>()
    const article = this.root.createElement('article'); article.className = 'assignmentCard'; article.dataset.assignment = s.id
    article.dataset.attention = String(this.#needsYou(s))
    const title = this.root.createElement('h3'); title.textContent = s.objective; article.append(title)
    const owner = this.people().find(p => p.pubkey === s.owner)?.label ?? s.owner.slice(0, 12)
    const meta = this.root.createElement('p'); meta.className = 'workMeta'
    const state = this.root.createElement('span'); state.className = 'workState'; state.textContent = s.status
    meta.append(state, ` · ${owner}`); article.append(meta)
    if (this.#needsYou(s)) {
      const next = this.root.createElement('p'); next.className = 'workDecision'
      next.textContent = s.creator === this.#log?.participant ? assignmentHumanAction(s) ?? s.next : s.next
      article.append(next)
    }
    for (const line of [!this.#needsYou(s) && !s.result ? s.next : '', s.question, s.progress, s.answer ? `Answer: ${s.answer}` : '']) {
      if (!line) continue
      const p = this.root.createElement('p'); p.textContent = line; article.append(p)
    }
    if (s.result) {
      const criteria = this.root.createElement('p'); criteria.className = 'note'; criteria.textContent = `Acceptance: ${s.criteria}`; article.append(criteria)
      const result = this.root.createElement('p'); result.className = 'workResult'; result.textContent = s.result.summary; article.append(result)
      const evidence = this.root.createElement('details'); evidence.dataset.workField = `${s.id}:evidence`
      const summary = this.root.createElement('summary'); summary.textContent = 'Result evidence'; summary.dataset.workField = `${s.id}:evidence-toggle`
      const content = this.root.createElement('pre'); content.textContent = `${s.result.evidence}\n\nResult ${s.result.id}`
      evidence.append(summary, content); article.append(evidence)
    }
    const send = (op: AssignmentOperation, clearDraft?: string, text?: string) => this.#run(async log => {
      if (log.snapshot().assignments.find(a => a.id === s.id)?.head !== s.head) throw new Error('This assignment changed. Review its current state before acting.')
      await log.submit(s.id, op, crypto.randomUUID(), s.head)
      if (log !== this.#log) return
      if (clearDraft && this.#drafts.get(clearDraft) === text) this.#drafts.delete(clearDraft)
    })
    const button = (label: string, action: () => void) => { const b = this.root.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.workField = `${s.id}:${label}`; if (label === 'Accept this result') b.className = 'primary'; b.onclick = action; article.append(b) }
    const inputAction = (label: string, field: string, build: (text: string) => AssignmentOperation, into: HTMLElement = article) => {
      const form = this.root.createElement('form'); const l = this.root.createElement('label'); l.textContent = field
      const input = this.root.createElement('textarea'); input.required = true; input.maxLength = 2000; l.append(input)
      const draftKey = `${s.id}:${field}`
      visibleDrafts.add(draftKey)
      input.dataset.workField = draftKey
      input.value = this.#drafts.get(draftKey) ?? ''
      input.oninput = () => this.#drafts.set(draftKey, input.value)
      const submit = this.root.createElement('button'); submit.textContent = label; submit.type = 'submit'; submit.dataset.workField = `${draftKey}:send`; form.append(l, submit)
      form.noValidate = true
      form.onsubmit = e => {
        e.preventDefault()
        const text = input.value
        if (!text.trim()) { input.setAttribute('aria-invalid', 'true'); this.#status.textContent = `Complete “${field}” before sending.`; input.focus(); return }
        void send(build(text.trim()), draftKey, text)
      }; into.append(form)
    }
    if (s.creator === this.#log?.participant) {
      if (s.status === 'review' && s.result) {
        button('Accept this result', () => { void send({ op: 'accept', result: s.result!.id }) })
        const changes = this.root.createElement('details'); changes.dataset.workField = `${s.id}:changes`
        const summary = this.root.createElement('summary'); summary.textContent = 'Request changes'; summary.dataset.workField = `${s.id}:changes-toggle`; changes.append(summary)
        inputAction('Request changes', 'What needs changing?', reason => ({ op: 'reject', result: s.result!.id, reason }), changes)
        changes.open = [...changes.querySelectorAll('textarea')].some(input => Boolean(input.value.trim()))
        article.append(changes)
      }
      if (s.status === 'blocked') inputAction('Send answer', 'Answer for the owner', text => ({ op: 'answer', text }))
      if (['offered', 'running', 'blocked', 'review'].includes(s.status)) {
        const manage = this.root.createElement('details'); manage.dataset.workField = `${s.id}:manage`
        const summary = this.root.createElement('summary'); summary.textContent = 'Manage assignment'; summary.dataset.workField = `${s.id}:manage-toggle`
        manage.append(summary)
        inputAction('Cancel assignment', 'Reason for cancellation', reason => ({ op: 'stop', reason, purpose: 'cancel' }), manage)
        inputAction('Request handoff', 'Reason for handing over', reason => ({ op: 'stop', reason, purpose: 'handoff' }), manage)
        manage.open = [...manage.querySelectorAll('textarea')].some(input => Boolean(input.value.trim()))
        article.append(manage)
      }
      if (s.status === 'stopped') {
        const select = this.root.createElement('select'); select.setAttribute('aria-label', 'Next owner')
        for (const p of this.people()) select.append(new Option(p.label, p.pubkey))
        article.append(select)
        button('Hand over', () => {
          const ownerDevice = this.people().find(p => p.pubkey === select.value)?.ownerDevice
          void send({ op: 'assign', owner: select.value, ...(ownerDevice ? { ownerDevice } : {}), reason: 'Handed over after confirmed stop' })
        })
      }
    }
    // Human ownership uses the same state machine; automated execution is
    // reserved by the agent runtime's durable journal, never by this button.
    const self = this.people().find(p => p.pubkey === this.#log?.participant)
    if (s.owner === this.#log?.participant && !self?.agent) {
      if (s.status === 'offered') inputAction('Start work', 'Your next action', next => ({ op: 'claim', executor: crypto.randomUUID(), next }))
      if (s.status === 'running' && s.executor) {
        inputAction('Ask a question', 'What do you need?', question => ({ op: 'block', executor: s.executor!, question }))
        inputAction('Submit for review', 'Result and evidence', evidence => ({ op: 'result', executor: s.executor!, summary: 'Work ready for review', evidence }))
      }
      if (s.status === 'stopping' && s.executor) inputAction('Confirm work stopped', 'What confirms it has stopped?', evidence => ({ op: 'release', executor: s.executor!, evidence }))
    }
    for (const [key, text] of this.#drafts) {
      if (!key.startsWith(`${s.id}:`) || visibleDrafts.has(key) || !text.trim()) continue
      const label = this.root.createElement('label')
      label.textContent = `${key.slice(s.id.length + 1)} — unsent note from an earlier step`
      const input = this.root.createElement('textarea'); input.value = text; input.readOnly = true; input.dataset.workField = key
      label.append(input); article.append(label)
      button('Discard unsent note', () => {
        const epoch = this.#epoch
        void confirmAction({ title: 'Discard this unsent note?', message: 'This clears only your unsent note. The shared assignment and its history stay in the room.', confirmLabel: 'Discard note', danger: true, isCurrent: () => epoch === this.#epoch && this.#drafts.get(key) === text }).then(approved => {
          if (!approved) return
          this.#drafts.delete(key); this.#render(); this.changed()
        })
      })
    }
    const history = this.root.createElement('details'); history.dataset.workField = `${s.id}:history`
    const summary = this.root.createElement('summary'); summary.textContent = 'History'; summary.dataset.workField = `${s.id}:history-toggle`; history.append(summary)
    const criteria = this.root.createElement('p'); criteria.textContent = `Acceptance: ${s.criteria}`; history.append(criteria)
    const attempt = this.root.createElement('p'); attempt.textContent = `Attempt ${s.attempt} · ${s.next}`; history.append(attempt)
    for (const entry of s.history) { const p = this.root.createElement('p'); p.textContent = `${new Date(entry.at * 1000).toLocaleString()} · ${entry.by.slice(0, 12)} · ${entry.operation.op}`; history.append(p) }
    article.append(history)
    return article
  }
}
