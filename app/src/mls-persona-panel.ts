import { BrowserMlsAccount, type MlsAccountContext, type MlsAccountView } from './mls-persona-account.js'
import type { ConsentScope, ConsentPrompt, VaultResult, SignLeafBindingRequest } from './mls-vault.js'
import type { BoxRequest } from './mls-coordinated-vault.js'
import { confirmAction } from './confirm-action.js'
import type { VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'

/** Development-preview controls. Opening reads local state only. Pairing,
 * genesis and every witness exchange require separate explicit actions. */
export class BrowserMlsPanel {
  readonly dialog: HTMLDialogElement
  #generation = 0
  #busy = false
  #consentGeneration = 0
  #idle: Promise<void> = Promise.resolve()
  #last?: MlsAccountView
  constructor(private readonly context: () => MlsAccountContext | undefined,
    private readonly account = new BrowserMlsAccount(context), private readonly root: Document = document,
    private readonly revocationTransport?: () => VmlsRevocationTransport) {
    this.dialog = root.createElement('dialog')
    this.dialog.id = 'mlsWitnessSettings'; this.dialog.className = 'profileSettings'
    this.dialog.setAttribute('aria-labelledby', 'mlsWitnessTitle')
    this.dialog.innerHTML = `
      <div class="profileSettingsHeader"><h2 id="mlsWitnessTitle">MLS restore protection</h2><button id="mlsWitnessClose" type="button">Close</button></div>
      <p class="note">Development preview. This prepares restore protection for this account. Browser MLS rooms are not available yet.</p>
      <p>Account: <span id="mlsWitnessAccount" class="mlsWitnessIdentifier"></span></p>
      <p id="mlsWitnessLocalStatus" role="status"></p>
      <button id="mlsWitnessPrepare" type="button">Prepare this browser</button>
      <fieldset id="mlsWitnessPairFields"><legend>Choose a witness</legend>
        <p>Ask your Bothy keeper for a witness-only pairing code. This uses a separate connection identity for this account. Link relays can observe connection timing and volume.</p>
        <label>Link relay addresses <input id="mlsWitnessRelays" type="text" autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
        <p class="note">Use the relay addresses supplied by your keeper, separated by spaces.</p>
        <label>Witness pairing code <input id="mlsWitnessCode" type="password" autocomplete="off" spellcheck="false" maxlength="10000" placeholder="bothy:…"></label>
        <button id="mlsWitnessPair" type="button">Pair witness</button>
      </fieldset>
      <p id="mlsWitnessIdentity" class="mlsWitnessIdentifier"></p>
      <button id="mlsWitnessGenesis" type="button">Prepare keeper enrolment</button>
      <div id="mlsWitnessEnrolment" hidden><p>Ask the keeper to run this on the paired Bothy. Saving this command does not enrol you there.</p>
        <label>Keeper enrolment command <textarea id="mlsWitnessCommand" readonly rows="5" spellcheck="false"></textarea></label>
        <button id="mlsWitnessCopy" type="button">Copy enrolment command</button>
      </div>
      <button id="mlsWitnessCheck" type="button">Check witness now</button>
      <p id="mlsWitnessNetworkStatus" class="note" role="status"></p>
      <fieldset id="mlsWitnessVaultFields"><legend>MLS device and permissions</legend>
        <p>Check the saved device with your witness before making changes. Creating a device asks your account signer for a credential valid for 30 days.</p>
        <button id="mlsWitnessVaultRead" type="button">Check MLS device</button>
        <p id="mlsWitnessDevice" class="mlsWitnessIdentifier" role="status"></p>
        <div id="mlsWitnessDeviceChoice" hidden>
          <p>Choose explicitly. Migration retains an existing preview device and freezes its old vault. Creating a new device leaves any legacy ciphertext untouched and does not transfer its permissions.</p>
          <button id="mlsWitnessDeviceNew" type="button">Create new MLS device</button>
          <button id="mlsWitnessDeviceMigrate" type="button">Migrate existing preview device</button>
        </div>
        <button id="mlsWitnessDeviceReplace" type="button">Replace MLS device</button>
        <button id="mlsWitnessDeviceRevoke" type="button">Revoke device credential</button>
        <p>Signing permissions apply only to the account, device, app and Bothy shown in each request. Room signing and box authentication require separate approval.</p>
        <label>Bothy node identifier <input id="mlsWitnessPermissionBox" autocomplete="off" spellcheck="false" maxlength="64"></label>
        <label>Permission <select id="mlsWitnessPermissionMethod"><option value="signLeafBindingV1/1">MLS leaf binding</option><option value="signBoxRequestV1/1">Box authentication</option></select></label>
        <button id="mlsWitnessPermissionApprove" type="button">Review permission</button>
        <div id="mlsWitnessPermissions"></div>
      </fieldset>
      <fieldset id="mlsWitnessRevocationFields"><legend>Lost or compromised devices</legend>
        <p>Check retained requests with the witness, even when this browser no longer has a device in the room. Only your previously observed devices and their authenticated keepers appear here.</p>
        <button id="mlsWitnessRevocationRead" type="button">Check retained requests</button>
        <div id="mlsWitnessRevocations" role="status" aria-live="polite"></div>
      </fieldset>
      <details id="mlsWitnessRecovery"><summary>Clear and recovery</summary>
        <p>Clearing destroys this installation’s MLS keys and messages. It does not retire its registration on Bothy. A known retirement duty is retained until it can finish.</p>
        <button id="mlsWitnessClear" type="button" class="danger">Clear local MLS keys</button>
        <p id="mlsWitnessRetirement" class="mlsWitnessIdentifier"></p>
        <fieldset id="mlsWitnessKeeperFields"><legend>Keeper-confirmed retirement</legend>
          <p>First ask the keeper to retire the old subject on Bothy. This confirmation is your assertion, not a signed receipt, and cannot override a retained retirement duty.</p>
          <label>Exact retired subject <input id="mlsWitnessRetiredSubject" autocomplete="off" spellcheck="false" maxlength="64"></label>
          <label><input id="mlsWitnessRetiredAcknowledged" type="checkbox"> The keeper has retired this exact subject on Bothy.</label>
          <button id="mlsWitnessConfirmRetired" type="button">Confirm keeper retirement</button>
        </fieldset>
      </details>`
    root.body.append(this.dialog)
    this.account.listen(() => { void this.invalidate().catch(() => undefined) })
    this.button('Close').onclick = () => { void this.invalidate().catch(() => undefined) }
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); void this.invalidate().catch(() => undefined) })
    // close is queued by the browser. An old close event must not reset a
    // newly reopened panel while it is waiting for previous work to finish.
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) void this.invalidate(false).catch(() => undefined) })
    this.button('Prepare').onclick = () => { void this.#run(() => this.account.prepare()) }
    this.button('Pair').onclick = () => {
      const input = this.input('Code'), code = input.value.trim(); input.value = ''
      const relays = this.input('Relays').value.trim().split(/\s+/).filter(Boolean)
      void this.#run(() => this.account.pair(code, relays))
    }
    this.button('Genesis').onclick = () => { void this.#run(() => this.account.genesis()) }
    this.button('PermissionApprove').onclick = () => { void this.#run(async () => {
      const saved = this.#last?.vault, device = saved?.ok ? saved.value?.device : undefined
      const homeBox = this.input('PermissionBox').value.trim()
      if (!device || !/^[0-9a-f]{64}$/.test(homeBox)) throw new VaultActionError('Enter the exact 64-character lowercase Bothy node identifier supplied by its keeper.')
      const method = (this.el('PermissionMethod') as HTMLSelectElement).value as ConsentScope['method']
      return this.#afterVault(await this.account.approveScope({ principal: location.origin, persona: device.persona, device: device.device, homeBox, method }, this.consent))
    }) }
    this.button('VaultRead').onclick = () => { void this.#run(() => this.account.vaultState()) }
    this.button('RevocationRead').onclick = () => { void this.#run(() => this.account.revocationRecords()) }
    for (const action of ['New', 'Migrate', 'Replace', 'Revoke'] as const) {
      this.button(`Device${action}`).onclick = () => { void this.#run(async current => {
        const saved = this.#last?.vault, device = saved?.ok ? saved.value?.device : undefined
        if ((action === 'Replace' || action === 'Revoke') && !device) return undefined
        const message = action === 'Migrate' ? 'Move the existing preview device into this witnessed installation. Its old vault will be frozen and retained. A missing legacy device will refuse; it will not create a replacement.'
          : action === 'Revoke' ? `Revoke this credential: ${device!.credentialId}. This device will no longer sign MLS requests.`
            : action === 'Replace' ? `Retire device ${device!.device} and create a new device with a 30-day credential. Its old signing permissions will not transfer.`
              : 'Create a new MLS device with a 30-day credential signed by this account. Any existing legacy vault is retained without migration.'
        if (!await this.#confirm(`Device${action}`, message, current, action === 'Revoke' || action === 'Replace')) return undefined
        const answer = action === 'Migrate' ? await this.account.migrateDevice()
          : action === 'Revoke' ? await this.account.revokeCredential(device!.credentialId)
            : await this.account.enrolDevice(Math.floor(Date.now() / 1000) + 30 * 86400, action === 'Replace', device?.device)
        return this.#afterVault(answer)
      }) }
    }
    this.button('Check').onclick = () => { void this.#run(() => this.account.check()) }
    this.button('Clear').onclick = () => { void this.#run(async current => {
      const installation = this.#installation()
      if (!installation) throw new Error('missing-installation')
      if (!await confirmAction({ title: 'Clear this account’s MLS keys?', message: 'This destroys local MLS messages and keys for this installation. It cannot be undone. The keeper may need to retire its subject on Bothy before you can prepare a replacement.', confirmLabel: 'Clear MLS keys', danger: true, isCurrent: current })) return undefined
      return this.account.clear(installation)
    }) }
    this.button('ConfirmRetired').onclick = () => { void this.#run(async current => {
      const subject = this.input('RetiredSubject').value.trim()
      if (!/^[0-9a-f]{64}$/.test(subject) || !this.input('RetiredAcknowledged').checked) throw new Error('retirement-input')
      if (!await confirmAction({ title: 'Confirm keeper retirement?', message: `Confirm only if the keeper retired this exact subject on Bothy:\n${subject}\n\nThis permits a fresh local installation when no retirement duty remains.`, confirmLabel: 'Confirm retirement', isCurrent: current })) return undefined
      return this.account.confirmRetired(subject)
    }) }
    this.button('Copy').onclick = () => { void this.#run(async current => {
      const value = await this.account.state()
      if (current() && value.enrolment.state === 'genesis') {
        try { await navigator.clipboard.writeText(value.enrolment.command) } catch { /* the freshly read command stays selectable */ }
      }
      return value
    }) }
    this.#reset()
  }
  async open(): Promise<void> {
    const generation = ++this.#generation
    this.#reset(); if (!this.dialog.open) this.dialog.showModal()
    if (this.#busy) this.message('Waiting for the previous operation to finish…')
    await this.#idle
    if (!this.dialog.open || generation !== this.#generation) return
    this.el('Account').textContent = this.context()?.persona ?? 'Not signed in'
    await this.#run(() => this.account.state())
  }
  /** Call before account or room/privacy transitions and on pagehide. Clear
   * displayed identifiers and pairing capabilities immediately, before await. */
  async invalidate(close = true): Promise<void> {
    this.#generation++; this.#consentGeneration++
    const prompt = this.root.getElementById('actionDialog') as HTMLDialogElement | null
    if (prompt?.dataset.mlsConsent === 'true') prompt.close('cancel')
    this.#reset()
    if (close && this.dialog.open) this.dialog.close()
    await this.account.pause()
  }
  async #run(work: (current: () => boolean) => Promise<MlsAccountView | undefined>): Promise<void> {
    if (this.#busy || !this.dialog.open) return
    const generation = this.#generation, context = this.context()
    let idle!: () => void
    this.#idle = new Promise<void>(resolve => { idle = resolve })
    const current = () => {
      const now = this.context()
      return this.dialog.open && generation === this.#generation && now?.persona === context?.persona && now?.generation === context?.generation && now?.mode === context?.mode
    }
    this.#busy = true; this.#controls(); this.message('Working…')
    try {
      const value = await work(current)
      if (!current()) return
      if (value) {
        const changed = this.#last?.enrolment.state !== value.enrolment.state
        this.#last = value; this.#render(value)
        if (changed) this.dialog.scrollTop = 0
      } else this.message('Cancelled. Local state was not changed by this action.')
    } catch (error) {
      if (current()) this.message(error instanceof VaultActionError ? error.message : error instanceof Error && error.message === 'retirement-input' ? 'Enter the exact subject and confirm that the keeper retired it.'
        : !context ? 'Sign in before opening MLS witness settings.'
          : context.mode !== 'normal' ? 'Witness connections are held in quiet and Tor-only modes. Leave that mode before connecting.'
            : 'The operation could not be confirmed. Reopen these settings to read the saved state.')
    } finally {
      this.#busy = false
      if (current()) this.#controls()
      else if (generation === this.#generation) await this.invalidate().catch(() => undefined)
      idle()
    }
  }
  #render(value: MlsAccountView): void {
    const state = value.enrolment
    this.el('LocalStatus').textContent = state.state === 'empty' ? 'No MLS installation is prepared for this account.'
      : state.state === 'prepared' ? 'Installation prepared locally. Pair a witness to continue.'
        : state.state === 'paired' ? 'Witness paired. Prepare the enrolment command for its keeper.'
          : state.state === 'genesis' ? 'Enrolment prepared and saved locally. Check the witness after the keeper enrols it.'
            : state.state === 'fenced' ? 'This installation is fenced. Use recovery below; it cannot resume MLS operations.'
              : 'The account or mode changed. Reopen these settings.'
    this.el('Identity').textContent = 'witness' in state ? `Paired witness: ${state.witness}` : ''
    this.el('Enrolment').hidden = state.state !== 'genesis'
    ;(this.el('Command') as HTMLTextAreaElement).value = state.state === 'genesis' ? state.command : ''
    const check = value.check
    this.message(!check ? 'Local state shown. Use Check witness now for a fresh confirmation.'
      : check.state === 'active' ? 'The witness confirmed this stored state just now. Every MLS change still needs a fresh check.'
        : check.state === 'fenced' ? check.retiring ? 'A retirement duty remains. Keep this installation until a fresh witness check finishes it; Clear removes message keys while retaining that duty.' : value.retirement ? 'This installation remains fenced. The keeper must retire its exact subject before replacement.' : 'Local state cannot be verified. Restore its sealed record before attempting replacement.'
          : check.reason === 'not-enrolled' ? 'No enrolled installation is available. Prepare one explicitly.'
            : check.refused ? 'The witness refused this subject or writer. Ask the keeper to check the registration; no replacement was created.'
              : 'The witness could not confirm the state. It remains held; retry when the witness is available.')
    const vault = value.vault
    this.el('Device').textContent = !vault ? 'Device not checked in this view.' : !vault.ok ? vaultMessage(vault.refusal)
      : !vault.value ? 'No coordinated device exists. Choose migration or a new device below.'
        : `Device: ${vault.value.device.device}\nCredential: ${vault.value.device.credentialId}\nExpires: ${new Date(vault.value.device.credentialExpiresAt * 1000).toISOString()}${vault.value.revoked ? '\nCredential revoked.' : ''}`
    this.el('Permissions').replaceChildren()
    if (vault?.ok && vault.value) for (const scope of vault.value.approved) {
      const row = this.root.createElement('p'), label = this.root.createElement('span'), button = this.root.createElement('button')
      label.className = 'mlsWitnessIdentifier'
      label.textContent = `${scope.method === 'signBoxRequestV1/1' ? 'Box authentication' : 'MLS leaf binding'} — Bothy ${scope.homeBox} — app ${scope.principal}`
      button.type = 'button'; button.textContent = 'Withdraw permission'
      button.onclick = () => { void this.#run(async current => {
        if (!await this.#confirm('Withdraw permission', this.#scopeText(scope), current, true)) return undefined
        return this.#afterVault(await this.account.withdraw(scope))
      }) }
      row.append(label, button); this.el('Permissions').append(row)
    }
    const retirement = value.retirement
    this.el('Retirement').textContent = !retirement ? '' : retirement.verified
      ? `Old subject from sealed state: ${retirement.subject}`
      : `Recorded old subject: ${retirement.subject}. Its seal is unavailable. Confirm it independently with the keeper before retirement.`
    this.input('RetiredSubject').value = ''; this.input('RetiredAcknowledged').checked = false
    this.#renderRevocations(value)
    if (this.context()?.mode !== 'normal') this.message(`${this.el('NetworkStatus').textContent} Witness connections are held in quiet and Tor-only modes.`)
  }
  #controls(): void {
    const state = this.#last?.enrolment.state, mode = this.context()?.mode, busy = this.#busy
    const disabled: Record<string, boolean> = {
      Prepare: state !== 'empty', Pair: state !== 'prepared' && state !== 'paired', Genesis: state !== 'paired',
      Check: state !== 'genesis' && state !== 'fenced', Clear: !this.#installation(),
      Copy: state !== 'genesis', ConfirmRetired: state !== 'fenced' || !this.#last?.retirement || this.#last?.check?.state !== 'fenced' || this.#last.check.retiring,
    }
    const vault = this.#last?.vault, device = vault?.ok ? vault.value : undefined
    Object.assign(disabled, { VaultRead: state !== 'genesis', DeviceNew: !vault?.ok || vault.value !== null,
      DeviceMigrate: !vault?.ok || vault.value !== null, DeviceReplace: !device,
      DeviceRevoke: !device || device.revoked, PermissionApprove: !device || device.revoked || device.device.credentialExpiresAt <= Math.floor(Date.now() / 1000) })
    this.fieldset('VaultFields').hidden = state !== 'genesis'
    this.fieldset('VaultFields').disabled = busy || mode !== 'normal'
    this.fieldset('RevocationFields').hidden = state !== 'genesis'
    this.fieldset('RevocationFields').disabled = busy || mode !== 'normal'
    this.el('DeviceChoice').hidden = !vault?.ok || vault.value !== null
    this.button('DeviceReplace').hidden = !device; this.button('DeviceRevoke').hidden = !device
    for (const [name, off] of Object.entries(disabled)) this.button(name).disabled = busy || off || (['Pair', 'Check'].includes(name) && mode !== 'normal')
    this.fieldset('PairFields').disabled = busy || (state !== 'prepared' && state !== 'paired') || mode !== 'normal'
    this.fieldset('KeeperFields').disabled = this.button('ConfirmRetired').disabled
    this.button('Prepare').hidden = state !== 'empty'
    this.fieldset('PairFields').hidden = state !== 'prepared' && state !== 'paired'
    this.button('Genesis').hidden = state !== 'paired'
    this.button('Check').hidden = state !== 'genesis' && state !== 'fenced'
    this.el('Recovery').hidden = !state || state === 'empty' || state === 'stale'
  }
  #renderRevocations(value: MlsAccountView): void {
    const root = this.el('Revocations'), result = value.revocations
    root.replaceChildren()
    const message = (text: string) => { const p = this.root.createElement('p'); p.textContent = text; return p }
    if (!result) { root.append(message('Retained requests have not been checked in this view.')); return }
    if (result.state !== 'active') {
      root.append(message(result.state === 'fenced' ? 'Saved requests could not be verified. Use the installation recovery controls.'
        : 'The witness has not confirmed the retained requests. Check again when it is available.')); return
    }
    if (!result.value.length) { root.append(message('No retained device requests are recorded for this account.')); return }
    for (const record of result.value) {
      const article = this.root.createElement('article')
      article.className = 'mlsWitnessIdentifier'
      article.dataset.mlsStandaloneRequest = record.operation
      article.append(message(`Device: ${record.device}`), message(`Keeper: ${record.keeper}`),
        message(`Observed room hints: ${record.sessions.join(', ')}`), message(`Observed box hints: ${record.boxes.join(', ')}`))
      if (record.sentAt !== null) article.append(message('Request sent to a keeper relay. Keeper receipt, removal and grant revocation are unconfirmed.'))
      else {
        article.append(message('Ask this keeper to remove your lost or compromised device and revoke its grants now. Room and box hints are retained observations; the keeper must check its current ledger. Public DM relays can see the recipient, your connection address, timing and volume. Sending does not prove that the keeper read or performed the request.'))
        const button = this.root.createElement('button')
        button.type = 'button'; button.textContent = 'Send request to keeper'
        button.disabled = !this.revocationTransport || !this.context()?.revocationIdentity
        button.onclick = () => { void this.#run(() => {
          if (!this.revocationTransport) throw new VaultActionError('No keeper relay transport is available.')
          return this.account.sendRevocation(record.operation, this.revocationTransport())
        }) }
        article.append(button)
        if (!this.context()?.revocationIdentity) article.append(message('Connect this account’s signer with private-message encryption before sending.'))
      }
      root.append(article)
    }
  }
  #installation(): string | undefined {
    const state = this.#last?.enrolment
    return state && 'installation' in state ? state.installation : this.#last?.installation
  }
  #reset(): void {
    this.el('Revocations').replaceChildren()
    this.#last = undefined
    for (const name of ['Account', 'LocalStatus', 'Identity', 'NetworkStatus', 'Retirement', 'Device', 'Permissions']) this.el(name).textContent = ''
    for (const name of ['Code', 'Relays', 'RetiredSubject', 'PermissionBox']) this.input(name).value = ''
    ;(this.el('Command') as HTMLTextAreaElement).value = ''; this.input('RetiredAcknowledged').checked = false
    this.el('Enrolment').hidden = true; (this.el('Recovery') as HTMLDetailsElement).open = false
    this.#controls()
  }
  #scopeText(scope: ConsentScope): string {
    return `App: ${scope.principal}\nAccount: ${scope.persona}\nDevice: ${scope.device}\nBothy: ${scope.homeBox}\nPermission: ${scope.method === 'signBoxRequestV1/1' ? 'Authenticate contracted MLS requests to this box' : 'Sign MLS leaf bindings for this box'}\n\nApproval is saved with the witness and can be withdrawn here.`
  }
  async #confirm(name: string, message: string, current: () => boolean, danger = false): Promise<boolean> {
    const generation = this.#consentGeneration
    const answer = confirmAction({ title: name.startsWith('Device') ? this.button(name).textContent! : name, message,
      confirmLabel: danger ? 'Confirm' : 'Continue', danger, isCurrent: () => generation === this.#consentGeneration && current() })
    // Tag only the prompt created for this request, after the shared queue has
    // mounted it. Its isCurrent guard also protects a request still queued.
    const observer = new MutationObserver(() => {
      const dialog = this.root.getElementById('actionDialog')
      if (dialog?.querySelector('#actionDescription')?.textContent === message) dialog.dataset.mlsConsent = 'true'
    })
    observer.observe(this.root.body, { childList: true })
    try { return await answer } finally { observer.disconnect() }
  }
  readonly consent: ConsentPrompt = async scope => {
    const context = this.context(), generation = this.#generation
    const current = () => this.dialog.open && generation === this.#generation && this.context()?.persona === context?.persona && this.context()?.generation === context?.generation && this.context()?.mode === 'normal'
    return await this.#confirm('Allow MLS signing?', this.#scopeText(scope), current) ? 'approve' : 'deny'
  }
  /** The future room adapter uses the same scoped prompt; no arbitrary event
   * signing or standalone-vault fallback is exposed by the panel. */
  signLeafBinding(request: SignLeafBindingRequest) { return this.account.signLeafBinding(request, this.consent) }
  signBoxRequest(request: BoxRequest) { return this.account.signBoxRequest(request, this.consent) }
  async #afterVault(answer: VaultResult<unknown>): Promise<MlsAccountView> {
    if (!answer.ok) throw new VaultActionError(vaultMessage(answer.refusal))
    return this.account.vaultState()
  }
  private el(name: string): HTMLElement { return this.root.getElementById(`mlsWitness${name}`)! }
  private button(name: string): HTMLButtonElement { return this.el(name) as HTMLButtonElement }
  private input(name: string): HTMLInputElement { return this.el(name) as HTMLInputElement }
  private fieldset(name: string): HTMLFieldSetElement { return this.el(name) as HTMLFieldSetElement }
  private message(text: string): void { this.el('NetworkStatus').textContent = text }
}

class VaultActionError extends Error {}
function vaultMessage(refusal: string): string {
  return refusal === 'witness-pending' ? 'The witness has not confirmed this action. Check the MLS device again when it is available; a pending change may already be saved.'
    : refusal === 'restore-fenced' ? 'Saved MLS state could not be verified. Recheck this installation and any legacy source before recovery; no replacement was created.'
      : refusal === 'stale' ? 'The account, mode or device changed. Reopen these settings.'
        : refusal === 'denied' ? 'The signer or consent request was declined.'
          : refusal === 'unauthorised' ? 'No eligible device or signer was available for this action. Check the saved device; no fallback was used.'
            : `The MLS action was refused (${refusal}). Check the device before retrying.`
}
