import { SimplePool } from 'nostr-tools/pool'
import { createSimplePoolRelayIo } from '@forgesworn/signet-contacts/adapters/nostr-tools'
import type { Capability } from '@forgesworn/signet-contacts'
import type { SignetSession } from 'signet-login'
import { GrantedContactsClient, firstReachableRelay, RELAY_ANSWER_MS } from './granted-contacts-client.js'
import type { GrantedContactsView } from './granted-contacts.js'
import type { DeviceStore } from './device-store.js'

interface Options {
  account(): SignetSession | undefined
  /** The person's read and write relays, in the order they keep them. */
  relays(): string[]
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
  /** True while a relay is being found, before there is a link to show. */
  #looking = false
  /** Settles the code step. Set only while the code is on screen. */
  #answer: ((matched: boolean) => void) | undefined
  #message = ''
  #view: GrantedContactsView = { status: 'disconnected', contacts: [], blocked: new Set(), truncated: false }
  readonly #el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  constructor(options: Options) {
    this.#options = options
    this.#el<HTMLButtonElement>('signetContactsConnect').onclick = () => { void this.#connect() }
    this.#el<HTMLButtonElement>('signetContactsCancel').onclick = () => {
      this.#cancel?.(); this.#cancel = undefined; this.#pairing = false; this.#answer?.(false)
      this.#message = 'Pairing cancelled.'; this.#paint()
    }
    this.#el<HTMLButtonElement>('signetContactsMatched').onclick = () => { this.#answer?.(true) }
    this.#el<HTMLButtonElement>('signetContactsMismatch').onclick = () => { this.#answer?.(false) }
    this.#el<HTMLButtonElement>('signetContactsRefresh').onclick = () => { void this.#client?.refresh() }
  }
  reconcile(): void {
    const account = this.#options.account()
    if (account !== this.#account) {
      this.#cancel?.(); this.#cancel = undefined; this.#pairing = false; this.#looking = false; this.#answer?.(false)
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
    this.#el('signetContactsPairing').hidden = !this.#pairing || this.#looking || !!this.#answer
    this.#el('signetContactsConfirm').hidden = !this.#answer
    this.#el('signetContactsState').textContent = this.#message || (!available
      ? 'Connect a Nostr signer with encryption support to link your Signet contacts. This browser also needs support for coordinating tabs.'
      : this.#view.status === 'ready' ? `${this.#view.contacts.length} shared ${this.#view.contacts.length === 1 ? 'key' : 'keys'} available${this.#view.truncated ? ' (the granted copy is incomplete)' : ''}.`
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
  /** The QR gives way to the code, so only one thing is asked at a time. */
  #confirm(code: string): Promise<boolean> {
    return new Promise(resolve => {
      this.#answer = matched => { this.#answer = undefined; this.#el('signetContactsCode').textContent = ''; this.#paint(); resolve(matched) }
      this.#el('signetContactsCode').textContent = code
      this.#message = 'Signet approved a request. Check it was yours.'; this.#paint()
      this.#el<HTMLButtonElement>('signetContactsMatched').focus()
    })
  }
  async #connect(): Promise<void> {
    const client = this.#client, account = this.#account, pool = this.#pool, relays = this.#options.relays()
    if (!client || !pool || this.#pairing) return
    if (!relays.length) { this.#message = 'Choose a read/write relay in relay settings first.'; this.#paint(); return }
    this.#message = 'Looking for a relay that answers.'; this.#pairing = true; this.#looking = true; this.#paint()
    let cancel: (() => void) | undefined
    try {
      const relay = await firstReachableRelay(relays, url => pool.ensureRelay(url, { connectionTimeout: RELAY_ANSWER_MS }).then(() => true))
      if (this.#account !== account) return
      this.#looking = false
      if (!relay) { this.#message = 'None of your relays answered, so Signet could not reply. Check relay settings and try again.'; return }
      this.#message = ''; this.#paint()
      const extras: Capability[] = []
      if (this.#el<HTMLInputElement>('signetContactsTiers').checked) extras.push('signet.contacts.read:tier')
      if (this.#el<HTMLInputElement>('signetContactsChecks').checked) extras.push('signet.contacts.read:checks', 'signet.contacts.read:check-records')
      const pairing = client.beginPairing(relay, extras); cancel = pairing.cancel; this.#cancel = cancel
      this.#el<HTMLInputElement>('signetContactsUri').value = pairing.uri
      await this.#options.qr(this.#el<HTMLCanvasElement>('signetContactsQr'), pairing.uri)
      if (this.#cancel !== cancel || this.#account !== account) return
      this.#message = 'Scan this with Signet and review the requested access.'; this.#paint()
      const outcome = await pairing.wait(code => this.#confirm(code))
      if (this.#cancel !== cancel || this.#account !== account) return
      this.#message = outcome === 'paired' ? ''
        : outcome === 'not-confirmed' ? 'Nothing was linked. Start a new pairing to get a new code.'
        : 'No approval arrived. You can start a new pairing.'
    } catch (error) {
      if (this.#account === account && this.#cancel === cancel) this.#message = error instanceof Error ? error.message : 'Pairing failed.'
    } finally {
      cancel?.(); this.#answer?.(false)
      if (this.#account === account && (this.#cancel === cancel || !cancel)) {
        this.#cancel = undefined; this.#pairing = false; this.#looking = false; this.#paint()
      }
    }
  }
}
