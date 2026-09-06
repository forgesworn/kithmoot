import { ContextVault, type ContextIdentity, type ContextView, type ContextGrant, type ContextScope, type ContextRecord } from '../../src/context.js'
import type { AgentOwnership } from '../../src/types.js'

interface Member { pubkey: string; name: string; agent: boolean; proof?: AgentOwnership }
interface Options {
  identity(): ContextIdentity | undefined
  room(): string | undefined
  server(): string
  members(): Member[]
}
const prefix = 'kithmoot.context.v1.'
const short = (key: string) => key.slice(0, 12) + '…'

/** A user-operated panel. Opening/searching never fetches remote context. */
export class ContextPanel {
  readonly #dialog: HTMLDialogElement
  #vault?: ContextVault
  #identity?: ContextIdentity
  #room?: string
  #view?: ContextView
  #baseline: string | null = null
  #generation = 0
  #ticket?: unknown
  #busy = false
  #members: Member[] = []
  constructor(readonly root: Document, readonly options: Options) {
    this.#dialog = this.#el('contextPanel') as HTMLDialogElement
    this.#el('contextClose').onclick = () => this.close()
    this.#dialog.addEventListener('close', () => this.#clear())
    this.#el('contextCreate').onsubmit = e => { e.preventDefault(); void this.#run(async v => {
      const scope = this.#value('contextScope') as ContextScope
      this.#view = await v.create({ title: this.#value('contextTitle').trim(), scope, ...(scope !== 'personal' ? { room: this.#room } : {}) })
      this.#input('contextTitle').value = ''
    }, true, 'Collection created on this device.') }
    this.#el('contextCollection').onchange = () => { this.#view = this.#vault?.read(this.#value('contextCollection')); this.#render() }
    this.#el('contextQuery').oninput = () => this.#renderRecords()
    this.#el('contextRecordForm').onsubmit = e => { e.preventDefault(); void this.#run(async v => {
      const view = this.#selected()
      this.#view = await v.append(view.id, view.head, { kind: this.#value('contextKind') as ContextRecord['kind'], text: this.#value('contextText').trim(), source: this.#value('contextSource').trim(), observedAt: Math.floor(Date.now() / 1000) })
      this.#input('contextText').value = ''
    }, true, 'Record saved locally. Upload and share the new revision when ready.') }
    this.#el('contextGrantForm').onsubmit = e => { e.preventDefault(); void this.#run(async v => {
      const view = this.#selected(), subject = this.#value('contextRecipient').trim()
      const known = this.#members.find(m => m.pubkey === subject)
      let proof = known?.proof
      if (this.#value('contextProof').trim()) { try { proof = JSON.parse(this.#value('contextProof')) } catch { throw new Error('Invalid ownership proof JSON.') } }
      if ((known?.agent || view.scope === 'personal') && !proof) throw new Error('This agent needs a current ownership proof from its principal.')
      const grant: ContextGrant = { subject, role: this.#value('contextRole') as 'read' | 'write', expiresAt: Math.floor(Date.now() / 1000) + Number(this.#value('contextDays')) * 86400, ...(proof ? { agent: proof } : {}) }
      this.#view = await v.setGrants(view.id, view.head, [...v.grants(view.id).filter(g => g.subject !== subject), grant])
    }, true, 'Grant saved and key rotated. Upload and send new access files to the remaining recipients.') }
    this.#el('contextShare').onclick = () => { void this.#run(async v => {
      const view = this.#selected(), recipient = this.#value('contextShareRecipient')
      await v.upload(view.id, this.options.server())
      this.#download(JSON.stringify(await v.access(view.id, recipient)), `context-access-${recipient.slice(0, 12)}.json`)
    }, true, 'Encrypted revision uploaded. Send the downloaded access file to its named recipient; only their identity can open it.') }
    this.#el('contextPreview').onclick = () => { void this.#run(async v => {
      const file = this.#file(); if (file.size > 100000) throw new Error('Access file is too large.')
      let ticket: unknown
      try { ticket = JSON.parse(await file.text()) } catch { throw new Error('Invalid access file JSON.') }
      const preview = await v.previewAccess(ticket)
      if (preview.scope !== 'personal' && preview.room !== this.#room) throw new Error('Open this collection in its own room.')
      this.#ticket = ticket
      this.#el('contextImportPreview').textContent = `${preview.title} · ${preview.scope} · owner ${preview.owner} · downloads from ${preview.server}`
      this.#el('contextImport').hidden = false
    }, false, 'Access verified locally. Review the collection and server before downloading.') }
    this.#el('contextFile').onchange = () => { this.#ticket = undefined; this.#el('contextImport').hidden = true; this.#el('contextImportPreview').textContent = '' }
    this.#el('contextImport').onclick = () => { void this.#run(async v => {
      if (!this.#ticket) throw new Error('Preview an access file first.')
      this.#view = await v.importAccess(this.#ticket)
      this.#ticket = undefined; this.#el('contextImport').hidden = true
    }, true, 'Encrypted context imported. Its signed records are available below.') }
    this.#el('contextBackup').onclick = () => { void this.#run(async v => { this.#download(await v.save(), 'kithmoot-context-backup.json') }, false, 'Encrypted backup downloaded. Keep it with access to this signing identity.') }
    this.#el('contextRestore').onclick = () => { void this.#run(async v => {
      const file = this.#file(); if (file.size > 90 * 1024 * 1024) throw new Error('Backup is too large.')
      await v.restore(await file.text())
    }, true, 'Encrypted backup restored for this identity.') }
  }
  #el(id: string): HTMLElement { return this.root.getElementById(id)! }
  #input(id: string): HTMLInputElement { return this.#el(id) as HTMLInputElement }
  #value(id: string): string { return this.#input(id).value }
  #file(): File { const file = this.#input('contextFile').files?.[0]; if (!file) throw new Error('Choose an access file or encrypted backup.'); return file }
  #selected(): ContextView { if (!this.#view) throw new Error('Choose a collection first.'); return this.#view }
  #status(message: string): void { this.#el('contextStatus').textContent = message }
  close(): void { this.#dialog.close(); this.#clear() }
  #clear(): void {
    this.#generation++; this.#vault = undefined; this.#identity = undefined; this.#view = undefined; this.#ticket = undefined; this.#members = []
    for (const el of this.#dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) el.value = ''
    for (const id of ['contextRecords', 'contextCollection', 'contextGrants', 'contextMembers', 'contextShareRecipient']) this.#el(id).replaceChildren()
    for (const id of ['contextStatus', 'contextSummary', 'contextImportPreview']) this.#el(id).textContent = ''
    this.#el('contextDetails').hidden = true; this.#el('contextImport').hidden = true
    this.#busy = false; (this.#el('contextFields') as HTMLFieldSetElement).disabled = false
  }
  async open(): Promise<void> {
    if (this.#dialog.open) return
    this.#clear(); this.#dialog.showModal()
    const generation = this.#generation
    try {
      const identity = this.options.identity()
      if (!identity) throw new Error('Context needs a signing identity with NIP-44 encryption. Connect a compatible signer on this device.')
      this.#identity = identity; this.#room = this.options.room(); this.#members = this.options.members()
      this.#baseline = localStorage.getItem(prefix + identity.pubkey)
      const vault = new ContextVault({ identity, servers: [this.options.server()] })
      if (this.#baseline) await vault.restore(this.#baseline)
      if (generation !== this.#generation) return
      this.#vault = vault
      this.#el('contextStorage').textContent = `Encrypted uploads and downloads use ${this.options.server()}. Change it in the room’s file storage settings.`
      for (const m of this.#members) { const option = this.root.createElement('option'); option.value = m.pubkey; option.label = `${m.name}${m.agent ? ' (agent)' : ''}`; this.#el('contextMembers').append(option) }
      this.#render(); this.#input('contextTitle').focus()
      this.#status('Cached context on this device. Opening this panel does not fetch or share anything.')
    } catch (err) { this.#status(err instanceof Error ? err.message : 'Could not open context.') }
  }
  async #run(action: (vault: ContextVault) => Promise<void>, write: boolean, success: string): Promise<void> {
    if (this.#busy) return
    const vault = this.#vault, identity = this.#identity, generation = this.#generation
    if (!vault || !identity) { this.#status('Close and reopen context with a compatible signing identity.'); return }
    this.#busy = true; (this.#el('contextFields') as HTMLFieldSetElement).disabled = true
    this.#status('Working…')
    const storageKey = prefix + identity.pubkey
    try {
      if (localStorage.getItem(storageKey) !== this.#baseline) throw new Error('Context changed in another tab. Close and reopen this panel before continuing.')
      await action(vault)
      if (generation !== this.#generation) return
      if (write) {
        const encrypted = await vault.save()
        if (generation !== this.#generation) return
        if (localStorage.getItem(storageKey) !== this.#baseline) throw new Error('Context changed in another tab; this change was not saved. Close and reopen the panel.')
        localStorage.setItem(storageKey, encrypted); this.#baseline = encrypted
      }
      this.#render(); this.#status(success)
    } catch (err) {
      if (generation === this.#generation) {
        // A failed save must not leave a seemingly committed in-memory change.
        if (write) { this.#vault = undefined; this.#el('contextDetails').hidden = true }
        this.#status((err instanceof Error ? err.message : 'Context operation failed.') + (write ? ' Close and reopen context before continuing.' : ''))
      }
    } finally { if (generation === this.#generation) { this.#busy = false; (this.#el('contextFields') as HTMLFieldSetElement).disabled = false } }
  }
  #render(): void {
    const vault = this.#vault; if (!vault) return
    const collections = vault.list().filter(c => c.scope === 'personal' || c.room === this.#room)
    this.#el('contextCollection').replaceChildren()
    for (const c of collections) { const option = this.root.createElement('option'); option.value = c.id; option.textContent = `${c.title} · ${c.scope}`; this.#el('contextCollection').append(option) }
    const selected = collections.find(c => c.id === this.#view?.id) ?? collections[0]
    this.#view = selected && vault.read(selected.id)
    this.#el('contextDetails').hidden = !this.#view
    this.#el('contextEmpty').hidden = collections.length > 0
    if (!this.#view) return
    const view = this.#view
    this.#input('contextCollection').value = view.id
    this.#el('contextSummary').textContent = `${view.scope} · ${view.role === 'write' ? 'can write' : 'read only'} · revision ${view.revision} · ${view.uploaded ? 'uploaded' : 'saved on this device'} · updated ${new Date(view.updatedAt * 1000).toLocaleString()} · owner ${short(view.owner)}`
    this.#el('contextRecordForm').hidden = view.role !== 'write'
    this.#el('contextGrantForm').hidden = view.owner !== this.#identity?.pubkey
    this.#el('contextShareArea').hidden = view.role !== 'write'
    this.#el('contextShareRecipient').replaceChildren()
    this.#el('contextGrants').replaceChildren()
    const grants = vault.grants(view.id)
    for (const subject of [view.owner, ...grants.filter(g => g.expiresAt > Date.now() / 1000).map(g => g.subject)]) {
      const option = this.root.createElement('option'); option.value = subject; option.textContent = `${this.#members.find(m => m.pubkey === subject)?.name ?? short(subject)} · ${subject}`; this.#el('contextShareRecipient').append(option)
    }
    for (const g of grants) {
      const row = this.root.createElement('li'); row.textContent = `${this.#members.find(m => m.pubkey === g.subject)?.name ?? short(g.subject)} · ${g.role} · until ${new Date(g.expiresAt * 1000).toLocaleString()} `
      if (view.owner === this.#identity?.pubkey) {
        const button = this.root.createElement('button'); button.type = 'button'; button.textContent = 'Remove access for future updates'
        button.onclick = () => { void this.#run(async v => { this.#view = await v.setGrants(view.id, view.head, v.grants(view.id).filter(other => other.subject !== g.subject)) }, true, 'Access removed and key rotated. Upload the new revision and send new access files to remaining recipients.') }; row.append(button)
      }
      this.#el('contextGrants').append(row)
    }
    this.#renderRecords()
  }
  #renderRecords(): void {
    this.#el('contextRecords').replaceChildren()
    if (!this.#view || !this.#vault) return
    try {
      for (const r of this.#vault.read(this.#view.id, this.#value('contextQuery')).records) {
        const item = this.root.createElement('li'), body = this.root.createElement('p'), source = this.root.createElement('p')
        body.textContent = `${r.kind}: ${r.text}`
        source.className = 'note'; source.textContent = `${r.source} · ${short(r.author)} · observed ${new Date(r.observedAt * 1000).toLocaleString()}`
        item.append(body, source); this.#el('contextRecords').append(item)
      }
    } catch (err) { this.#status(err instanceof Error ? err.message : 'Context is no longer available.') }
  }
  #download(value: string, name: string): void {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }))
    const link = this.root.createElement('a'); link.href = url; link.download = name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
