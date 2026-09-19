import { SimplePool } from 'nostr-tools/pool'
import { createSimplePoolRelayIo } from '@forgesworn/signet-contacts/adapters/nostr-tools'
import type { Capability } from '@forgesworn/signet-contacts'
import type { SignetSession } from 'signet-login'
import { GrantedContactsClient } from './granted-contacts-client.js'
import type { GrantedContactsView } from './granted-contacts.js'
import type { DeviceStore } from './device-store.js'

interface Options {
  account(): SignetSession | undefined
  relay(): string | undefined
  store: DeviceStore
  qr(canvas: HTMLCanvasElement, value: string): Promise<unknown>
  changed(view: GrantedContactsView): void
}
/** One panel for the document. It owns its relay pool and closes it on account
 * changes. Merely visiting the page never starts a new pairing. */
export class GrantedContactsPanel {
  readonly #options: Options
  #account: SignetSession | undefined
  #client: GrantedContactsClient | undefined
  #pool: SimplePool | undefined
  #cancel: (() => void) | undefined
  #pairing = false
  #message = ''
  #view: GrantedContactsView = { status: 'disconnected', contacts: [], blocked: new Set(), truncated: false }
  readonly #el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  constructor(options: Options) {
    this.#options = options
    this.#el<HTMLButtonElement>('signetContactsConnect').onclick = () => { void this.#connect() }
    this.#el<HTMLButtonElement>('signetContactsCancel').onclick = () => {
      this.#cancel?.(); this.#cancel = undefined; this.#pairing = false
      this.#message = 'Pairing cancelled.'; this.#paint()
    }
    this.#el<HTMLButtonElement>('signetContactsRefresh').onclick = () => { void this.#client?.refresh() }
  }
  reconcile(): void {
    const account = this.#options.account()
    if (account !== this.#account) {
      this.#cancel?.(); this.#cancel = undefined; this.#pairing = false
      this.#client?.stop(); this.#pool?.destroy(); this.#client = undefined; this.#pool = undefined
      this.#account = account; this.#message = ''
      this.#view = { status: 'disconnected', contacts: [], blocked: new Set(), truncated: false }
      this.#options.changed(this.#view)
      if (account?.signer.nip44 && account.signer.capabilities.canSignEvents && navigator.locks) {
        const pool = new SimplePool(); this.#pool = pool
        const client = new GrantedContactsClient({ signer: { pubkey: account.pubkey,
          nip44Encrypt: (peer, text) => account.signer.nip44!.encrypt(peer, text),
          nip44Decrypt: (peer, text) => account.signer.nip44!.decrypt(peer, text),
          signEvent: event => account.signer.signEvent(event) }, relay: createSimplePoolRelayIo(pool), store: this.#options.store,
          current: () => this.#account === account && this.#options.account() === account,
          changed: view => { this.#view = view; this.#options.changed(view); this.#paint() } })
        this.#client = client; client.start()
      }
    }
    this.#paint()
  }
  #paint(): void {
    const available = !!this.#client
    this.#el<HTMLButtonElement>('signetContactsConnect').disabled = !available || this.#pairing
    this.#el<HTMLButtonElement>('signetContactsRefresh').disabled = !available || this.#pairing
    this.#el('signetContactsPairing').hidden = !this.#pairing
    this.#el('signetContactsState').textContent = this.#message || (!available
      ? 'Connect a Nostr signer with encryption support to link your Signet contacts. This browser also needs support for coordinating tabs.'
      : this.#view.status === 'ready' ? `${this.#view.contacts.length} shared keys available${this.#view.truncated ? ' (the granted copy is incomplete)' : ''}.`
      : this.#view.status === 'stale' ? 'The granted copy has expired. Refresh it before using its names or tiers. Known blocks remain.'
      : this.#view.status === 'revoked' ? 'This contact grant was revoked. Its contacts are hidden; known blocks remain.'
      : this.#view.status === 'unavailable' ? 'The contact cache needs attention. No contact names or tiers are being used.'
      : this.#view.status === 'waiting' ? 'Waiting for the first granted copy.' : 'Link Signet to read only the contacts and fields you approve.')
    const list = this.#el('signetGrantedContacts'); list.replaceChildren()
    for (const contact of this.#view.contacts) {
      const row = document.createElement('li')
      row.textContent = `${contact.name ?? 'Unnamed contact'} · ${contact.pubkey.slice(0, 12)}${contact.tier ? ` · ${contact.tier}` : ''}`
      row.title = contact.pubkey; list.append(row)
    }
  }
  async #connect(): Promise<void> {
    const client = this.#client, account = this.#account, relay = this.#options.relay()
    if (!client || this.#pairing) return
    if (!relay) { this.#message = 'Choose a read/write relay in relay settings first.'; this.#paint(); return }
    this.#message = ''; this.#pairing = true; this.#paint()
    let cancel: (() => void) | undefined
    try {
      const extras: Capability[] = []
      if (this.#el<HTMLInputElement>('signetContactsTiers').checked) extras.push('signet.contacts.read:tier')
      if (this.#el<HTMLInputElement>('signetContactsChecks').checked) extras.push('signet.contacts.read:checks', 'signet.contacts.read:check-records')
      const pairing = client.beginPairing(relay, extras); cancel = pairing.cancel; this.#cancel = cancel
      this.#el<HTMLInputElement>('signetContactsUri').value = pairing.uri
      await this.#options.qr(this.#el<HTMLCanvasElement>('signetContactsQr'), pairing.uri)
      if (this.#cancel !== cancel || this.#account !== account) return
      this.#message = 'Scan this with Signet and review the requested access.'; this.#paint()
      const paired = await pairing.wait()
      if (this.#cancel !== cancel || this.#account !== account) return
      this.#message = paired ? '' : 'No approval arrived. You can start a new pairing.'
    } catch (error) {
      if (this.#account === account && this.#cancel === cancel) this.#message = error instanceof Error ? error.message : 'Pairing failed.'
    } finally {
      cancel?.()
      if (this.#account === account && (this.#cancel === cancel || !cancel)) {
        this.#cancel = undefined; this.#pairing = false; this.#paint()
      }
    }
  }
}
