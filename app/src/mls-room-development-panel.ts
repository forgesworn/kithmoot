import { BrowserMlsRoomDevelopmentOwner, type MlsRoomDevelopmentContext } from './mls-room-development-owner.js'
import type { MlsRoomForegroundResult } from './mls-room-foreground.js'

/** Explicit development-only room custody controls. Opening performs no I/O;
 * create, join and driver controls remain held until their ceremonies land. */
export class BrowserMlsRoomDevelopmentPanel {
  readonly dialog: HTMLDialogElement
  readonly #owner: BrowserMlsRoomDevelopmentOwner
  #epoch = 0
  #busy = false
  constructor(private readonly context: () => MlsRoomDevelopmentContext | undefined, private readonly root: Document = document) {
    this.#owner = new BrowserMlsRoomDevelopmentOwner(context)
    this.dialog = root.createElement('dialog'); this.dialog.id = 'mlsRoomDevelopment'; this.dialog.className = 'profileSettings'
    this.dialog.setAttribute('aria-labelledby', 'mlsRoomDevelopmentTitle')
    this.dialog.innerHTML = `<div class="profileSettingsHeader"><h2 id="mlsRoomDevelopmentTitle">MLS room connection</h2><button data-close type="button">Close</button></div>
      <p class="note">Development preview. Production MLS is unavailable. Room creation, authenticated invitation joining and message delivery are still held.</p>
      <p>Account: <span data-account></span></p><p data-status role="status" aria-live="polite"></p>
      <fieldset><legend>Dedicated room connection</legend><p>This connection has its own saved routes. Link relays can observe connection timing and volume.</p>
      <label>Link relay addresses <input data-relays autocomplete="off" spellcheck="false" placeholder="wss://…"></label>
      <label>Room pairing code <input data-code type="password" autocomplete="off" maxlength="32768"></label>
      <button data-pair type="button">Pair room connection</button><button data-routes type="button">Read saved room routes</button><div data-route-list></div></fieldset>
      <fieldset><legend>Saved MLS rooms</legend><button data-rooms type="button">Check saved MLS rooms</button><div data-room-list></div></fieldset>`
    root.body.append(this.dialog)
    this.#button('close').onclick = () => this.close()
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) void this.invalidate().catch(() => {}) })
    root.addEventListener('visibilitychange', () => { if (root.visibilityState !== 'visible') void this.invalidate().catch(() => {}) })
    this.#button('routes').onclick = () => { void this.#work(async epoch => {
      const routes = this.#value(await this.#owner.routes(), epoch)
      this.#list('route-list', routes.map(route => route.routeId))
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
    if (epoch !== this.#epoch || !this.dialog.open || this.root.visibilityState !== 'visible' || result.state !== 'done') throw new Error('Reopen this room workflow before retrying.')
    return result.value
  }
  #text(name: string): HTMLElement { return this.dialog.querySelector(`[data-${name}]`)! }
  #input(name: string): HTMLInputElement { return this.#text(name) as HTMLInputElement }
  #button(name: string): HTMLButtonElement { return this.#text(name) as HTMLButtonElement }
  #list(name: string, values: string[]): void {
    this.#text(name).replaceChildren(...values.map(value => { const row = this.root.createElement('p'); row.textContent = value; return row }))
  }
}
