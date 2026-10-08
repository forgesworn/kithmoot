import type { BrowserLink } from './browser-link.js'
import type { BrowserRoomRoutes } from './browser-room-routes.js'
import { BrowserRoomActivation, type RoomActivationInput } from './browser-room-activation.js'

export interface RoomPanelContext extends Omit<RoomActivationInput, 'box' | 'guests'> {
  account: string
  label: string
  devices: { persona: string; device: string; label: string }[]
  resume: () => Promise<void>
  leave: () => Promise<void>
}
/** The route decision is explicit, separate from pairing and from account
 * discovery. The keeper signs only the displayed current device scopes. */
export class BrowserRoomPanel {
  #context?: RoomPanelContext
  #busy = false
  constructor(private activation: BrowserRoomActivation, private routes: BrowserRoomRoutes, private link: BrowserLink,
    private context: () => Promise<RoomPanelContext>, private root: Document = document) {
    this.el('bothyRoomClose').onclick = () => this.dialog.close()
    this.el('bothyRoomActivate').onclick = () => { void this.run(async context => {
      const box = (await this.link.pairedBoxes(context.account)).find(b => b.routeId === (this.el('bothyRoomRoute') as HTMLSelectElement).value)
      if (!box) throw new Error('Connect and pair your Bothy in Settings first.')
      const saved = await this.routes.selected(context.room)
      if (!saved || saved.phase === 'retired') {
        const fresh = await this.context()
        const deviceSet = (c: RoomPanelContext) => c.devices.map(d => `${d.persona}:${d.device}`).sort().join(',')
        if (fresh.account !== context.account || fresh.room !== context.room || fresh.device !== context.device || deviceSet(fresh) !== deviceSet(context)) throw new Error('The room’s current devices changed. Close and reopen this panel to review them before granting access.')
      }
      await this.activation.activate({ ...context, box, guests: (this.el('bothyRoomKeeper') as HTMLInputElement).checked ? context.devices : undefined })
      await context.resume()
      return 'This room now uses Bothy for its granted text channels. Other account connections keep their own settings.'
    }) }
    this.el('bothyRoomRenew').onclick = () => { void this.run(async context => {
      await this.activation.renew(context.room, context.readiness); await context.resume()
      return 'Bothy confirmed renewed room grants and readiness.'
    }) }
    this.el('bothyRoomWithdraw').onclick = () => { void this.run(async context => {
      await context.leave()
      await this.activation.withdraw(context.room)
      return 'The local room selection was withdrawn. Keeper-issued grants were confirmed withdrawn where this account held them; a guest cannot revoke the keeper’s grant. Reopen the room to use its public relays.'
    }) }
  }
  private el(id: string): HTMLElement { return this.root.getElementById(id)! }
  get dialog(): HTMLDialogElement { return this.el('bothyRoomSettings') as HTMLDialogElement }
  async open(): Promise<void> {
    this.dialog.showModal()
    this.el('bothyRoomStatus').textContent = 'Opening room permissions…'
    try {
      this.#context = await this.context()
      const context = this.#context, consent = await this.routes.selected(context.room)
      this.el('bothyRoomLabel').textContent = context.label
      this.el('bothyRoomDevices').textContent = context.devices.length ? context.devices.map(d => `${d.label}: ${d.device.slice(0, 12)}…`).join('; ') : 'No other current devices are present. Ask the other participant to open this room before issuing their grant.'
      const select = this.el('bothyRoomRoute') as HTMLSelectElement
      select.replaceChildren(...(await this.link.pairedBoxes(context.account)).map((box, i) => new Option(`Paired Bothy ${i + 1} · ${box.eventUrl.slice(5, 17)}…`, box.routeId)))
      if (consent) select.value = consent.box.routeId
      this.el('bothyRoomStatus').textContent = consent ? `Saved state: ${consent.phase}. Permission term ends ${new Date(consent.expires * 1000).toLocaleString()}. Traffic stays on this selection until you withdraw it.` : 'Activation closes this room’s public connections in every tab. The other participant must activate their own paired route too.'
    } catch (error) { this.#context = undefined; this.el('bothyRoomStatus').textContent = String((error as Error).message) }
  }
  private async run(work: (context: RoomPanelContext) => Promise<string>): Promise<void> {
    if (this.#busy || !this.#context) return
    this.#busy = true
    const buttons = [...this.dialog.querySelectorAll<HTMLButtonElement>('button:not(#bothyRoomClose)')]
    buttons.forEach(b => { b.disabled = true })
    this.el('bothyRoomStatus').textContent = 'Confirming room permissions and closing public connections…'
    try { this.el('bothyRoomStatus').textContent = await work(this.#context) }
    catch (error) { this.el('bothyRoomStatus').textContent = (error as Error).message }
    finally { this.#busy = false; buttons.forEach(b => { b.disabled = false }) }
  }
}
