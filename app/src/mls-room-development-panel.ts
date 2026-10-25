import { BrowserMlsRoomDevelopmentOwner, type MlsRoomDevelopmentContext } from './mls-room-development-owner.js'
import type { MlsRoomForegroundResult } from './mls-room-foreground.js'
import { invitationPreviewEnabled } from './mls-invitation-engine.js'
import { base64Encode, base64Decode } from './mls-vault.js'
import { addReveal } from './reveal.js'

/** Explicit development-only room custody controls. Opening performs no I/O;
 * creation and a single manual round have explicit private-route ceremonies.
 * Experimental joining uses a separately gated trusted private ceremony. */
export class BrowserMlsRoomDevelopmentPanel {
  readonly dialog: HTMLDialogElement
  readonly #owner: BrowserMlsRoomDevelopmentOwner
  #epoch = 0
  #busy = false
  constructor(private readonly context: () => MlsRoomDevelopmentContext | undefined, private readonly root: Document = document) {
    this.#owner = new BrowserMlsRoomDevelopmentOwner(context, root)
    if (import.meta.env.DEV && import.meta.env.VITE_MIXED_INVITATION_LAB === 'true') void import('./mls-mixed-invitation-lab.js').then(m => m.captureRoomOwner(this.#owner))
    this.dialog = root.createElement('dialog'); this.dialog.id = 'mlsRoomDevelopment'; this.dialog.className = 'profileSettings'
    this.dialog.setAttribute('aria-labelledby', 'mlsRoomDevelopmentTitle')
    this.dialog.innerHTML = `<div class="profileSettingsHeader"><h2 id="mlsRoomDevelopmentTitle">MLS room connection</h2><button data-close type="button">Close</button></div>
      <p class="note">Development preview. Production MLS is unavailable. Creation saves a local witnessed room. One explicit manual round processes its retained work; An experimental private invitation workflow is available only with its separate development flag.</p>
      <p>Account: <span data-account></span></p><p data-status role="status" aria-live="polite"></p>
      <fieldset><legend>Dedicated room connection</legend><p>This connection has its own saved routes. Link relays can observe connection timing and volume.</p>
      <label>Link relay addresses <input data-relays autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
      <label>Room pairing code <input data-code type="password" autocomplete="off" maxlength="32768"></label>
      <button data-pair type="button">Pair room connection</button><button data-routes type="button">Read saved room routes</button><div data-route-list></div></fieldset>
      <fieldset data-bark-provision><legend>Bark rendezvous device</legend><p>After witness enrolment, ask Bark for a root-derived child encrypted to this browser’s protected dedicated target key. The signer must approve this exact target, index and expiry. The current child remains usable only until that bounded expiry.</p>
      <label>Rendezvous index <input data-bark-index type="number" min="0" max="4294967295" value="0"></label><button data-bark-provision-button type="button">Review Bark device provisioning</button><p data-bark-device></p></fieldset>
      <fieldset><legend>Create a local MLS room</legend><p>Prepare and enrol your MLS device in witness settings and provision this browser’s rendezvous child through Bark or its retained bunker ceremony first. Creation authenticates the selected Bothy installation twice. It does not deliver messages.</p>
      <label>Saved room route <select data-create-route><option value="">Read saved routes first</option></select></label>
      <label>Room name <input data-create-name maxlength="120" autocomplete="off"></label>
      <label>Binding lifetime in days <input data-create-days type="number" min="1" max="30" value="7"></label>
      <label data-invitation-toggle hidden><input data-create-invitation type="checkbox"> Experimental invitation/1 profile (all current members may Add and Remove)</label>
      <button data-create type="button">Create local MLS room</button></fieldset>
      <fieldset><legend>Saved MLS rooms</legend><button data-rooms type="button">Check saved MLS rooms</button><div data-room-list></div></fieldset>
      <fieldset><legend>One manual delivery round</legend><p>Select this room’s exact home-box route. A round retains uncertain work and holds other destinations. It does not run again automatically.</p>
      <label>Saved room <select data-manual-room><option value="">Check saved rooms first</option></select></label>
      <label>Saved room route <select data-manual-route><option value="">Read saved routes first</option></select></label>
      <button data-manual type="button">Run one manual round</button></fieldset>
      <fieldset data-invitation-controls hidden><legend>Experimental private invitations</legend>
      <p>Unallocated development profile. Use an authenticated private conversation with the intended person. Paste, QR scanning and operator authentication alone do not authenticate the inviter. Keep these private bytes out of links, public tags, directories and relays. Keeper package registration requires separate node permission. This preview uses one exact paired home box.</p>
      <label>Saved exact room route <select data-invite-route><option value="">Read saved routes first</option></select></label>
      <label>Saved experimental room <select data-invite-room><option value="">Check saved rooms first</option></select></label>
      <label>Intended person's public key <input data-target-persona autocomplete="off" spellcheck="false" maxlength="64"></label>
      <label>Intended enrolled device <input data-target-device autocomplete="off" spellcheck="false" maxlength="64"></label>
      <label>Intended rendezvous key <input data-target-rz autocomplete="off" spellcheck="false" maxlength="64"></label>
      <label>Intended leaf home node <input data-target-home autocomplete="off" spellcheck="false" maxlength="64"></label>
      <label>Invitation lifetime (hours, at most 168) <input data-invite-hours type="number" min="1" max="168" value="24"></label>
      <button data-issue-invitation type="button">Review and issue private invitation</button><button data-export-invitation type="button">Recover last saved invitation</button>
      <label>Private invitation bytes <textarea data-private-invitation autocomplete="off" spellcheck="false" maxlength="16384"></textarea></label>
      <label>Expected inviter from your trusted private contact (enter independently) <input data-expected-inviter autocomplete="off" spellcheck="false" maxlength="64"></label>
      <label>Local joined room name <input data-join-name autocomplete="off" maxlength="120"></label>
      <button data-accept-invitation type="button">Review trusted inviter and accept privately</button><button data-recover-response type="button">Recover exact saved response</button>
      <label>Private response envelope <textarea data-private-response autocomplete="off" spellcheck="false" maxlength="1450000"></textarea></label>
      <button data-record-response type="button">Record exact response with witness</button>
      <p>After recording, a separately authorised keeper may register the package and a current member may propose Add. This does not grant keeper rights to members.</p>
      <button data-export-registration type="button">Export private package registration request</button>
      <label>Private package request (for a separately authorised keeper) <textarea data-private-registration autocomplete="off" spellcheck="false" maxlength="184"></textarea></label>
      <button data-keeper-register type="button">Register package as the selected node’s keeper</button>
      <label>Private node-signed registration receipt <textarea data-registration-receipt autocomplete="off" spellcheck="false" maxlength="268"></textarea></label>
      <button data-add-response type="button">Verify keeper receipt and propose member Add</button>
      <label>Message <input data-message autocomplete="off" maxlength="4096"></label><button data-update-invitation-room type="button">Sign required Update</button><button data-send-invitation-room type="button">Queue message</button>
      <button data-read-invitation-room type="button">Read saved messages and members</button><pre data-invitation-view></pre>
      <label>Leaf to remove <input data-remove-leaf autocomplete="off" spellcheck="false" maxlength="64"></label><button data-remove-invitation-member type="button">Remove selected member</button>
      <p>Run explicit manual rounds for Commit, Welcome, Update and message delivery. No automatic round starts here.</p></fieldset>`
    root.body.append(this.dialog)
    this.#text('invitation-toggle').hidden = !invitationPreviewEnabled()
    this.#text('invitation-controls').hidden = !invitationPreviewEnabled()
    addReveal(this.dialog.querySelector<HTMLInputElement>('[data-code]')!, 'pairing code')
    this.#button('bark-provision-button').onclick = () => { void this.#work(async epoch => {
      const index = Number(this.#input('bark-index').value)
      const result = this.#value(await this.#owner.provisionBark(index), epoch)
      this.#text('bark-device').textContent = `Public target: ${result.receipt.device}\nRendezvous: ${result.receipt.rendezvousPubkey}\nIndex: ${result.receipt.index}\nHandoff acceptance deadline: ${new Date(result.receipt.expiresAt * 1000).toISOString()}`
      this.#text('status').textContent = 'The actual encrypted Bark child was installed. Keep the account and foreground current for the bounded room ceremony.'
    }) }
    this.#button('close').onclick = () => this.close()
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) void this.invalidate().catch(() => {}) })
    root.addEventListener('visibilitychange', () => { if (root.visibilityState !== 'visible') void this.invalidate().catch(() => {}) })
    this.#button('routes').onclick = () => { void this.#work(async epoch => {
      const routes = this.#value(await this.#owner.routes(), epoch)
      this.#list('route-list', routes.map(route => route.routeId))
      for (const name of ['create-route', 'manual-route', 'invite-route']) this.#select(name, routes.map(route => ({ value: route.routeId, label: route.routeId })))
      this.#text('status').textContent = `${routes.length} saved room route(s).`
    }) }
    this.#button('pair').onclick = () => {
      const code = this.#input('code').value, relays = this.#input('relays').value.split(/[\s,]+/).filter(Boolean)
      void this.#work(async epoch => {
        this.#value(await this.#owner.pair(code, relays), epoch)
        this.#input('code').value = ''; this.#text('status').textContent = 'Room connection paired. Read its saved routes explicitly.'
      })
    }
    this.#button('rooms').onclick = () => { void this.#work(async epoch => {
      const result = this.#value(await this.#owner.roomChoices(), epoch)
      if (result.state !== 'active') throw new Error(`Saved room check ${result.state}.`)
      this.#list('room-list', result.value.map(room => `${room.name} (${room.session.slice(0, 12)}…)`))
      this.#select('invite-room', result.value.map(room => ({ value: room.session, label: `${room.name} (${room.session.slice(0, 12)}…)` })))
      this.#select('manual-room', result.value.map(room => ({ value: room.session, label: `${room.name} (${room.session.slice(0, 12)}…)` })))
      this.#text('status').textContent = 'Saved rooms checked with the current witness. Select a room and its route for an explicit manual round.'
    }) }
    this.#button('create').onclick = () => {
      const route = (this.#text('create-route') as HTMLSelectElement).value, name = this.#input('create-name').value
      const days = Number(this.#input('create-days').value)
      void this.#work(async epoch => {
        if (!Number.isSafeInteger(days) || days < 1 || days > 30) throw new Error('Choose a binding lifetime between one and thirty days.')
        const result = this.#value(await this.#owner.create(route, name, days * 86400, this.#input('create-invitation').checked), epoch)
        this.#text('status').textContent = result.state === 'saved'
          ? `Room ${result.session.slice(0, 12)}… saved locally with its witness and installation confirmed. Check saved rooms before a manual round.` : result.reason
        if (result.state === 'saved') this.#input('create-name').value = ''
      })
    }
    this.#button('manual').onclick = () => {
      const route = (this.#text('manual-route') as HTMLSelectElement).value, session = (this.#text('manual-room') as HTMLSelectElement).value
      void this.#work(async epoch => {
        const result = this.#value(await this.#owner.manualRound(route, session), epoch)
        this.#text('status').textContent = result.state === 'done'
          ? `Bounded round finished: ${result.resolved} witnessed outbox record(s) resolved, ${result.processed} incoming record(s) processed; ${result.held + result.leafHeld} held.${result.stalled ? ' The round stalled; uncertain records remain retained.' : ''}${result.limited ? ' The node limited requests.' : ''} No further round will run automatically.`
          : result.reason
      })
    }
    const privateBytes = (name: string, max: number) => {
      const value = (this.#text(name) as HTMLTextAreaElement).value.trim()
      if (value.length > max) throw new Error('Private bytes exceed the bounded ceremony size.')
      const decoded = base64Decode(value)
      if (!decoded) throw new Error('Paste the exact base64 bytes exchanged privately.')
      return decoded
    }
    const invitation = (action: any) => { void this.#work(async epoch => {
      const route = (this.#text('invite-route') as HTMLSelectElement).value
      const result = this.#value(await this.#owner.invitation(route, action), epoch)
      if (result.state !== 'active') throw new Error(`Invitation action ${result.state}: ${result.reason ?? 'retained state needs a fresh check'}`)
      const value = result.value
      if (value.authorization) { (this.#text('private-invitation') as HTMLTextAreaElement).value = base64Encode(value.authorization); value.authorization.fill(0) }
      if (value.registrationRequest) { (this.#text('private-registration') as HTMLTextAreaElement).value = base64Encode(value.registrationRequest); value.registrationRequest.fill(0) }
      if (value.registrationReceipt) { (this.#text('registration-receipt') as HTMLTextAreaElement).value = base64Encode(value.registrationReceipt); value.registrationReceipt.fill(0) }
      if (value.response) { (this.#text('private-response') as HTMLTextAreaElement).value = base64Encode(value.response.envelope); value.response.envelope.fill(0) }
      if (value.members || value.history) this.#text('invitation-view').textContent = JSON.stringify({ session: value.session, phase: value.phase, updateRequired: value.updateRequired, members: value.members, history: value.history }, (_key, item) => typeof item === 'bigint' ? String(item) : item instanceof Uint8Array ? new TextDecoder().decode(item) : item, 2)
      this.#text('status').textContent = `Private invitation action saved${value.session ? ` for session ${value.session}` : ''}. Check saved rooms; delivery requires explicit manual rounds.`
    }).finally(() => { if (action.authorization) action.authorization.fill(0); if (action.envelope) action.envelope.fill(0); if (action.receipt) action.receipt.fill(0); if (action.request) action.request.fill(0) }) }
    const selectedRoom = () => (this.#text('invite-room') as HTMLSelectElement).value
    this.#button('issue-invitation').onclick = () => {
      const hours = Number(this.#input('invite-hours').value)
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) { this.#text('status').textContent = 'Choose one to 168 hours covered by the current binding and credential.'; return }
      invitation({ type: 'issue', session: selectedRoom(), target: { persona: this.#input('target-persona').value.trim(), device: this.#input('target-device').value.trim(),
        rendezvous: this.#input('target-rz').value.trim(), leafHome: this.#input('target-home').value.trim(), expiresAt: Math.floor(Date.now() / 1000) + hours * 3600 } })
    }
    this.#button('export-invitation').onclick = () => invitation({ type: 'export', session: selectedRoom() })
    this.#button('recover-response').onclick = () => invitation({ type: 'response', session: selectedRoom() })
    this.#button('accept-invitation').onclick = () => {
      try { invitation({ type: 'accept', authorization: privateBytes('private-invitation', 16384), expectedInviterPersona: this.#input('expected-inviter').value.trim(), name: this.#input('join-name').value.trim() }) }
      catch (error) { this.#text('status').textContent = String(error) }
    }
    for (const [button, type] of [['record-response', 'record'], ['export-registration', 'registration-request']] as const) this.#button(button).onclick = () => {
      try { invitation({ type, session: selectedRoom(), authorization: privateBytes('private-invitation', 16384), envelope: privateBytes('private-response', 1450000) }) }
      catch (error) { this.#text('status').textContent = String(error) }
    }
    this.#button('keeper-register').onclick = () => {
      try { invitation({ type: 'register-package', request: privateBytes('private-registration', 184) }) }
      catch (error) { this.#text('status').textContent = String(error) }
    }
    this.#button('add-response').onclick = () => {
      try { invitation({ type: 'add', session: selectedRoom(), authorization: privateBytes('private-invitation', 16384), envelope: privateBytes('private-response', 1450000), receipt: privateBytes('registration-receipt', 268) }) }
      catch (error) { this.#text('status').textContent = String(error) }
    }
    this.#button('update-invitation-room').onclick = () => invitation({ type: 'update', session: selectedRoom() })
    this.#button('send-invitation-room').onclick = () => invitation({ type: 'send', session: selectedRoom(), text: this.#input('message').value })
    this.#button('read-invitation-room').onclick = () => invitation({ type: 'read', session: selectedRoom() })
    this.#button('remove-invitation-member').onclick = () => invitation({ type: 'remove', session: selectedRoom(), leafId: this.#input('remove-leaf').value.trim() })
  }
  open(): void {
    if (this.root.visibilityState !== 'visible') return
    this.#text('account').textContent = this.context()?.persona ?? 'Sign in first'
    this.#text('status').textContent = 'Choose an explicit action. Opening this panel starts no connection.'
    if (!this.dialog.open) this.dialog.showModal()
  }
  close(): void { void this.invalidate().catch(() => {}) }
  invalidate(): Promise<void> {
    this.#epoch++
    if (this.dialog.open) this.dialog.close()
    for (const name of ['account', 'status', 'route-list', 'room-list', 'bark-device']) this.#text(name).replaceChildren()
    this.#input('code').value = ''; this.#input('relays').value = ''
    this.#input('create-name').value = ''; this.#input('create-days').value = '7'
    this.#input('create-invitation').checked = false
    for (const name of ['target-persona', 'target-device', 'target-rz', 'target-home', 'expected-inviter', 'join-name', 'message', 'remove-leaf']) this.#input(name).value = ''
    for (const name of ['private-invitation', 'private-response', 'private-registration', 'registration-receipt']) (this.#text(name) as HTMLTextAreaElement).value = ''
    this.#text('invitation-view').replaceChildren()
    for (const name of ['create-route', 'manual-route', 'manual-room', 'invite-route', 'invite-room']) this.#text(name).replaceChildren()
    return this.#owner.pause()
  }
  async #work(work: (epoch: number) => Promise<void>): Promise<void> {
    if (this.#busy || !this.dialog.open) return
    const epoch = this.#epoch
    this.#busy = true; this.#text('status').textContent = 'Checking…'
    try { await work(epoch) }
    catch (error) {
      if (epoch === this.#epoch && this.dialog.open) this.#text('status').textContent = error instanceof Error ? error.message : 'This action could not be confirmed.'
    } finally { this.#busy = false }
  }
  #value<T>(result: MlsRoomForegroundResult<T>, epoch: number): T {
    if (epoch !== this.#epoch || !this.dialog.open || this.root.visibilityState !== 'visible' || result.state !== 'done') throw new Error('This workflow was interrupted. Any saved state remains retained; check saved rooms before creating another room.')
    return result.value
  }
  #text(name: string): HTMLElement { return this.dialog.querySelector(`[data-${name}]`)! }
  #input(name: string): HTMLInputElement { return this.#text(name) as HTMLInputElement }
  #button(name: string): HTMLButtonElement { return this.#text(name) as HTMLButtonElement }
  #list(name: string, values: string[]): void {
    this.#text(name).replaceChildren(...values.map(value => { const row = this.root.createElement('p'); row.textContent = value; return row }))
  }
  #select(name: string, values: { value: string; label: string }[]): void {
    this.#text(name).replaceChildren(...values.map(value => { const option = this.root.createElement('option'); option.value = value.value; option.textContent = value.label; return option }))
  }
}
