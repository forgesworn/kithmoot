import { BrowserMlsAccount, type MlsAccountContext, type MlsAccountView } from './mls-persona-account.js'
import { confirmAction } from './confirm-action.js'

/** Development-preview controls. Opening reads local state only. Pairing,
 * genesis and every witness exchange require separate explicit actions. */
export class BrowserMlsPanel {
  readonly dialog: HTMLDialogElement
  #generation = 0
  #busy = false
  #idle: Promise<void> = Promise.resolve()
  #last?: MlsAccountView
  constructor(private readonly context: () => MlsAccountContext | undefined,
    private readonly account = new BrowserMlsAccount(context), private readonly root: Document = document) {
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
    this.#generation++; this.#reset()
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
      if (current()) this.message(error instanceof Error && error.message === 'retirement-input' ? 'Enter the exact subject and confirm that the keeper retired it.'
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
    const retirement = value.retirement
    this.el('Retirement').textContent = !retirement ? '' : retirement.verified
      ? `Old subject from sealed state: ${retirement.subject}`
      : `Recorded old subject: ${retirement.subject}. Its seal is unavailable. Confirm it independently with the keeper before retirement.`
    this.input('RetiredSubject').value = ''; this.input('RetiredAcknowledged').checked = false
    if (this.context()?.mode !== 'normal') this.message(`${this.el('NetworkStatus').textContent} Witness connections are held in quiet and Tor-only modes.`)
  }
  #controls(): void {
    const state = this.#last?.enrolment.state, mode = this.context()?.mode, busy = this.#busy
    const disabled: Record<string, boolean> = {
      Prepare: state !== 'empty', Pair: state !== 'prepared' && state !== 'paired', Genesis: state !== 'paired',
      Check: state !== 'genesis' && state !== 'fenced', Clear: !this.#installation(),
      Copy: state !== 'genesis', ConfirmRetired: state !== 'fenced' || !this.#last?.retirement || this.#last?.check?.state !== 'fenced' || this.#last.check.retiring,
    }
    for (const [name, off] of Object.entries(disabled)) this.button(name).disabled = busy || off || (['Pair', 'Check'].includes(name) && mode !== 'normal')
    this.fieldset('PairFields').disabled = busy || (state !== 'prepared' && state !== 'paired') || mode !== 'normal'
    this.fieldset('KeeperFields').disabled = this.button('ConfirmRetired').disabled
    this.button('Prepare').hidden = state !== 'empty'
    this.fieldset('PairFields').hidden = state !== 'prepared' && state !== 'paired'
    this.button('Genesis').hidden = state !== 'paired'
    this.button('Check').hidden = state !== 'genesis' && state !== 'fenced'
    this.el('Recovery').hidden = !state || state === 'empty' || state === 'stale'
  }
  #installation(): string | undefined {
    const state = this.#last?.enrolment
    return state && 'installation' in state ? state.installation : this.#last?.installation
  }
  #reset(): void {
    this.#last = undefined
    for (const name of ['Account', 'LocalStatus', 'Identity', 'NetworkStatus', 'Retirement']) this.el(name).textContent = ''
    for (const name of ['Code', 'Relays', 'RetiredSubject']) this.input(name).value = ''
    ;(this.el('Command') as HTMLTextAreaElement).value = ''; this.input('RetiredAcknowledged').checked = false
    this.el('Enrolment').hidden = true; (this.el('Recovery') as HTMLDetailsElement).open = false
    this.#controls()
  }
  private el(name: string): HTMLElement { return this.root.getElementById(`mlsWitness${name}`)! }
  private button(name: string): HTMLButtonElement { return this.el(name) as HTMLButtonElement }
  private input(name: string): HTMLInputElement { return this.el(name) as HTMLInputElement }
  private fieldset(name: string): HTMLFieldSetElement { return this.el(name) as HTMLFieldSetElement }
  private message(text: string): void { this.el('NetworkStatus').textContent = text }
}
