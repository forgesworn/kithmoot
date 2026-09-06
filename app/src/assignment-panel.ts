import type { AssignmentLog, AssignmentStorage } from '../../src/assignment-log.js'
import type { Assignment, AssignmentAction, AssignmentOperation } from '../../src/assignments.js'
import type { RoomSession } from '../../src/session.js'

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
  constructor(readonly root: Document, readonly people: () => AssignmentPerson[]) {
    this.#dialog = root.getElementById('assignmentPanel') as HTMLDialogElement
    this.#cards = root.getElementById('assignmentCards')!
    this.#status = root.getElementById('assignmentStatus')!
    this.#button = root.getElementById('openAssignments') as HTMLButtonElement
    this.#owner = root.getElementById('assignmentOwner') as HTMLSelectElement
    this.#action = root.getElementById('assignmentAction') as HTMLSelectElement
    this.#inputs = root.getElementById('assignmentInputs')!
    this.#button.onclick = () => { this.#owners(); this.#render(); this.#dialog.showModal() }
    root.getElementById('assignmentClose')!.onclick = () => this.#dialog.close()
    this.#owner.onchange = () => this.#actions()
    this.#action.onchange = () => this.#actionInputs()
    root.getElementById('assignmentCreate')!.onsubmit = e => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const values: Record<string, string> = {}
      for (const input of this.#inputs.querySelectorAll<HTMLInputElement>('input')) if (input.value.trim()) values[input.name] = input.value.trim()
      const operation: AssignmentOperation = { op: 'create', objective: String(data.get('objective') ?? '').trim(), criteria: String(data.get('criteria') ?? '').trim(), owner: this.#owner.value,
        ...(this.people().find(p => p.pubkey === this.#owner.value)?.ownerDevice ? { ownerDevice: this.people().find(p => p.pubkey === this.#owner.value)!.ownerDevice! } : {}),
        ...(this.#action.value ? { action: this.#action.value, inputs: values } : {}) }
      void this.#run(async () => {
        await this.#require().submit(undefined, operation, crypto.randomUUID())
        form.reset(); this.#owners()
      })
    }
    root.getElementById('assignmentRetry')!.onclick = () => { void this.#run(() => this.#require().retry()) }
  }
  #require(): AssignmentLog { if (!this.#log) throw new Error('Assignments are not connected'); return this.#log }
  async attach(session: RoomSession): Promise<void> {
    this.detach()
    const epoch = this.#epoch
    const key = `kithmoot.assignments.v1.${session.participant}.${session.roomId}`
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
  detach(): void { ++this.#epoch; this.#off?.(); this.#off = undefined; this.#log = undefined; this.#release?.(); this.#release = undefined; this.#dialog.close(); this.#cards.replaceChildren(); this.#status.textContent = 'Connecting assignments…'; this.#button.textContent = 'Work' }
  #owners(): void {
    const selected = this.#owner.value
    const action = this.#action.value
    const inputs = new Map([...this.#inputs.querySelectorAll<HTMLInputElement>('input')].map(i => [i.name, i.value]))
    this.#owner.replaceChildren()
    for (const p of this.people()) { const o = this.root.createElement('option'); o.value = p.pubkey; o.textContent = `${p.label}${p.agent ? ' (agent)' : ''}`; this.#owner.append(o) }
    if ([...this.#owner.options].some(o => o.value === selected)) this.#owner.value = selected
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
  async #run(action: () => Promise<unknown>): Promise<void> {
    if (this.#busy) return
    this.#busy = true; this.#render()
    try { await action(); this.#status.textContent = 'Update saved and acknowledged by a relay.' }
    catch (e) { this.#status.textContent = e instanceof Error ? e.message : 'Update failed' }
    finally { this.#busy = false; this.#render(false) }
  }
  #render(updateStatus = true): void {
    const snapshot = this.#log?.snapshot()
    if (!snapshot) return
    const active = snapshot.assignments.filter(s => !['accepted', 'cancelled'].includes(s.status))
    this.#button.textContent = active.length ? `Work (${active.length})` : 'Work'
    if (updateStatus) this.#status.textContent = snapshot.error ?? (snapshot.pendingHistory ? 'Some assignment history is missing. Restore it before acting.' : !snapshot.ready ? 'Loading assignment history…' : snapshot.pendingSends ? 'An update is awaiting delivery. Retry the saved update.' : 'Shared with this room. Results remain pending until their creator accepts them.')
    this.#cards.replaceChildren()
    for (const s of snapshot.assignments) this.#cards.append(this.#card(s))
    if (!snapshot.assignments.length) { const p = this.root.createElement('p'); p.textContent = 'No shared assignments yet.'; this.#cards.append(p) }
    for (const button of this.#dialog.querySelectorAll<HTMLButtonElement>('button:not(#assignmentClose)')) button.disabled = this.#busy || !snapshot.ready || snapshot.pendingHistory > 0
    ;(this.root.getElementById('assignmentFields') as HTMLFieldSetElement).disabled = this.#busy || !snapshot.ready
  }
  #card(s: Assignment): HTMLElement {
    const article = this.root.createElement('article'); article.className = 'assignmentCard'; article.dataset.assignment = s.id
    const title = this.root.createElement('h3'); title.textContent = s.objective; article.append(title)
    const owner = this.people().find(p => p.pubkey === s.owner)?.label ?? s.owner.slice(0, 12)
    for (const line of [`${s.status} · ${owner} · attempt ${s.attempt}`, `Acceptance: ${s.criteria}`, s.next, s.progress, s.question, s.answer ? `Answer: ${s.answer}` : '']) {
      if (!line) continue
      const p = this.root.createElement('p'); p.textContent = line; article.append(p)
    }
    if (s.result) {
      const result = this.root.createElement('pre'); result.textContent = `${s.result.summary}\n\n${s.result.evidence}\n\nResult ${s.result.id}`; article.append(result)
    }
    const send = (op: AssignmentOperation) => this.#run(async () => {
      if (this.#require().snapshot().assignments.find(a => a.id === s.id)?.head !== s.head) throw new Error('This assignment changed. Review its current state before acting.')
      await this.#require().submit(s.id, op, crypto.randomUUID())
    })
    const button = (label: string, action: () => void) => { const b = this.root.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; article.append(b) }
    const inputAction = (label: string, field: string, build: (text: string) => AssignmentOperation) => {
      const form = this.root.createElement('form'); const l = this.root.createElement('label'); l.textContent = field
      const input = this.root.createElement('textarea'); input.required = true; input.maxLength = 2000; l.append(input)
      const draftKey = `${s.id}:${field}`
      input.value = this.#drafts.get(draftKey) ?? ''
      input.oninput = () => this.#drafts.set(draftKey, input.value)
      const submit = this.root.createElement('button'); submit.textContent = label; submit.type = 'submit'; form.append(l, submit)
      form.onsubmit = e => { e.preventDefault(); void send(build(input.value.trim())) }; article.append(form)
    }
    if (s.creator === this.#log?.participant) {
      if (s.status === 'review' && s.result) {
        button('Accept this result', () => { void send({ op: 'accept', result: s.result!.id }) })
        inputAction('Request changes', 'What needs changing?', reason => ({ op: 'reject', result: s.result!.id, reason }))
      }
      if (s.status === 'blocked') inputAction('Send answer', 'Answer for the owner', text => ({ op: 'answer', text }))
      if (['offered', 'running', 'blocked', 'review'].includes(s.status)) {
        inputAction('Cancel assignment', 'Reason for cancellation', reason => ({ op: 'stop', reason, purpose: 'cancel' }))
        inputAction('Request handoff', 'Reason for handing over', reason => ({ op: 'stop', reason, purpose: 'handoff' }))
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
    const history = this.root.createElement('details'); const summary = this.root.createElement('summary'); summary.textContent = 'History'; history.append(summary)
    for (const entry of s.history) { const p = this.root.createElement('p'); p.textContent = `${new Date(entry.at * 1000).toLocaleString()} · ${entry.by.slice(0, 12)} · ${entry.operation.op}`; history.append(p) }
    article.append(history)
    return article
  }
}
