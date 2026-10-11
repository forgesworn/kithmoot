import { BrowserMlsRoomDevelopmentOwner, type MlsRoomDevelopmentContext } from './mls-room-development-owner.js'
import type { MlsRoomForegroundResult } from './mls-room-foreground.js'

/** Explicit development-only room custody controls. Opening performs no I/O;
 * creation has an explicit private-route ceremony. Join and driver controls
 * remain held until their authenticated ceremonies land. */
export class BrowserMlsRoomDevelopmentPanel {
  readonly dialog: HTMLDialogElement
  readonly #owner: BrowserMlsRoomDevelopmentOwner
  #epoch = 0
  #busy = false
  constructor(private readonly context: () => MlsRoomDevelopmentContext | undefined, private readonly root: Document = document) {
    this.#owner = new BrowserMlsRoomDevelopmentOwner(context, root)
    this.dialog = root.createElement('dialog'); this.dialog.id = 'mlsRoomDevelopment'; this.dialog.className = 'profileSettings'
    this.dialog.setAttribute('aria-labelledby', 'mlsRoomDevelopmentTitle')
    this.dialog.innerHTML = `<div class="profileSettingsHeader"><h2 id="mlsRoomDevelopmentTitle">MLS room connection</h2><button data-close type="button">Close</button></div>
      <p class="note">Development preview. Production MLS is unavailable. Creation saves a local witnessed room; authenticated invitation joining and message delivery remain held.</p>
      <p>Account: <span data-account></span></p><p data-status role="status" aria-live="polite"></p>
      <fieldset><legend>Dedicated room connection</legend><p>This connection has its own saved routes. Link relays can observe connection timing and volume.</p>
      <label>Link relay addresses <input data-relays autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
      <label>Room pairing code <input data-code type="password" autocomplete="off" maxlength="32768"></label>
      <button data-pair type="button">Pair room connection</button><button data-routes type="button">Read saved room routes</button><div data-route-list></div></fieldset>
      <fieldset><legend>Create a local MLS room</legend><p>Prepare and enrol your MLS device in witness settings and provision this bunker browser’s rendezvous child first. Creation authenticates the selected Bothy installation twice. It does not deliver messages.</p>
      <label>Saved room route <select data-create-route><option value="">Read saved routes first</option></select></label>
      <label>Room name <input data-create-name maxlength="120" autocomplete="off"></label>
      <label>Binding lifetime in days <input data-create-days type="number" min="1" max="30" value="7"></label>
      <button data-create type="button">Create local MLS room</button></fieldset>
      <fieldset><legend>Saved MLS rooms</legend><button data-rooms type="button">Check saved MLS rooms</button><div data-room-list></div></fieldset>`
    root.body.append(this.dialog)
    this.#button('close').onclick = () => this.close()
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) void this.invalidate().catch(() => {}) })
    root.addEventListener('visibilitychange', () => { if (root.visibilityState !== 'visible') void this.invalidate().catch(() => {}) })
    this.#button('routes').onclick = () => { void this.#work(async epoch => {
      const routes = this.#value(await this.#owner.routes(), epoch)
      this.#list('route-list', routes.map(route => route.routeId))
      const select = this.#text('create-route') as HTMLSelectElement
      select.replaceChildren(...routes.map(route => { const option = this.root.createElement('option'); option.value = route.routeId; option.textContent = route.routeId; return option }))
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
      this.#text('status').textContent = 'Saved rooms checked with the current witness. Message delivery remains held.'
    }) }
    this.#button('create').onclick = () => {
      const route = (this.#text('create-route') as HTMLSelectElement).value, name = this.#input('create-name').value
      const days = Number(this.#input('create-days').value)
      void this.#work(async epoch => {
        if (!Number.isSafeInteger(days) || days < 1 || days > 30) throw new Error('Choose a binding lifetime between one and thirty days.')
        const result = this.#value(await this.#owner.create(route, name, days * 86400), epoch)
        this.#text('status').textContent = result.state === 'saved'
          ? `Room ${result.session.slice(0, 12)}… saved locally with its witness and installation confirmed. Joining and message delivery remain held.` : result.reason
        if (result.state === 'saved') this.#input('create-name').value = ''
      })
    }
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
    for (const name of ['account', 'status', 'route-list', 'room-list']) this.#text(name).replaceChildren()
    this.#input('code').value = ''; this.#input('relays').value = ''
    this.#input('create-name').value = ''; this.#input('create-days').value = '7'
    ;(this.#text('create-route') as HTMLSelectElement).replaceChildren()
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
}
