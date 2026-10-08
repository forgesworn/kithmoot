import { BrowserLink } from './browser-link.js'
import { startBrowserLink } from './browser-link-runtime.js'

/** Pairing is explicit. Merely opening Settings does not load WASM or dial.
 * This panel establishes the carrier; room activation has its own grant gate. */
export class BrowserLinkPanel {
  readonly link = new BrowserLink(startBrowserLink)
  #generation = 0
  #busy = false
  constructor(private account: () => string | undefined, private root: Document = document) {
    this.button('bothyConnect').addEventListener('click', () => { void this.#run(async () => {
      const account = this.account(); if (!account) throw new Error('Sign in before connecting Bothy.')
      const text = this.input('bothyRelays').value.trim()
      const boxes = await this.link.resume(account, text ? text.split(/\s+/) : undefined)
      return boxes.length ? `Connection resumed. ${boxes.length} paired Bothy route${boxes.length === 1 ? '' : 's'} available.` : 'Ready to pair. Paste a current code from your Bothy.'
    }) })
    this.button('bothyPair').addEventListener('click', () => { void this.#run(async () => {
      const input = this.input('bothyCode'), code = input.value.trim(); input.value = ''
      await this.link.pair(code)
      return 'Bothy paired and saved on this browser. Room routing is not enabled yet.'
    }) })
    this.button('bothyStop').addEventListener('click', () => { void this.stop() })
    this.button('bothyForget').addEventListener('click', () => { void this.#run(async () => {
      await this.link.forget()
      return 'Pairing forgotten on this browser. Remove the paired device on Bothy to revoke it there.'
    }) })
    this.button('bothyClose').addEventListener('click', () => this.dialog.close())
  }
  get dialog(): HTMLDialogElement { return this.root.getElementById('bothySettings') as HTMLDialogElement }
  open(): void { this.dialog.showModal() }
  async stop(): Promise<void> {
    ++this.#generation; this.input('bothyCode').value = ''
    await this.link.stop()
    this.message('Connection closed. The sealed pairing is kept for reconnecting.')
  }
  async #run(work: () => Promise<string>): Promise<void> {
    if (this.#busy) return
    const generation = this.#generation
    this.#busy = true; this.button('bothyConnect').disabled = true; this.button('bothyPair').disabled = true
    this.message('Connecting…')
    try { const message = await work(); if (generation === this.#generation) this.message(message) }
    catch (error) { if (generation === this.#generation) this.message(error instanceof Error ? error.message : 'Bothy could not connect.') }
    finally { this.#busy = false; this.button('bothyConnect').disabled = false; this.button('bothyPair').disabled = false }
  }
  private button(id: string): HTMLButtonElement { return this.root.getElementById(id) as HTMLButtonElement }
  private input(id: string): HTMLInputElement { return this.root.getElementById(id) as HTMLInputElement }
  private message(text: string): void { this.root.getElementById('bothyStatus')!.textContent = text }
}
