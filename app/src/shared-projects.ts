import { decode, npubEncode } from 'nostr-tools/nip19'
import { ProjectDirectory, type SharedProject } from '../../src/project-directory.js'
import type { ProjectDefinition, ProjectIdentity, ProjectMember, ProjectRoom } from '../../src/projects.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { parseRoomLink } from '../../src/link.js'
import { sanitiseDisplayName } from '../../src/display-name.js'
import type { KnownRoom } from './rooms-store.js'
import type { DeviceStore } from './device-store.js'

type Person = { pubkey: string; label: string; agent: boolean }
const shortPerson = (pubkey: string) => { const npub = npubEncode(pubkey); return npub.slice(0, 14) + '…' + npub.slice(-6) }

/** Shared project management. The ordinary navigation renders the same signed
 * project IDs; this panel owns only editing and deliberate invitation joins. */
export class SharedProjectsPanel {
  #directory?: ProjectDirectory
  #off?: () => void
  #release?: () => void
  #generation = 0
  #identity?: ProjectIdentity
  #transport?: RelayTransport
  #status = 'Sign in with your Nostr account to share projects across people and devices.'
  #editing?: SharedProject
  #selectedMembers = new Map<string, ProjectMember>()
  #selectedRooms = new Map<string, ProjectRoom>()
  #return?: HTMLElement
  #busy = false
  #request?: string
  #projects: SharedProject[] = []
  #joined: SharedProject[] = []
  #roomProjects = new Map<string, SharedProject[]>()
  readonly dialog: HTMLDialogElement
  readonly editor: HTMLDialogElement
  constructor(readonly root: Document, readonly options: {
    store: DeviceStore
    rooms: () => KnownRoom[]
    people: () => Person[]
    changed: () => void
    openRoom: (room: KnownRoom) => void
    signIn: () => void
  }) {
    this.dialog = this.el('sharedProjects') as HTMLDialogElement
    this.editor = this.el('sharedProjectEditor') as HTMLDialogElement
    for (const id of ['homeSharedProjects', 'workspaceSharedProjects', 'switcherSharedProjects']) this.el(id).addEventListener('click', () => this.open(this.el(id)))
    this.el('sharedProjectsClose').addEventListener('click', () => this.dialog.close())
    this.el('sharedProjectsSignIn').addEventListener('click', () => { this.dialog.close(); this.options.signIn() })
    this.el('sharedProjectsRetry').addEventListener('click', () => {
      if (this.#directory && !this.#directory.snapshot().error) void this.#directory.retry()
      else if (this.#identity && this.#transport) void this.attach(this.#identity, this.#transport)
    })
    this.el('sharedProjectNew').addEventListener('click', () => this.edit())
    this.el('sharedProjectCancel').addEventListener('click', () => this.editor.close())
    this.el('sharedProjectForm').addEventListener('submit', event => { event.preventDefault(); void this.save() })
    this.el('sharedProjectAddPerson').addEventListener('click', () => this.addPerson())
    for (const id of ['sharedProjectName', 'sharedProjectArchived']) this.el(id).addEventListener('input', () => { this.#request = undefined })
    this.editor.addEventListener('cancel', event => { if (this.#busy) event.preventDefault() })
    this.editor.addEventListener('close', () => { if (this.dialog.open) this.el('sharedProjectNew').focus() })
    this.dialog.addEventListener('close', () => this.#return?.isConnected && this.#return.focus({ preventScroll: true }))
    this.render()
  }
  el(id: string): HTMLElement { const el = this.root.getElementById(id); if (!el) throw new Error(`Missing project element ${id}`); return el }
  projects(): readonly SharedProject[] { return this.#projects }
  joined(): readonly SharedProject[] { return this.#joined }
  sharedRooms(): KnownRoom[] {
    const rooms = new Map<string, KnownRoom>()
    for (const p of this.joined()) for (const r of p.definition!.rooms) if (!rooms.has(r.room)) rooms.set(r.room, { roomId: r.room, name: r.name, link: r.link, openedAt: 0, readAt: 0 })
    return [...rooms.values()]
  }
  forRoom(room: string): readonly SharedProject[] { return this.#roomProjects.get(room) ?? [] }
  async attach(identity: ProjectIdentity, transport: RelayTransport): Promise<void> {
    const detached = this.detach(), generation = this.#generation
    await detached
    if (generation !== this.#generation) return
    this.#identity = identity; this.#transport = transport
    this.#status = 'Loading your encrypted projects…'; this.render()
    let release: (() => void) | undefined
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely lock shared project storage.')
      const key = `kithmoot.shared-projects.v1.${identity.pubkey}`
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request(key, { ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error('Shared projects are open in another tab. Use that tab or close it, then retry.')); return }
          await new Promise<void>(done => { release = done; resolve() })
        }).catch(reject)
      })
      if (generation !== this.#generation) { release?.(); return }
      this.#release = release
      const directory = new ProjectDirectory({ identity, transport, storage: {
        load: async () => this.options.store.get(key) ?? undefined,
        save: async value => { this.options.store.set(key, value) },
      } })
      this.#directory = directory
      this.#off = directory.onChange(() => { this.render(); this.options.changed() })
      await directory.open()
      if (generation !== this.#generation) { await directory.close(); release?.(); return }
      this.render(); this.options.changed()
    } catch (e) {
      release?.()
      if (generation !== this.#generation) return
      await this.#directory?.close(); this.#directory = undefined; this.#off?.(); this.#off = undefined; this.#release = undefined
      this.#status = e instanceof Error ? e.message : 'Projects could not connect.'; this.render()
    }
  }
  async detach(): Promise<void> {
    ++this.#generation
    this.#off?.(); this.#off = undefined
    const directory = this.#directory, release = this.#release
    this.#directory = undefined; this.#release = undefined; this.#identity = undefined; this.#transport = undefined
    this.#editing = undefined; this.#selectedMembers.clear(); this.#selectedRooms.clear(); this.#request = undefined; this.#busy = false
    this.#status = 'Sign in with your Nostr account to share projects across people and devices.'
    ;(this.el('sharedProjectSave') as HTMLButtonElement).disabled = false
    ;(this.el('sharedProjectCancel') as HTMLButtonElement).disabled = false
    this.editor.close(); this.dialog.close(); this.render()
    await directory?.close(); release?.()
  }
  async unavailable(message: string): Promise<void> {
    const detached = this.detach(), generation = this.#generation
    await detached
    if (generation !== this.#generation) return
    this.#status = message; this.render()
  }
  open(from?: HTMLElement, room?: KnownRoom): void {
    this.#return = from
    this.render()
    if (!this.dialog.open) this.dialog.showModal()
    if (room && this.#directory?.snapshot().ready) {
      const current = this.forRoom(room.roomId).find(p => p.owner === this.#identity?.pubkey)
      this.edit(current, room)
    }
  }
  #button(text: string, action: () => void, primary = false, key = text): HTMLButtonElement {
    const b = this.root.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.action = key; b.className = primary ? 'primary' : 'quiet'; b.addEventListener('click', action); return b
  }
  render(): void {
    const state = this.#directory?.snapshot()
    // Navigation asks about the same room repeatedly while building filters,
    // labels and groups. Project the signed directory once per update, rather
    // than revalidating and hashing every project's invitations for each row.
    this.#projects = state?.projects ?? []
    this.#joined = this.#projects.filter(p => p.joined && p.definition && !p.definition.archived)
    this.#roomProjects = new Map()
    for (const project of this.#joined) for (const room of project.definition!.rooms) {
      const projects = this.#roomProjects.get(room.room) ?? []
      projects.push(project); this.#roomProjects.set(room.room, projects)
    }
    const invitations = state?.projects.filter(p => !p.joined && !p.withdrawn && !p.conflicted && !p.definition?.archived).length ?? 0
    for (const id of ['homeSharedProjects', 'workspaceSharedProjects', 'switcherSharedProjects']) this.el(id).textContent = invitations ? `Projects · ${invitations} invitation${invitations === 1 ? '' : 's'}` : 'Projects'
    this.el('sharedProjectsSignIn').hidden = !!this.#identity
    this.el('sharedProjectsRetry').hidden = !this.#identity || !!state?.ready && !state.pendingSends
    ;(this.el('sharedProjectNew') as HTMLButtonElement).disabled = !state?.ready
    this.el('sharedProjectsStatus').textContent = state?.error ?? (!state ? this.#status : !state.ready ? 'Loading your projects…' : state.pendingSends ? `${state.pendingSends} encrypted ${state.pendingSends === 1 ? 'delivery' : 'deliveries'} awaiting relay confirmation. Retry when connected.` : 'Shared with the people and agents listed below.')
    const list = this.el('sharedProjectsList'), focused = this.root.activeElement as HTMLElement | null
    const focusedProject = focused && list.contains(focused) ? focused.closest<HTMLElement>('[data-project]')?.dataset.project : undefined
    const focusedAction = focused?.dataset.action
    list.replaceChildren()
    const visible = state?.projects.filter(p => !p.withdrawn) ?? []
    this.el('sharedProjectsEmpty').hidden = visible.length !== 0 || !state?.ready
    for (const project of visible) {
      const card = this.root.createElement('article'); card.className = 'sharedProjectCard'; card.dataset.project = project.key
      const title = this.root.createElement('h3'); title.textContent = project.definition?.name ?? 'Project has conflicting edits'; card.append(title)
      const owner = this.root.createElement('p'); owner.className = 'note'; owner.textContent = project.owner === this.#identity?.pubkey ? 'Your project' : `Shared by ${shortPerson(project.owner)}`; owner.title = npubEncode(project.owner); card.append(owner)
      if (project.conflicted) {
        const error = this.root.createElement('p'); error.textContent = 'Different changes were signed at the same revision. The owner must reconcile them before this project can be used.'; card.append(error)
        // The owner supplies a complete reviewed replacement. No arbitrary
        // branch is presented as the canonical project.
        if (project.owner === this.#identity?.pubkey) card.append(this.#button('Resolve project', () => this.edit(project)))
      } else if (project.definition) {
        const d = project.definition, summary = this.root.createElement('p')
        const people = d.members.filter(m => m.kind === 'person').length, agents = d.members.filter(m => m.kind === 'agent').length
        summary.textContent = `${people} ${people === 1 ? 'person' : 'people'} · ${agents} ${agents === 1 ? 'agent' : 'agents'} · ${d.rooms.length} ${d.rooms.length === 1 ? 'room' : 'rooms'}${d.archived ? ' · Archived' : ''}`; card.append(summary)
        if (!project.joined && !d.archived) card.append(this.#button('Review and join', () => this.review(project), true))
        else if (!d.archived) {
          const rooms = this.root.createElement('div'); rooms.className = 'sharedProjectRooms'
          for (const room of d.rooms) rooms.append(this.#button(room.name, () => { this.dialog.close(); this.options.openRoom({ roomId: room.room, name: room.name, link: room.link, openedAt: 0, readAt: 0 }) }, false, `room:${room.room}`))
          card.append(rooms)
        }
        if (project.owner === this.#identity?.pubkey) card.append(this.#button('Edit project', () => this.edit(project)))
        else if (project.joined) card.append(this.#button('Hide from my projects', () => { void this.#follow(project, false) }))
      }
      list.append(card)
    }
    if (focusedProject && focusedAction && this.dialog.open && !this.editor.open) {
      const card = Array.from(list.children).find(el => (el as HTMLElement).dataset.project === focusedProject)
      const next = Array.from(card?.querySelectorAll<HTMLElement>('[data-action]') ?? []).find(el => el.dataset.action === focusedAction)
      ;(next ?? this.el('sharedProjectsClose')).focus({ preventScroll: true })
    }
  }
  review(project: SharedProject): void {
    this.#editing = project; this.#request = undefined; this.#selectedMembers = new Map(project.definition!.members.map(m => [m.pubkey, m])); this.#selectedRooms = new Map(project.definition!.rooms.map(r => [r.room, r]))
    this.el('sharedProjectEditorTitle').textContent = `Join ${project.definition!.name}`
    this.el('sharedProjectReview').hidden = false
    this.el('sharedProjectReview').textContent = `These people and agents receive the project directory and selected room invitations. Joining does not start agents or share your other projects. Owner: ${npubEncode(project.owner)}`
    this.el('sharedProjectFields').hidden = true
    this.el('sharedProjectError').hidden = true
    ;(this.el('sharedProjectSave') as HTMLButtonElement).textContent = 'Join project'
    this.renderSelections(true)
    if (!this.editor.open) this.editor.showModal()
  }
  edit(project?: SharedProject, room?: KnownRoom): void {
    if (!this.#identity || !this.#directory?.snapshot().ready) return
    this.#editing = project; this.#request = undefined
    const initial = project?.definition
    this.#selectedMembers = new Map((initial?.members ?? [{ pubkey: this.#identity.pubkey, kind: 'person' as const, epoch: 1 }]).map(m => [m.pubkey, structuredClone(m)]))
    this.#selectedRooms = new Map((initial?.rooms ?? []).map(r => [r.room, structuredClone(r)]))
    if (room && this.persistent(room)) this.#selectedRooms.set(room.roomId, { room: room.roomId, name: sanitiseDisplayName(room.name) ?? 'Project room', link: room.link })
    this.el('sharedProjectEditorTitle').textContent = project?.conflicted ? 'Resolve shared project' : project ? 'Edit shared project' : 'Create a shared project'
    this.el('sharedProjectFields').hidden = false; this.el('sharedProjectReview').hidden = true
    ;(this.el('sharedProjectName') as HTMLInputElement).value = initial?.name ?? ''
    ;(this.el('sharedProjectArchived') as HTMLInputElement).checked = initial?.archived ?? false
    ;(this.el('sharedProjectNpub') as HTMLInputElement).value = ''
    this.el('sharedProjectError').hidden = true
    ;(this.el('sharedProjectSave') as HTMLButtonElement).textContent = project ? 'Save shared project' : 'Create and share project'
    this.renderSelections(false)
    if (!this.editor.open) this.editor.showModal()
    this.el('sharedProjectName').focus()
  }
  persistent(room: KnownRoom): boolean { try { const link = parseRoomLink(room.link); return !!link.invitation?.persistent && !link.pairingCode } catch { return false } }
  renderSelections(review: boolean): void {
    const people = new Map(this.options.people().map(p => [p.pubkey, p]))
    for (const member of this.#selectedMembers.values()) if (!people.has(member.pubkey)) people.set(member.pubkey, { pubkey: member.pubkey, label: member.name ?? shortPerson(member.pubkey), agent: member.kind === 'agent' })
    const list = this.el('sharedProjectPeople'); list.replaceChildren()
    for (const person of people.values()) {
      if (review && !this.#selectedMembers.has(person.pubkey)) continue
      const row = this.root.createElement('label'); row.className = 'projectChoice'
      const input = this.root.createElement('input'); input.type = 'checkbox'; input.checked = this.#selectedMembers.has(person.pubkey); input.disabled = review || person.pubkey === this.#identity?.pubkey
      input.addEventListener('change', () => {
        if (input.checked) this.#selectedMembers.set(person.pubkey, { pubkey: person.pubkey, kind: person.agent ? 'agent' : 'person', epoch: 1, ...(sanitiseDisplayName(person.label) ? { name: sanitiseDisplayName(person.label)! } : {}) })
        else this.#selectedMembers.delete(person.pubkey)
        this.#request = undefined
      })
      const name = this.root.createElement('span'); name.textContent = `${person.pubkey === this.#identity?.pubkey ? 'You' : person.label}${person.agent ? ' · Agent' : ''}`; name.title = npubEncode(person.pubkey)
      row.append(input, name); list.append(row)
    }
    const rooms = new Map(this.options.rooms().filter(r => this.persistent(r)).map(r => [r.roomId, { room: r.roomId, name: sanitiseDisplayName(r.name) ?? 'Project room', link: r.link }]))
    for (const r of this.#selectedRooms.values()) rooms.set(r.room, r)
    const choices = this.el('sharedProjectRooms'); choices.replaceChildren()
    for (const room of rooms.values()) {
      if (review && !this.#selectedRooms.has(room.room)) continue
      const row = this.root.createElement('label'); row.className = 'projectChoice'
      const input = this.root.createElement('input'); input.type = 'checkbox'; input.checked = this.#selectedRooms.has(room.room); input.disabled = review
      input.addEventListener('change', () => { if (input.checked) this.#selectedRooms.set(room.room, room); else this.#selectedRooms.delete(room.room); this.#request = undefined })
      const label = this.root.createElement('span'); label.textContent = room.name; row.append(input, label); choices.append(row)
    }
    this.el('sharedProjectNoRooms').hidden = choices.childElementCount !== 0
    this.el('sharedProjectAddContact').hidden = review
    this.el('sharedProjectRemovalNote').hidden = review || !this.#editing
  }
  addPerson(): void {
    try {
      const input = this.el('sharedProjectNpub') as HTMLInputElement
      if (/^(nostr:)?(?:nsec|ncryptsec)1/.test(input.value.trim())) { input.value = ''; throw new Error('A public key is required') }
      const parsed = decode(input.value.trim().replace(/^nostr:/, ''))
      if (parsed.type !== 'npub') throw new Error('Enter a Nostr public key beginning npub.')
      const pubkey = parsed.data
      this.#selectedMembers.set(pubkey, { pubkey, kind: (this.el('sharedProjectContactKind') as HTMLSelectElement).value === 'agent' ? 'agent' : 'person', epoch: 1 })
      this.#request = undefined; input.value = ''; this.el('sharedProjectError').hidden = true; this.renderSelections(false)
    } catch { this.error('Enter a Nostr public key beginning npub. Private keys are never needed here.') }
  }
  error(message: string): void { this.el('sharedProjectError').textContent = message; this.el('sharedProjectError').hidden = false }
  async #follow(project: SharedProject, joined: boolean): Promise<void> {
    try { await this.#directory?.follow(project, joined, project.heads, crypto.randomUUID()) } catch (e) { this.#status = e instanceof Error ? e.message : 'Project choice could not be saved'; this.el('sharedProjectsStatus').textContent = this.#status }
  }
  async save(): Promise<void> {
    if (this.#busy || !this.#directory || !this.#identity) return
    const generation = this.#generation, directory = this.#directory, editing = this.#editing
    this.#busy = true
    ;(this.el('sharedProjectSave') as HTMLButtonElement).disabled = true
    ;(this.el('sharedProjectCancel') as HTMLButtonElement).disabled = true
    this.el('sharedProjectError').hidden = true
    try {
      const request = this.#request ??= crypto.randomUUID()
      if (!this.el('sharedProjectReview').hidden && editing) await directory.follow(editing, true, editing.heads, request)
      else {
        const name = sanitiseDisplayName((this.el('sharedProjectName') as HTMLInputElement).value)
        if (!name) throw new Error('Give this project a name.')
        const definition: ProjectDefinition = { name, members: [...this.#selectedMembers.values()], rooms: [...this.#selectedRooms.values()], archived: (this.el('sharedProjectArchived') as HTMLInputElement).checked, authorityRevision: 1 }
        if (editing) await directory.update(editing, editing.heads, definition, request)
        else await directory.create(definition, request)
      }
      if (generation === this.#generation) { this.editor.close(); this.render(); this.options.changed() }
    } catch (e) { if (generation === this.#generation) this.error(e instanceof Error ? e.message : 'Project could not be saved.') }
    finally {
      if (generation === this.#generation) {
        this.#busy = false
        ;(this.el('sharedProjectSave') as HTMLButtonElement).disabled = false
        ;(this.el('sharedProjectCancel') as HTMLButtonElement).disabled = false
      }
    }
  }
}
