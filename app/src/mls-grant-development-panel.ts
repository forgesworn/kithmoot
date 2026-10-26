import { labStoragePreviewEnabled } from './mls-lab-storage-preview.js'
import { adminInvitationPreviewEnabled } from './mls-admin-invitation-engine.js'
import type { StorageGrantRecord, StorageGrantReview } from './mls-storage-grants.js'
import { BrowserMlsGrantDevelopmentOwner, type MlsGrantDevelopmentContext, type MlsDevelopmentRoom } from './mls-grant-development-owner.js'
import type { MlsRemovalPlan } from './mls-membership-controller.js'
import { removalComponentCopy } from './mls-membership-controller.js'
import type { MlsKeeperDecisionPlan } from './mls-keeper-decisions.js'
import { confirmAction } from './confirm-action.js'
import type { MlsRemovalStatus } from './mls-room-operations.js'
import type { MlsRevocationInboxView } from './mls-revocation-inbox.js'
import type { MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { importKeeperInboxPermission, type KeeperInboxPermission, type KeeperPermissionRecord } from './mls-keeper-permissions.js'
import type { MlsStandaloneRevocationView } from './mls-revocation-outbox.js'
import type { PairedBox } from './browser-link.js'
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
  #workingEpoch?: number
  #savedRoutes: PairedBox[] = []
  #outboxRows: MlsStandaloneRevocationView[] = []
  #permissionRows: KeeperPermissionRecord[] = []
  #senderPermission?: KeeperInboxPermission
  #rooms: (MlsDevelopmentRoom & { name: string })[] = []
  #storageRows: StorageGrantRecord[] = []
  #storageReview?: StorageGrantReview
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
      <fieldset data-bootstrap hidden><legend>Authorise an enrolled device on your node</legend>
        <p>Experimental node storage permission, separate from MLS membership. Select your saved grant route above. The node independently checks your keeper authority. This permission expires after one hour.</p>
        <label>Enrolled account public key <input data-bootstrap-persona maxlength="64" autocomplete="off" spellcheck="false"></label>
        <label>Enrolled MLS device public key <input data-bootstrap-device maxlength="64" autocomplete="off" spellcheck="false"></label>
        <button data-bootstrap-authorise type="button">Review node storage permission</button>
        <button data-storage-records type="button">Read protected storage grants</button><div data-storage-list></div>
      </fieldset>
      <fieldset data-admin-storage hidden><legend>Admin2 private storage withdrawal</legend>
        <p>Select a saved room and grant route. Enter the expected storage keeper independently from the signed inbox permission below. Preparation reads the actual current native roster; it accepts only another committed device belonging to this account on this node. This requests storage withdrawal only. MLS membership remains a separate current-admin action.</p>
        <button data-storage-members type="button">Read actual device leaves</button><div data-storage-members-list></div>
        <label>Target device leaf ID <input data-storage-leaf maxlength="64" autocomplete="off" spellcheck="false"></label>
        <label>Expected storage keeper public key from trusted contact <input data-storage-keeper maxlength="64" autocomplete="off" spellcheck="false"></label>
        <button data-storage-prepare-request type="button">Prepare witnessed storage request</button>
        <button data-storage-rebind-request type="button">Review replacement private permission / route</button>
        <p>A replacement rechecks the actual roster and current credential, retains previous destination and attempt evidence, and requires the reviewed binding and request revisions. Afterwards use the explicit private retry button; no automatic send or public fallback occurs.</p>
        <p>Then inspect the signed permission and send the retained request privately below.</p>
        <button data-storage-private-check type="button">Check storage requests on selected Bothy privately</button>
        <button data-storage-inbox type="button">Read retained storage requests</button><div data-storage-inbox-list></div>
        <p data-storage-review></p><button data-storage-approve type="button" disabled>Approve storage withdrawal only</button>
      </fieldset>
      <fieldset><legend>Send a retained revocation request</legend>
        <button data-outbox type="button">Check retained send requests</button>
        <label>Retained request <select data-send-request></select></label><p data-send-review></p>
        <button data-my-device type="button">Read this account's transmitting device key</button><p data-my-device-key></p>
        <label>Signed keeper inbox permission JSON <textarea data-send-permission maxlength="8192" rows="4" spellcheck="false"></textarea></label>
        <button data-inspect-permission type="button">Inspect signed permission</button><p data-permission-review></p>
        <p>The permission names the device sending this request, not the device being removed. The selected Bothy sees the keeper/transmitting-device link, grant, expiry and timing. Link relays see timing and volume. Requires a Bothy node that supports private keeper requests; node acceptance decides current keeper authority.</p>
        <button data-send-private type="button">Send privately to selected Bothy</button><button data-retry-private type="button">Explicitly retry privately at current revision</button>
        <p>Public sending is a separate explicit choice. It reads the keeper's DM directory using the directory relays below and discloses connection metadata to public relays. Private sending never falls back.</p>
        <button data-send-public type="button">Send using public DM relays</button><button data-retry-public type="button">Explicitly retry publicly at current revision</button>
        <button data-cancel-send type="button">Cancel current operation</button>
      </fieldset>
      <fieldset><legend>Keeper inbox deposit permissions</legend>
        <p>Use the selected account as issuer. This does not infer storage-keeper authority from room membership; the selected Bothy validates it.</p>
        <label>Transmitting MLS device key (64 lowercase hex) <input data-permission-device maxlength="64" spellcheck="false" autocomplete="off"></label>
        <label>Lifetime in days (1–30) <input data-permission-days type="number" min="1" max="30" value="1"></label>
        <button data-prepare-permission type="button">Prepare active and terminal revocation</button><button data-permissions type="button">Read saved permissions</button>
        <label>Saved permission <select data-permission-choice></select></label><p data-saved-permission-review></p>
        <button data-install-permission type="button">Install / retry exact active permission</button><button data-revoke-permission type="button">Revoke / retry exact terminal permission</button>
        <button data-export-permission type="button">Export installed active JSON</button>
        <label>Ordinary signed Event JSON to copy <textarea data-permission-export readonly rows="4" spellcheck="false"></textarea></label>
        <p>Preparation stores both exact signed events before publication. Unknown installation or revocation is not acknowledgement. An expired record cannot establish revocation; a terminal revocation cannot be reactivated.</p>
      </fieldset>
      <fieldset><legend>Saved room membership</legend>
        <button data-rooms type="button">Check saved MLS rooms</button><label>Room <select data-room></select></label>
        <button data-members type="button">Check current members</button><div data-members-list></div>
        <p data-member-review></p><button data-member-confirm type="button" disabled>Confirm reviewed removal</button>
        <p class="note">Recorded MLS proposals still need delivery and acknowledgement. A local record does not prove box access ended.</p>
      </fieldset>
      <fieldset><legend>Keeper requests</legend>
        <button data-inbox type="button">Check retained requests</button>
        <p>Private checks use the selected saved grant route. This check sends its recipient query and account identification to the selected Bothy over Link; Link relays can still observe timing and volume. This reads requests already held there; member request sending remains separate.</p>
        <label><input data-private-auth type="checkbox">Allow this account to identify to the selected private Bothy for this check</label>
        <button data-private-check type="button">Check selected Bothy privately</button><button data-private-older type="button">Check older requests privately</button>
        <p>Normal checks read a fresh window. Older-request checks resume the retained inclusive boundary; they do not prove older history is complete.</p>
        <p>Public DM relay checks reveal the receiving account, your connection address, timing and volume to the relays.</p>
        <label>Directory relay addresses <input data-directory autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <label>Optional DM relay to identify to <input data-auth-relay autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <label><input data-auth type="checkbox">Allow this account to identify to that DM relay for this check</label>
        <button data-check type="button">Check public DM relays now</button><button data-check-older type="button">Check older public requests</button><div data-inbox-list></div>
        <p data-keeper-review></p><button data-approve type="button" disabled>Approve reviewed request</button><button data-dismiss type="button" disabled>Dismiss reviewed request</button>
      </fieldset>`
    root.body.append(this.dialog)
    this.#text('bootstrap').hidden = !labStoragePreviewEnabled()
    this.#text('admin-storage').hidden = !adminInvitationPreviewEnabled()
    this.#button('bootstrap-authorise').onclick = () => { void this.#work(async () => {
      const result = this.#active(await this.#owner.authoriseEnrolledDevice(this.#select('route').value, this.#input('bootstrap-persona').value.trim(), this.#input('bootstrap-device').value.trim()))
      this.#status(result.state === 'accepted' ? 'The selected node acknowledged this storage permission. This grants no MLS membership.' : result.state === 'denied' ? 'Storage permission was denied.' : 'Storage permission is unconfirmed. Read protected storage grants before explicitly retrying; no acknowledgement is assumed.')
    }) }
    this.#button('storage-records').onclick = () => { void this.#work(() => this.#refreshStorage()) }
    for (const key of ['storage-leaf','storage-keeper']) this.#input(key).oninput = () => this.#retireSelection()
    this.#button('storage-members').onclick = () => {
      const room = this.#selectedRoom(); if (!room) { this.#status('Select the saved Admin2 room.'); return }
      void this.#work(async () => {
        const members = this.#active(this.#active(await this.#owner.adminStorageMembers(room)))
        const list = this.#text('storage-members-list'); list.replaceChildren()
        for (const member of members) {
          const row = this.root.createElement('p'); row.textContent = `Person ${short(member.identity)}; device ${short(member.device)}; leaf ${member.leafId}${member.own ? ' (this device)' : ''}${member.pending ? ' (pending)' : ''}. `
          if (!member.own && !member.pending && member.identity === this.context()?.persona) row.append(this.#action('Select storage withdrawal target', () => { this.#retireSelection(); this.#input('storage-leaf').value = member.leafId }))
          list.append(row)
        }
      })
    }
    this.#button('storage-prepare-request').onclick = () => {
      const room = this.#selectedRoom(), routeId = this.#select('route').value
      if (!room || !routeId) { this.#status('Select the actual saved Admin2 room and paired grant route.'); return }
      void this.#work(async () => {
        const permission = importKeeperInboxPermission(this.#input('send-permission').value)
        const prepared = this.#active(this.#active(await this.#owner.prepareAdminStorageRequest(room, { routeId, permission: permission.event,
          leaf: this.#input('storage-leaf').value.trim(), expectedStorageKeeper: this.#input('storage-keeper').value.trim() })))
        await this.#refreshOutbox(); this.#select('send-request').value = prepared.operation; this.#renderSendReview()
        this.#status('Witnessed storage request retained. Inspect the permission and explicitly send privately. MLS membership is unchanged.')
      })
    }
    this.#button('storage-rebind-request').onclick = () => {
      const room = this.#selectedRoom(), request = this.#selectedRequest(), routeId = this.#select('route').value
      const current = this.#selectionCurrent(this.#epoch, routeId)
      if (!room || !request || !routeId) { this.#status('Select the actual Admin2 room, retained request and replacement saved route.'); return }
      void this.#work(async () => {
        const binding = this.#active(this.#active(await this.#owner.adminStorageBinding(request.operation)))
        const permission = importKeeperInboxPermission(this.#input('send-permission').value)
        const leaf = this.#input('storage-leaf').value.trim(), expectedStorageKeeper = this.#input('storage-keeper').value.trim()
        if (!await confirmAction({ title: 'Replace this private storage destination?',
          message: `Operation ${binding.operation}; binding revision ${binding.bindingRevision}; request revision ${binding.requestRevision}. New permission ${permission.event.id}; route ${routeId}; independently expected keeper ${expectedStorageKeeper}. Previous binding and attempt evidence will be retained. This does not send a request; use the explicit private retry afterwards.`,
          confirmLabel: 'Recheck native roster and replace', isCurrent: current })) return
        this.#active(this.#active(await this.#owner.prepareAdminStorageRequest(room, { routeId, leaf, expectedStorageKeeper, permission: permission.event, rebind: binding })))
        await this.#refreshOutbox(); this.#status('Replacement private binding witnessed. Inspect the new permission and explicitly retry privately at the current request revision. Previous evidence remains retained.')
      })
    }
    this.#button('storage-inbox').onclick = () => { void this.#work(async () => this.#renderStorageInbox(this.#active(this.#active(await this.#owner.storageKeeperView())))) }
    this.#button('storage-private-check').onclick = () => {
      const routeId = this.#select('route').value, currentBase = this.#selectionCurrent(this.#epoch, routeId)
      if (!this.#input('private-auth').checked) { this.#status('Allow keeper identification to the selected Bothy before checking storage requests.'); return }
      void this.#work(async () => {
        const scan = this.#active(this.#active(await this.#owner.storageKeeperCheckPrivate({ routeId, authenticate: true,
          current: () => currentBase() && this.#input('private-auth').checked })))
        this.#renderStorageInbox(scan.view); this.#status('Private storage request page checked; older history remains unconfirmed. No public fallback was used.')
      })
    }
    this.#button('storage-approve').onclick = () => {
      const review = this.#storageReview, routeId = this.#select('route').value, current = this.#selectionCurrent(this.#epoch, routeId)
      if (!review) return
      void confirmAction({ title: 'Withdraw reviewed storage access only?', message: `Withdraw exact retained storage grants for person ${review.request.sender}, device ${review.request.device}. The node must acknowledge each exact terminal event. MLS membership will remain unchanged; a current MLS admin must separately approve any Remove.`, confirmLabel: 'Approve storage withdrawal', isCurrent: current }).then(ok => {
        if (ok) void this.#work(async () => {
          this.#active(this.#active(await this.#owner.storageKeeperApprove(review, current)))
          this.#storageReview = undefined; this.#button('storage-approve').disabled = true
          this.#active(this.#active(await this.#owner.storageKeeperAdvance(review.operation, current)))
          this.#status('The selected node acknowledged storage withdrawal. MLS membership is unchanged.')
          await this.#refreshStorage()
        })
      })
    }
    if (import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true') void import('./mls-mixed-invitation-lab.js').then(m => m.captureGrantOwner(this.#owner))
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
    this.#select('room').onchange = () => { this.#retireSelection(); this.#list('members-list', []); this.#list('storage-members-list', []) }
    this.#select('route').onchange = () => { this.#input('private-auth').checked = false; this.#retireSelection() }
    this.#input('private-auth').onchange = () => { if (!this.#input('private-auth').checked) this.#retireSelection() }
    this.#input('auth').onchange = () => { if (!this.#input('auth').checked) this.#retireSelection() }
    this.#button('outbox').onclick = () => { void this.#work(() => this.#refreshOutbox()) }
    this.#select('send-request').onchange = () => { this.#retireSelection(); this.#renderSendReview() }
    this.#input('send-permission').oninput = () => this.#retireSelection()
    this.#button('inspect-permission').onclick = () => {
      try {
        const terms = importKeeperInboxPermission(this.#input('send-permission').value), request = this.#selectedRequest(), route = this.#savedRoutes.find(r => r.routeId === this.#select('route').value)
        if (!request || !route || terms.keeper !== request.keeper || route.eventUrl !== terms.event.tags.find(t => t[0] === 'server')![1]) throw new Error('Select the retained request and the exact saved node named by this permission.')
        this.#senderPermission = terms
        this.#text('permission-review').textContent = `Keeper ${terms.keeper}; transmitting device ${terms.device}; node ${terms.node}; grant ${terms.grant}; expires ${new Date(terms.expiration * 1000).toISOString()}. Signature verified; current keeper authority is decided by the node.`
      } catch (error) { this.#senderPermission = undefined; this.#status(error instanceof Error ? error.message : 'Invalid permission.') }
    }
    this.#button('my-device').onclick = () => { void this.#work(async () => { const result = this.#active(await this.#owner.currentMlsDevice()); if (!result.ok) throw new Error(`Transmitting device unavailable: ${result.refusal}`); this.#text('my-device-key').textContent = `Transmitting device: ${result.value.device}` }) }
    for (const retry of [false, true]) {
      this.#button(retry ? 'retry-private' : 'send-private').onclick = () => { void this.#sendPrivate(retry) }
      this.#button(retry ? 'retry-public' : 'send-public').onclick = () => { void this.#sendPublic(retry) }
    }
    this.#button('cancel-send').onclick = () => { this.#retireSelection(); this.#status('Operation canceled. Check retained state before explicitly retrying an unconfirmed attempt.') }
    this.#button('permissions').onclick = () => { void this.#work(() => this.#refreshPermissions()) }
    this.#select('permission-choice').onchange = () => { this.#retireSelection(); this.#renderPermissionReview() }
    for (const key of ['permission-device','permission-days']) this.#input(key).oninput = () => this.#retireSelection()
    this.#button('prepare-permission').onclick = () => { void this.#preparePermission() }
    for (const revoke of [false,true]) this.#button(revoke ? 'revoke-permission' : 'install-permission').onclick = () => { void this.#publishPermission(revoke) }
    this.#button('export-permission').onclick = () => { const row = this.#selectedPermission(); if (!row) return; void this.#work(async () => { this.#input('permission-export').value = this.#active(this.#active(await this.#owner.exportKeeperPermission(row.grant, row.revision))) }) }
    this.#button('members').onclick = () => { void this.#members() }
    this.#button('member-confirm').onclick = () => {
      const plan = this.#memberPlan, room = this.#selectedRoom()
      if (!plan || !room) return
      this.#clearReviews()
      void this.#work(async () => { const status = this.#active(await this.#owner.memberBegin(room, plan)); this.#status(removalText(status)) })
    }
    this.#button('inbox').onclick = () => { void this.#inbox() }
    for (const mode of ['latest', 'retained'] as const) this.#button(mode === 'latest' ? 'private-check' : 'private-older').onclick = () => {
      const routeId = this.#select('route').value, epoch = this.#epoch
      if (!routeId || !this.#input('private-auth').checked) { this.#status('Select a saved grant route and allow identification to that private Bothy.'); return }
      const permission = { routeId, authenticate: true, mode, current: () => epoch === this.#epoch && this.dialog.open &&
        this.#select('route').value === routeId && this.#input('private-auth').checked }
      void this.#work(async () => {
        const scan = this.#active(this.#active(await this.#owner.keeperCheckPrivate(permission)))
        this.#renderInbox(scan.view)
        this.#status(mode === 'latest'
          ? (scan.complete ? 'Latest private page processed. Retained older progress is unchanged.' : 'Latest private check is incomplete. Retained older progress is unchanged; no public fallback was used.')
          : (scan.complete ? 'This older private page was processed; older history remains unconfirmed.' : 'Older private check is incomplete; its inclusive boundary is retained.'))
      })
    }
    for (const mode of ['latest', 'retained'] as const) this.#button(mode === 'latest' ? 'check' : 'check-older').onclick = () => {
      const relays = this.#urls('directory'), relay = this.#input('auth-relay').value.trim(), epoch = this.#epoch
      const authenticate = this.#input('auth').checked
      if (authenticate && !relay) { this.#status('Enter the exact DM relay before allowing identification.'); return }
      const permissions = relay ? [{ relay: { url: relay, read: true, write: false }, authenticate,
        current: () => epoch === this.#epoch && this.dialog.open && (!authenticate || this.#input('auth').checked) }] : []
      void this.#work(async () => {
        const scan = this.#active(this.#active(await this.#owner.keeperCheck(relays, permissions, mode)))
        this.#renderInbox(scan.view)
        this.#status(mode === 'latest'
          ? (scan.complete ? 'Latest public page processed. Retained older progress is unchanged.' : 'Latest public check is incomplete. Retained older progress is unchanged.')
          : (scan.complete ? 'This older public page was processed; older history remains unconfirmed.' : 'Older public check is incomplete; its inclusive boundary is retained.'))
      })
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
    this.#epoch++; this.#storageRows = []; this.#storageReview = undefined; this.#rooms = []; this.#savedRoutes = []; this.#outboxRows = []; this.#permissionRows = []; this.#senderPermission = undefined; this.#clearReviews()
    this.#text('account').textContent = ''; this.#status('')
    this.#input('code').value = ''; this.#input('auth').checked = false; this.#input('private-auth').checked = false
    this.#select('room').replaceChildren(); this.#select('route').replaceChildren(); this.#select('send-request').replaceChildren(); this.#select('permission-choice').replaceChildren()
    for (const key of ['send-permission','permission-export','permission-device']) this.#input(key).value = ''
    for (const key of ['send-review','permission-review','saved-permission-review','my-device-key']) this.#text(key).textContent = ''
    for (const list of ['members-list','record-list','inbox-list']) this.#list(list, [])
    return this.#owner.pause()
  }
  async #work(work: () => Promise<void>): Promise<void> {
    if (this.#busy || !this.dialog.open) return
    const epoch = this.#epoch; this.#workingEpoch = epoch; this.#busy = true; this.#clearReviews(); this.#status('Checking…')
    try { await work() } catch (error) { if (epoch === this.#epoch && this.dialog.open) this.#status(error instanceof Error ? error.message : 'This workflow could not be confirmed.') }
    finally { this.#busy = false; this.#workingEpoch = undefined }
  }
  #active<T>(result: { state: string; value?: T }): T {
    if (this.#workingEpoch !== undefined && this.#workingEpoch !== this.#epoch || !this.dialog.open || this.root.visibilityState !== 'visible' || result.state !== 'active') throw new Error(`Workflow ${result.state}. Reopen in the current foreground account before retrying.`)
    return result.value!
  }
  async #routes(): Promise<void> { await this.#work(async () => {
    const routes = this.#active(await this.#owner.routes()); this.#savedRoutes = routes
    this.#input('private-auth').checked = false
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
  #selectedRequest() { return this.#outboxRows.find(r => r.operation === this.#select('send-request').value) }
  #selectedPermission() { return this.#permissionRows.find(r => r.grant === this.#select('permission-choice').value) }
  #selectionCurrent(epoch: number, route: string) {
    const account = this.context(), persona = account?.persona, generation = account?.generation
    return () => epoch === this.#epoch && this.dialog.open && this.root.visibilityState === 'visible' && this.#select('route').value === route &&
      this.context()?.persona === persona && this.context()?.generation === generation
  }
  async #refreshStorage() {
    this.#storageRows = this.#active(this.#active(await this.#owner.storageRecords()))
    const list = this.#text('storage-list'); list.replaceChildren()
    for (const r of this.#storageRows) {
      const g = r.grant, row = this.root.createElement('p')
      row.textContent = `Storage ${r.revision === 0 ? 'prepared, unpublished' : g.state === 'installing' || g.state === 'revoking' ? g.state + ', acknowledgement unknown' : g.state}: person ${short(g.persona)}, device ${short(g.device)}, node ${short(g.node)}, revision ${r.revision}; expires ${new Date(g.expiration * 1000).toISOString()}. `
      if (g.state !== 'revoked') {
        for (const revoke of (g.state === 'revoking' ? [true] : [false, true])) row.append(this.#action(revoke ? 'Review exact storage withdrawal' : 'Retry exact installation', () => {
          const current = this.#selectionCurrent(this.#epoch, this.#select('route').value)
          void confirmAction({ title: revoke ? 'Withdraw this exact storage grant?' : 'Retry retained storage installation?',
            message: `Node ${g.node}, persona ${g.persona}, device ${g.device}, grant ${g.grantId}. Uses the exact retained signed statement and saved route. This does not change MLS membership.`,
            confirmLabel: revoke ? 'Withdraw storage only' : 'Retry exact active statement', isCurrent: current }).then(ok => {
            if (ok) void this.#work(async () => { this.#active(this.#active(await this.#owner.publishStorageGrant(g.grantId, r.revision, revoke, current))); await this.#refreshStorage(); this.#status(revoke ? 'The selected node acknowledged storage withdrawal. MLS membership is unchanged.' : 'The selected node acknowledged the exact storage grant.') })
          })
        }))
      }
      if (r.approval && g.state !== 'revoked') row.append(this.#action('Retry approved storage withdrawal', () => {
        const current = this.#selectionCurrent(this.#epoch, this.#select('route').value)
        void this.#work(async () => { this.#active(this.#active(await this.#owner.storageKeeperAdvance(r.approval!.operation, current))); await this.#refreshStorage(); this.#status('The selected node acknowledged storage withdrawal. MLS membership is unchanged.') })
      }))
      list.append(row)
    }
  }
  #renderStorageInbox(view: MlsRevocationInboxView) {
    this.#storageReview = undefined; this.#button('storage-approve').disabled = true
    const list = this.#text('storage-inbox-list'); list.replaceChildren()
    for (const item of view.prompts) {
      const row = this.root.createElement('p'); row.textContent = `Storage only: person ${short(item.prompt.request.sender)}, device ${short(item.prompt.request.device)}. `
      row.append(this.#action('Review storage grants', () => { void this.#work(async () => {
        const review = this.#active(this.#active(await this.#owner.storageKeeperReview(item.prompt.operation)))
        this.#storageReview = review
        this.#text('storage-review').textContent = review.records.map(r => `Node ${r.grant.node}; exact active ${r.grant.active.id}; terminal ${r.grant.revocation.id}; revision ${r.revision}.`).join(' ') + ' Approval withdraws storage access only. MLS membership remains unchanged.'
        this.#button('storage-approve').disabled = false
      }) }))
      list.append(row)
    }
  }
  async #refreshOutbox() {
    const selected = this.#select('send-request').value
    this.#outboxRows = this.#active(this.#active(await this.#owner.revocationRecords()))
    this.#select('send-request').replaceChildren(...this.#outboxRows.map(r => this.#option(r.operation, `${short(r.keeper)} / remove ${short(r.device)} / ${r.requestState}`)))
    if (this.#outboxRows.some(r => r.operation === selected)) this.#select('send-request').value = selected
    this.#renderSendReview()
  }
  #renderSendReview() {
    const r = this.#selectedRequest()
    this.#text('send-review').textContent = r ? `Keeper ${r.keeper}; device being removed ${r.device}; revision ${r.requestRevision}; ${r.requestState === 'unconfirmed' ? 'unconfirmed: no acknowledgement retained; explicit retry required' : r.requestState}. ${r.publicAttempted ? 'An earlier public attempt exists; this is not private-only history.' : 'No earlier public attempt is recorded here; this is not proof of no older traffic.'} ${r.privateDestination ? `Last private node ${r.privateDestination.node}.` : ''}` : 'No retained request selected.'
  }
  async #sendPrivate(retry: boolean) {
    const request = this.#selectedRequest(), terms = this.#senderPermission, routeId = this.#select('route').value, epoch = this.#epoch
    if (!request || !terms || !routeId || retry && request.requestRevision < 1) { this.#status('Inspect a permission for the selected retained request and saved route; retry requires its current revision.'); return }
    const currentBase = this.#selectionCurrent(epoch, routeId), text = this.#input('send-permission').value
    const current = () => currentBase() && this.#select('send-request').value === request.operation && this.#input('send-permission').value === text
    await this.#work(async () => {
      try {
        this.#active(this.#active(await this.#owner.sendRevocationPrivately(request.operation, { routeId, permission: terms.event, current,
          consent: async scope => await confirmAction({ title: 'Identify this transmitting device to the selected Bothy?',
            message: `Principal ${scope.principal}; persona ${scope.persona}; transmitting device ${scope.device}; keeper ${scope.keeper}; node ${scope.box}; grant ${scope.grant}; destination ${scope.destination}; permission ${scope.permissionId}; operation deadline ${scope.deadline}. This identifies the sending device, not the device being removed. The node sees this link and timing; Link relays see timing and volume.`,
            confirmLabel: retry ? `Retry private revision ${request.requestRevision}` : 'Identify and send privately', isCurrent: () => current() && scope.current() }) ? 'approve' : 'deny',
        }, retry ? request.requestRevision : undefined)))
        if (current()) { await this.#refreshOutbox(); this.#status('Private send state checked. Only a retained matching node ACK is shown as sent; no public fallback was used.') }
      } catch (error) { if (current()) { await this.#refreshOutbox(); this.#status(`${error instanceof Error ? error.message : 'Private send failed.'} Check retained state; no public fallback was used.`) } }
    })
  }
  async #sendPublic(retry: boolean) {
    const request = this.#selectedRequest(), epoch = this.#epoch, route = this.#select('route').value, current = this.#selectionCurrent(epoch, route)
    if (!request || retry && request.requestRevision < 1) return
    const relays = this.#urls('directory')
    if (!await confirmAction({ title: 'Use public DM relays for this request?', message: `This separate action reads a public DM directory for keeper ${request.keeper} and publishes an encrypted wrapper through its public relays. Those services observe connection address, timing and volume. Earlier public history remains recorded.`, confirmLabel: retry ? `Retry publicly at revision ${request.requestRevision}` : 'Send publicly', isCurrent: current })) return
    await this.#work(async () => { this.#active(this.#active(await this.#owner.sendRevocationPublic(request.operation, relays, retry ? request.requestRevision : undefined))); if (current()) await this.#refreshOutbox() })
  }
  async #refreshPermissions() {
    const selected = this.#select('permission-choice').value
    this.#permissionRows = this.#active(this.#active(await this.#owner.keeperPermissions()))
    this.#select('permission-choice').replaceChildren(...this.#permissionRows.map(r => this.#option(r.grant, `${short(r.grant)}: ${r.expiration <= Date.now()/1000 ? 'expired / outcome retained' : r.state} / revision ${r.revision}`)))
    if (this.#permissionRows.some(r => r.grant === selected)) this.#select('permission-choice').value = selected
    this.#renderPermissionReview()
  }
  #renderPermissionReview() {
    const r = this.#selectedPermission()
    this.#text('saved-permission-review').textContent = r ? `Issuer ${r.keeper}; transmitting device ${r.device}; node ${r.node}; grant ${r.grant}; expiry ${new Date(r.expiration*1000).toISOString()}; revision ${r.revision}; ${r.state === 'installing' || r.state === 'revoking' ? r.state + ': unknown, not node-acknowledged' : r.state}. ${r.expiration <= Date.now()/1000 ? 'Expired: no new installation or revocation claim is available.' : ''}` : ''
    this.#button('export-permission').disabled = !r || r.state !== 'installed' || r.expiration <= Date.now()/1000
  }
  async #preparePermission() {
    const route = this.#select('route').value, device = this.#input('permission-device').value.trim(), seconds = Number(this.#input('permission-days').value) * 86400
    const current = this.#selectionCurrent(this.#epoch, route), selected = this.#savedRoutes.find(r => r.routeId === route)
    if (!selected) { this.#status('Read and select a saved Bothy route first.'); return }
    if (!route || !await confirmAction({ title: 'Prepare this keeper inbox permission?', message: `Issuer ${this.context()?.persona}; route ${route}; node ${mlsBoxNode(selected)}; destination ${selected.eventUrl}. This account will sign active and terminal revocation statements for transmitting device ${device} on the selected saved Bothy for ${seconds/86400} day(s). Both exact statements are saved before publication. This does not establish current keeper authority on the node.`, confirmLabel: 'Sign and retain both statements', isCurrent: current })) return
    await this.#work(async () => { const prepared = this.#active(this.#active(await this.#owner.prepareKeeperPermission(route, device, seconds, current))); if (current()) { await this.#refreshPermissions(); this.#select('permission-choice').value = prepared.grant; this.#renderPermissionReview(); this.#status('Both exact statements retained. Nothing is installed until the selected node acknowledges installation.') } })
  }
  async #publishPermission(revoke: boolean) {
    const r = this.#selectedPermission(), route = this.#select('route').value, current = this.#selectionCurrent(this.#epoch, route)
    if (!r || r.box.routeId !== route) { this.#status('Select the saved route retained for this permission.'); return }
    if (!await confirmAction({ title: revoke ? 'Publish terminal keeper permission revocation?' : 'Install this exact keeper permission?', message: `Issuer ${r.keeper}; transmitting device ${r.device}; node ${r.node}; grant ${r.grant}; revision ${r.revision}. The node receives this identity link, grant, expiry and timing. Link relays observe timing and volume. ${revoke ? 'Terminal intent is retained before publication and cannot reactivate this grant.' : 'Only the node can accept current keeper authority; no ACK means unknown.'}`, confirmLabel: revoke ? 'Revoke exact saved permission' : 'Install exact saved permission', danger: revoke, isCurrent: current })) return
    this.#input('permission-export').value = ''
    await this.#work(async () => {
      try { this.#active(this.#active(await this.#owner.publishKeeperPermission(r.grant, r.revision, revoke, current))); if (current()) { await this.#refreshPermissions(); this.#status('Node acknowledgement retained for the exact saved statement.') } }
      catch (error) { if (current()) { await this.#refreshPermissions(); this.#status(`${error instanceof Error ? error.message : 'Publication unconfirmed.'} Exact saved material remains available; no acknowledgement is assumed.`) } }
    })
  }
  #selectedRoom() { return this.#rooms.find(room => room.session === this.#select('room').value) }
  #removalReview(plan: MlsRemovalPlan) {
    return `Remove ${plan.members.length} leaf/leaves for ${plan.kind === 'person' ? 'this person' : 'this device'}. ` +
      plan.grants.map(grant => `Bothy ${short(grant.node)}: ${grant.action}; saved room uses ${grant.rooms.map(room => `${room.name} (${short(room.session)})`).join(', ') || 'none'}.`).join(' ') +
      (plan.grants.length ? '' : ' No keeper-issued grant is recorded here; box access cannot be claimed ended.') +
      (plan.compromised ? ' A compromised device holds new sends and Adds until its Remove is witnessed.' : ' Final unused grants have a delivery grace period.') +
      ' The person credential requires a separate observed tombstone.'
  }
  #retireSelection() { this.#epoch++; this.#senderPermission = undefined; this.#text('permission-review').textContent = ''; this.#input('permission-export').value = ''; this.#clearReviews(); void this.#owner.pause().catch(() => {}) }
  #clearReviews() {
    this.#storageReview = undefined; this.#button('storage-approve').disabled = true; this.#memberPlan = undefined; this.#keeperPlan = undefined; for (const key of ['member-confirm','approve','dismiss']) this.#button(key).disabled = true; this.#text('member-review').textContent = ''; this.#text('keeper-review').textContent = ''; this.#text('storage-review').textContent = '' }
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
