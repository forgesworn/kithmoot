import { BrowserMlsMembershipController, removalComponentCopy, type MlsMembershipView, type MlsRemovalPlan } from './mls-membership-controller.js'
import type { MlsMemberStatus, MlsRemovalStatus } from './mls-room-operations.js'
import type { VmlsRevocationIdentity, VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'

export interface MlsMembershipLabels {
  person(identity: string): string
  device(member: MlsMemberStatus): string
}
export interface MlsMembershipRevocationSender {
  identity(): VmlsRevocationIdentity | undefined
  transport: VmlsRevocationTransport
}
const short = (value: string) => `${value.slice(0, 12)}…`

/** A self-contained membership surface for the production-disabled MLS room
 * composition. It renders only verified engine members and the engine's exact
 * permitted claim; profile and presence data may supply labels, never power. */
export class BrowserMlsMembershipPanel {
  #busy = false
  #plan?: MlsRemovalPlan
  #reviewGeneration = 0
  readonly dialog: HTMLDialogElement
  constructor(private controller: BrowserMlsMembershipController, readonly root: HTMLElement,
    private labels: MlsMembershipLabels = { person: short, device: member => short(member.device) },
    private revocation?: MlsMembershipRevocationSender) {
    this.dialog = root.ownerDocument.createElement('dialog')
    this.dialog.className = 'mlsMembershipConfirm'
    this.dialog.innerHTML = `<form method="dialog">
      <h3>Review membership change</h3>
      <p data-mls-plan></p>
      <ul data-mls-impact></ul>
      <p class="note">Removing a leaf changes future MLS epochs. It does not erase messages already delivered. A box grant is separate and may serve this device across several MLS rooms.</p>
      <label><input type="checkbox" data-mls-compromised> Treat this device as compromised and hold new sends and Adds until the Remove is witnessed.</label>
      <p data-mls-error role="status" aria-live="polite"></p>
      <button value="cancel">Cancel</button>
      <button value="default" data-mls-confirm type="button">Record and start removal</button>
    </form>`
    root.append(this.dialog)
    this.dialog.querySelector<HTMLInputElement>('[data-mls-compromised]')!.onchange = event => {
      const plan = this.#plan
      if (plan) void this.#loadPlan(plan.kind, plan.target, (event.currentTarget as HTMLInputElement).checked, false)
    }
    this.dialog.querySelector<HTMLButtonElement>('[data-mls-confirm]')!.onclick = () => { void this.#confirm() }
    this.dialog.addEventListener('close', () => { this.#reviewGeneration++; this.#plan = undefined; this.dialog.querySelector<HTMLButtonElement>('[data-mls-confirm]')!.disabled = true })
  }
  async open(): Promise<void> {
    this.root.setAttribute('aria-busy', 'true')
    try { this.#render(await this.controller.view()) }
    catch (error) { this.root.replaceChildren(this.dialog, this.#message((error as Error).message, 'alert')) }
    finally { this.root.removeAttribute('aria-busy') }
  }
  #message(text: string, role?: string): HTMLElement {
    const p = this.root.ownerDocument.createElement('p'); p.textContent = text
    if (role) p.setAttribute('role', role)
    return p
  }
  #render(view: MlsMembershipView): void {
    const doc = this.root.ownerDocument, roster = doc.createElement('section'), journal = doc.createElement('section')
    roster.className = 'mlsMembershipRoster'; roster.innerHTML = '<h3>Current MLS members</h3>'
    const people = new Map<string, MlsMemberStatus[]>()
    for (const member of view.members) people.set(member.identity, [...(people.get(member.identity) ?? []), member])
    for (const [identity, members] of people) {
      const article = doc.createElement('article'), heading = doc.createElement('h4'), list = doc.createElement('ul')
      heading.textContent = this.labels.person(identity); article.append(heading, list)
      for (const member of members) {
        const item = doc.createElement('li'), label = doc.createElement('span')
        label.textContent = `${this.labels.device(member)}${member.own ? ' · this device' : ''}${member.pending ? ' · awaiting first Update' : ''}`
        item.append(label)
        if (!member.own) {
          const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove device'
          remove.dataset.mlsRemoveDevice = member.leafId; remove.onclick = () => { void this.#review('device', member.leafId) }
          item.append(' ', remove)
        }
        list.append(item)
      }
      if (!members.some(member => member.own)) {
        const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove person'
        remove.dataset.mlsRemovePerson = identity; remove.onclick = () => { void this.#review('person', identity) }; article.append(remove)
      }
      roster.append(article)
    }
    journal.className = 'mlsMembershipJournal'; journal.innerHTML = '<h3>Membership changes</h3>'
    if (!view.removals.length) journal.append(this.#message('No membership changes are recorded for this room.'))
    for (const removal of view.removals) journal.append(this.#removal(removal))
    this.root.replaceChildren(roster, journal, this.dialog)
  }
  #removal(removal: MlsRemovalStatus): HTMLElement {
    const doc = this.root.ownerDocument, article = doc.createElement('article'), heading = doc.createElement('h4'), list = doc.createElement('ul')
    const copy = removalComponentCopy(removal)
    heading.textContent = removal.kind === 'person' ? `Person ${short(removal.target)}` : `Device leaf ${short(removal.target)}`
    for (const line of [copy.mls, copy.credential, ...copy.grants, copy.hold].filter((line): line is string => !!line)) {
      const item = doc.createElement('li'); item.textContent = line; list.append(item)
    }
    const claim = doc.createElement('p'); claim.className = 'mlsMembershipClaim'; claim.textContent = copy.claim
    article.append(heading, list, claim)
    const requestGrants = removal.grants.filter(grant => !grant.grant.keeper)
    const requestReady = removal.request && removal.mls === 'Committed' && requestGrants.length > 0 && requestGrants.every(grant =>
      grant.state.type === 'NotAuthorised' && !(grant.state as { type: 'NotAuthorised'; requested: boolean }).requested)
    if (requestReady && this.revocation) {
      const note = this.#message('Send a private request to the keeper’s public DM relays. Relays can see the recipient, your connection address, timing and volume. A sent request is not proof that the keeper read it or revoked the grant.')
      note.className = 'note'
      const status = this.#message('', 'status'); status.setAttribute('aria-live', 'polite')
      const request = doc.createElement('button'); request.type = 'button'; request.textContent = 'Send request to keeper'
      request.dataset.mlsRequestRevocation = removal.operation
      request.onclick = () => { void this.#requestRevocation(removal.operation, request, status) }
      article.append(note, status, request)
    }
    if (removal.mls !== 'Committed' || removal.grants.some(grant => grant.state.type === 'Pending' || grant.state.type === 'Failed')) {
      const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Continue removal'; retry.dataset.mlsContinue = removal.operation
      retry.onclick = () => { void this.#advance(removal.operation) }; article.append(retry)
    }
    return article
  }
  async #review(kind: 'device' | 'person', target: string): Promise<void> {
    if (this.#busy) return
    await this.#loadPlan(kind, target, false, true)
  }
  async #loadPlan(kind: 'device' | 'person', target: string, compromised: boolean, open: boolean): Promise<void> {
    const review = ++this.#reviewGeneration, button = this.dialog.querySelector<HTMLButtonElement>('[data-mls-confirm]')!
    this.#plan = undefined; button.disabled = true
    const error = this.dialog.querySelector<HTMLElement>('[data-mls-error]')!; error.textContent = ''
    try {
      const plan = await this.controller.plan(kind, target, compromised)
      if (review !== this.#reviewGeneration) return
      this.#plan = plan
      this.dialog.querySelector<HTMLElement>('[data-mls-plan]')!.textContent = kind === 'person'
        ? `Remove ${this.labels.person(target)} and all ${plan.members.length} of their current devices?`
        : `Remove ${this.labels.device(plan.members[0])}?`
      const impact = this.dialog.querySelector<HTMLUListElement>('[data-mls-impact]')!
      const lines = [`${plan.members.length} MLS leaf${plan.members.length === 1 ? '' : 's'} will be removed from future epochs.`]
      for (const grant of plan.grants) {
        const names = grant.rooms.map(room => `${room.name} (${short(room.session)})`).join(', ')
        lines.push(grant.action === 'request' ? `This account cannot revoke the grant at box ${short(grant.node)}. It can ask the room's keeper after the removal is recorded; a sent request is not proof of revocation.`
          : grant.action === 'revoke' ? `Node-wide grant at box ${short(grant.node)} will be revoked immediately. Saved affected rooms: ${names}.`
          : grant.action === 'grace' ? `Node-wide grant at box ${short(grant.node)} will remain live for 24 hours so this device can fetch its Remove, then be revoked. Saved affected room: ${names}.`
            : `Node-wide grant at box ${short(grant.node)} will stay live because another saved room still uses it. Saved rooms: ${names}.`)
      }
      if (!plan.grants.length) lines.push('No keeper-issued box grant is recorded here; box access cannot be claimed ended.')
      lines.push('The person credential remains unchanged unless a separate tombstone is observed.')
      impact.replaceChildren(...lines.map(text => { const li = this.root.ownerDocument.createElement('li'); li.textContent = text; return li }))
      const compromisedInput = this.dialog.querySelector<HTMLInputElement>('[data-mls-compromised]')!
      compromisedInput.checked = plan.compromised; compromisedInput.disabled = kind === 'person'
      button.disabled = false
      if (open && !this.dialog.open) this.dialog.showModal()
    } catch (caught) {
      if (review !== this.#reviewGeneration) return
      this.#plan = undefined; button.disabled = true; error.textContent = (caught as Error).message
      if (open && !this.dialog.open) this.dialog.showModal()
    }
  }
  async #confirm(): Promise<void> {
    if (this.#busy || !this.#plan) return
    this.#busy = true
    const error = this.dialog.querySelector<HTMLElement>('[data-mls-error]')!, button = this.dialog.querySelector<HTMLButtonElement>('[data-mls-confirm]')!
    button.disabled = true; error.textContent = 'Recording the exact removal intent before network changes…'
    try {
      const opened = await this.controller.begin(this.#plan)
      this.dialog.close(); await this.controller.advance(opened.operation); await this.open()
    } catch (caught) { error.textContent = (caught as Error).message; await this.open().catch(() => undefined) }
    finally { this.#busy = false; button.disabled = false }
  }
  async #advance(operation: string): Promise<void> {
    if (this.#busy) return
    this.#busy = true; this.root.setAttribute('aria-busy', 'true')
    try { await this.controller.advance(operation) }
    catch (error) { const message = this.#message((error as Error).message, 'alert'); this.root.prepend(message) }
    finally { this.#busy = false; this.root.removeAttribute('aria-busy'); await this.open() }
  }
  async #requestRevocation(operation: string, button: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (this.#busy || !this.revocation) return
    this.#busy = true; this.root.setAttribute('aria-busy', 'true'); button.disabled = true
    status.setAttribute('role', 'status'); status.textContent = 'Preparing the private request for the keeper…'
    try {
      const identity = this.revocation.identity()
      if (!identity) throw new Error('Sign in as the requesting member.')
      await this.controller.requestRevocation(operation, { identity, transport: this.revocation.transport })
      await this.open()
    } catch (error) {
      status.setAttribute('role', 'alert'); status.textContent = (error as Error).message; button.disabled = false
    } finally { this.#busy = false; this.root.removeAttribute('aria-busy') }
  }
}
