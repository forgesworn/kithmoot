import { BrowserMlsGrantDevelopmentOwner, type MlsGrantDevelopmentContext, type MlsDevelopmentRoom } from './mls-grant-development-owner.js'
import type { MlsRemovalPlan } from './mls-membership-controller.js'
import { removalComponentCopy } from './mls-membership-controller.js'
import type { MlsKeeperDecisionPlan } from './mls-keeper-decisions.js'
import { confirmAction } from './confirm-action.js'
import type { MlsRemovalStatus } from './mls-room-operations.js'
import type { MlsRevocationInboxView } from './mls-revocation-inbox.js'
import type { MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import { addReveal } from './reveal.js'

const short = (value: string) => `${value.slice(0, 12)}…`
const removalText = (status: MlsRemovalStatus) => {
  const copy = removalComponentCopy(status)
  return [copy.mls, copy.credential, ...copy.grants, copy.hold, copy.claim].filter(Boolean).join(' ')
}
/** Development controls owned by one concrete foreground composition. Merely
 * opening does no preparation, storage, signer or network work. Each button
 * starts an explicit named workflow. Cached display/review data is discarded
 * synchronously on shutdown and never substitutes for witnessed authority. */
export class BrowserMlsGrantDevelopmentPanel {
  readonly dialog: HTMLDialogElement
  readonly #owner: BrowserMlsGrantDevelopmentOwner
  #epoch = 0
  #busy = false
  #rooms: (MlsDevelopmentRoom & { name: string })[] = []
  #memberPlan?: MlsRemovalPlan
  #keeperPlan?: MlsKeeperDecisionPlan
  constructor(private readonly context: () => MlsGrantDevelopmentContext | undefined, private readonly root: Document = document) {
    this.#owner = new BrowserMlsGrantDevelopmentOwner(context)
    this.dialog = root.createElement('dialog')
    this.dialog.id = 'mlsGrantDevelopment'; this.dialog.className = 'profileSettings'
    this.dialog.setAttribute('aria-labelledby', 'mlsGrantDevelopmentTitle')
    this.dialog.innerHTML = `
      <div class="profileSettingsHeader"><h2 id="mlsGrantDevelopmentTitle">MLS grant workflows</h2><button data-close type="button">Close</button></div>
      <p class="note">Development preview. Production MLS remains unavailable. These controls use saved MLS rooms; creating, joining and delivering their outbox need the development room workflow.</p>
      <p>Account: <span data-account></span></p><p data-status role="status" aria-live="polite"></p>
      <fieldset><legend>Dedicated grant connection</legend>
        <p>This connection has its own identity and saved routes. Link relays can observe connection timing and volume.</p>
        <label>Link relay addresses <input data-relays autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <label>Grant pairing code <input data-code type="password" autocomplete="off" maxlength="32768"></label>
        <button data-pair type="button">Pair grant connection</button><button data-routes type="button">Read saved grant routes</button>
        <label>Grant route <select data-route></select></label>
        <button data-records type="button">Read grant ledger</button><div data-record-list></div>
      </fieldset>
      <fieldset><legend>Saved room membership</legend>
        <button data-rooms type="button">Check saved MLS rooms</button><label>Room <select data-room></select></label>
        <button data-members type="button">Check current members</button><div data-members-list></div>
        <p data-member-review></p><button data-member-confirm type="button" disabled>Confirm reviewed removal</button>
        <p class="note">Recorded MLS proposals still need delivery and acknowledgement. A local record does not prove box access ended.</p>
      </fieldset>
      <fieldset><legend>Keeper requests</legend>
        <button data-inbox type="button">Check retained requests</button>
        <p>Public DM relay checks reveal the receiving account, your connection address, timing and volume to the relays.</p>
        <label>Directory relay addresses <input data-directory autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <label>Optional DM relay to identify to <input data-auth-relay autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <label><input data-auth type="checkbox">Allow this account to identify to that DM relay for this check</label>
        <button data-check type="button">Check public DM relays now</button><div data-inbox-list></div>
        <p data-keeper-review></p><button data-approve type="button" disabled>Approve reviewed request</button><button data-dismiss type="button" disabled>Dismiss reviewed request</button>
      </fieldset>`
    root.body.append(this.dialog)
    addReveal(this.dialog.querySelector<HTMLInputElement>('[data-code]')!, 'pairing code')
    this.#button('close').onclick = () => this.close()
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) void this.invalidate().catch(() => {}) })
    root.addEventListener('visibilitychange', () => { if (root.visibilityState !== 'visible') void this.invalidate().catch(() => {}) })
    this.#button('records').onclick = () => { void this.#work(async () => {
      const records = this.#active(await this.#owner.records())
      this.#list('record-list', records.map(record => `${record.state}: device ${short(record.device)} at Bothy ${short(record.node)}; ${record.rooms.length} saved room use(s).`))
    }) }
    this.#button('routes').onclick = () => { void this.#routes() }
    this.#button('pair').onclick = () => {
      const code = this.#input('code').value, relays = this.#urls('relays')
      void this.#work(async () => { this.#active(await this.#owner.pair(code, relays)); this.#input('code').value = ''; this.#status('Grant connection paired. Read its saved routes before installation.') })
    }
    this.#button('rooms').onclick = () => { void this.#work(async () => {
      this.#rooms = this.#active(this.#active(await this.#owner.roomChoices()))
      this.#select('room').replaceChildren(...this.#rooms.map(room => this.#option(room.session, `${room.name} (${short(room.session)})`)))
      this.#clearReviews(); this.#list('members-list', [])
    }) }
    this.#select('room').onchange = () => { this.#retireSelection(); this.#list('members-list', []) }
    this.#select('route').onchange = () => this.#retireSelection()
    this.#input('auth').onchange = () => { if (!this.#input('auth').checked) this.#retireSelection() }
    this.#button('members').onclick = () => { void this.#members() }
    this.#button('member-confirm').onclick = () => {
      const plan = this.#memberPlan, room = this.#selectedRoom()
      if (!plan || !room) return
      this.#clearReviews()
      void this.#work(async () => { const status = this.#active(await this.#owner.memberBegin(room, plan)); this.#status(removalText(status)) })
    }
    this.#button('inbox').onclick = () => { void this.#inbox() }
    this.#button('check').onclick = () => {
      const relays = this.#urls('directory'), relay = this.#input('auth-relay').value.trim(), epoch = this.#epoch
      const authenticate = this.#input('auth').checked
      if (authenticate && !relay) { this.#status('Enter the exact DM relay before allowing identification.'); return }
      const permissions = relay ? [{ relay: { url: relay, read: true, write: false }, authenticate,
        current: () => epoch === this.#epoch && this.dialog.open && (!authenticate || this.#input('auth').checked) }] : []
      void this.#work(async () => { const scan = this.#active(this.#active(await this.#owner.keeperCheck(relays, permissions))); this.#renderInbox(scan.view); this.#status(scan.complete ? 'This finite relay check completed.' : 'This check is incomplete; retained requests remain available.') })
    }
    for (const approve of [true, false]) this.#button(approve ? 'approve' : 'dismiss').onclick = () => {
      const plan = this.#keeperPlan
      if (!plan) return
      this.#clearReviews()
      void this.#work(async () => {
        if (approve) { const progress = this.#active(await this.#owner.keeperApprove(plan)); this.#status(`Request ${progress.state}. MLS delivery and exact grant withdrawal are confirmed separately.`) }
        else { this.#active(this.#active(await this.#owner.keeperDecide(plan, false))); this.#status('Request dismissed. Existing approved holds remain retained.') }
      })
    }
  }
  open(): void {
    if (this.root.visibilityState !== 'visible') return
    const account = this.context()
    this.#text('account').textContent = account ? short(account.persona) : 'Sign in first'
    this.#status('Choose a workflow. Connections require explicit actions.')
    if (!this.dialog.open) this.dialog.showModal()
  }
  close(): void { void this.invalidate().catch(() => {}) }
  invalidate(): Promise<void> {
    if (this.dialog.open) this.dialog.close()
    this.#epoch++; this.#rooms = []; this.#clearReviews()
    this.#text('account').textContent = ''; this.#status('')
    this.#input('code').value = ''; this.#input('auth').checked = false
    this.#select('room').replaceChildren(); this.#select('route').replaceChildren()
    for (const list of ['members-list','record-list','inbox-list']) this.#list(list, [])
    return this.#owner.pause()
  }
  async #work(work: () => Promise<void>): Promise<void> {
    if (this.#busy || !this.dialog.open) return
    const epoch = this.#epoch; this.#busy = true; this.#clearReviews(); this.#status('Checking…')
    try { await work() } catch (error) { if (epoch === this.#epoch && this.dialog.open) this.#status(error instanceof Error ? error.message : 'This workflow could not be confirmed.') }
    finally { this.#busy = false }
  }
  #active<T>(result: { state: string; value?: T }): T {
    if (!this.dialog.open || this.root.visibilityState !== 'visible' || result.state !== 'active') throw new Error(`Workflow ${result.state}. Reopen in the current foreground account before retrying.`)
    return result.value!
  }
  async #routes(): Promise<void> { await this.#work(async () => {
    const routes = this.#active(await this.#owner.routes())
    this.#select('route').replaceChildren(...routes.map(route => this.#option(route.routeId, route.routeId)))
  }) }
  async #members(): Promise<void> { const room = this.#selectedRoom(); if (!room) return
    await this.#work(async () => {
      const view = this.#active(await this.#owner.memberView(room)), list = this.#text('members-list'); list.replaceChildren()
      for (const member of view.members) {
        const row = this.root.createElement('p'); row.textContent = `Person ${short(member.identity)}, device ${short(member.device)}${member.own ? ' (this device)' : ''}${member.pending ? ' (pending)' : ''}. `
        if (!member.own && !member.pending) {
          row.append(this.#action('Install grant on selected route', () => {
            const route = this.#select('route').value, epoch = this.#epoch
            if (!route) return
            void confirmAction({ title: 'Install this member grant?', message: `Allow the verified device ${short(member.device)} on the selected paired Bothy. This creates signed node access for up to 30 days. The paired Bothy receives the keeper and member public keys, device key, grant identifier and scope, expiry and storage capacity. Room names and room identifiers are not included in this grant.`, confirmLabel: 'Install grant', isCurrent: () => epoch === this.#epoch && this.dialog.open }).then(ok => {
              if (ok) void this.#work(async () => { const record = this.#active(await this.#owner.install(room, member.leafId, route)); this.#status(`Grant ${record.state}.`) })
            })
          }))
          for (const compromised of [false, true]) row.append(this.#action(compromised ? 'Review compromised device' : 'Review device removal', () => { void this.#work(async () => {
            const plan = this.#active(await this.#owner.memberPlan(room, 'device', member.leafId, compromised)); this.#memberPlan = plan
            this.#text('member-review').textContent = this.#removalReview(plan)
            this.#button('member-confirm').disabled = false
          }) }))
          row.append(this.#action('Review person removal', () => { void this.#work(async () => {
            const plan = this.#active(await this.#owner.memberPlan(room, 'person', member.identity, true)); this.#memberPlan = plan
            this.#text('member-review').textContent = this.#removalReview(plan); this.#button('member-confirm').disabled = false
          }) }))
        }
        list.append(row)
      }
      for (const removal of view.removals) list.append(this.#action(`Continue removal ${short(removal.operation)}`, () => { void this.#work(async () => { this.#status(removalText(this.#active(await this.#owner.memberAdvance(room, removal.operation)))) }) }))
    })
  }
  async #inbox(): Promise<void> { await this.#work(async () => {
    const view = this.#active(this.#active(await this.#owner.keeperView()))
    const approvals = this.#active(this.#active(await this.#owner.keeperApprovals()))
    this.#renderInbox(view, approvals)
  }) }
  #renderInbox(view: MlsRevocationInboxView, approvals: MlsRevocationInboxPrompt[] = []): void {
    const list = this.#text('inbox-list'); list.replaceChildren()
    for (const prompt of [...view.prompts.map(item => item.prompt), ...approvals]) {
      const row = this.root.createElement('p'); row.textContent = `${prompt.state}: person ${short(prompt.request.sender)}, device ${short(prompt.request.device)}. `
      if (prompt.state === 'pending') row.append(this.#action('Review request', () => { void this.#work(async () => {
        const plan = this.#active(this.#active(await this.#owner.keeperReview(prompt.operation))); this.#keeperPlan = plan
        this.#text('keeper-review').textContent = `Person ${short(plan.prompt.request.sender)}, device ${short(plan.prompt.request.device)}. ` +
          plan.rooms.map(room => `${room.name} (${short(room.session)}): ${room.action} leaf ${short(room.member.leafId)}.`).join(' ') + ' ' +
          plan.grants.map(grant => `Revoke node-wide grant at Bothy ${short(grant.node)}; saved uses: ${grant.rooms.map(room => room.name).join(', ') || 'none'}.`).join(' ') +
          (plan.conflict ? ' Conflicting device requests require checking.' : '') + ' Approval retains the device hold; missing routes and expiry alone do not confirm ended access.'
        this.#button('approve').disabled = false; this.#button('dismiss').disabled = false
      }) }))
      if (prompt.state === 'approved') {
        row.append(this.#action('Continue approved request', () => { void this.#work(async () => { const progress = this.#active(await this.#owner.keeperAdvance(prompt.operation)); this.#status(`Request ${progress.state}; check individual room delivery and grant outcomes.`) }) }))
        row.append(this.#action('Confirm completion', () => { void this.#work(async () => { this.#active(this.#active(await this.#owner.keeperComplete(prompt.operation))); this.#status('Completion witnessed. This does not prove physical deletion of prior messages.') }) }))
      }
      list.append(row)
    }
  }
  #selectedRoom() { return this.#rooms.find(room => room.session === this.#select('room').value) }
  #removalReview(plan: MlsRemovalPlan) {
    return `Remove ${plan.members.length} leaf/leaves for ${plan.kind === 'person' ? 'this person' : 'this device'}. ` +
      plan.grants.map(grant => `Bothy ${short(grant.node)}: ${grant.action}; saved room uses ${grant.rooms.map(room => `${room.name} (${short(room.session)})`).join(', ') || 'none'}.`).join(' ') +
      (plan.grants.length ? '' : ' No keeper-issued grant is recorded here; box access cannot be claimed ended.') +
      (plan.compromised ? ' A compromised device holds new sends and Adds until its Remove is witnessed.' : ' Final unused grants have a delivery grace period.') +
      ' The person credential requires a separate observed tombstone.'
  }
  #retireSelection() { this.#epoch++; this.#clearReviews(); void this.#owner.pause().catch(() => {}) }
  #clearReviews() { this.#memberPlan = undefined; this.#keeperPlan = undefined; for (const key of ['member-confirm','approve','dismiss']) this.#button(key).disabled = true; this.#text('member-review').textContent = ''; this.#text('keeper-review').textContent = '' }
  #text(key: string) { return this.dialog.querySelector<HTMLElement>(`[data-${key}]`)! }
  #input(key: string) { return this.#text(key) as HTMLInputElement }
  #select(key: string) { return this.#text(key) as HTMLSelectElement }
  #button(key: string) { return this.#text(key) as HTMLButtonElement }
  #status(text: string) { this.#text('status').textContent = text }
  #urls(key: string) { return this.#input(key).value.trim().split(/\s+/).filter(Boolean) }
  #option(value: string, text: string) { const option = this.root.createElement('option'); option.value = value; option.textContent = text; return option }
  #list(key: string, lines: string[]) { this.#text(key).replaceChildren(...lines.map(line => { const p = this.root.createElement('p'); p.textContent = line; return p })) }
  #action(text: string, invoke: () => void) { const button = this.root.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = invoke; return button }
}
