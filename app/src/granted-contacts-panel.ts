import { SimplePool } from 'nostr-tools/pool'
import { bindRelayPoolDialCustody } from './relay-pool-dial-custody.js'
import { createSimplePoolRelayIo } from '@forgesworn/signet-contacts/adapters/nostr-tools'
import type { Capability } from '@forgesworn/signet-contacts'
import type { SignetSession } from 'signet-login'
import { GrantedContactsClient, firstReachableRelay, RELAY_ANSWER_MS } from './granted-contacts-client.js'
import type { GrantedContactsView } from './granted-contacts.js'
import type { DeviceStore } from './device-store.js'
import { npubEncode } from 'nostr-tools/nip19'

interface Options {
  account(): SignetSession | undefined
  /** The person's read and write relays, in the order they keep them. */
  relays(): string[]
  store: DeviceStore
  qr(canvas: HTMLCanvasElement, value: string): Promise<unknown>
  changed(view: GrantedContactsView): void
  message(pubkey: string, name?: string): Promise<void>
}
/** One panel for the document. It owns its relay pool and closes it on account
 * changes. Merely visiting the page never starts a new pairing. */
export class GrantedContactsPanel {
  readonly #options: Options
  #account: SignetSession | undefined
  #client: GrantedContactsClient | undefined
  #pool: SimplePool | undefined
  #releaseDials: (() => void) | undefined
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
    this.#el<HTMLInputElement>('signetContactsSearch').addEventListener('input', () => this.#paint())
  }
  reconcile(): void {
    const account = this.#options.account()
    if (account !== this.#account) {
      this.#cancel?.(); this.#cancel = undefined; this.#pairing = false; this.#looking = false; this.#answer?.(false)
      // Latch before the SDK can report a synchronous teardown callback.
      this.#releaseDials?.(); this.#releaseDials = undefined; this.#client?.stop()
      this.#pool?.destroy(); this.#client = undefined; this.#pool = undefined
      this.#account = account; this.#message = ''
      this.#view = { status: 'disconnected', contacts: [], blocked: new Set(), truncated: false }
      this.#options.changed(this.#view)
      if (account?.signer.nip44 && account.signer.capabilities.canSignEvents && navigator.locks) {
        const pool = new SimplePool(); this.#pool = pool
        // Polled every 30 s once paired: behind the same dial backoff as every
        // other pool, so a dead relay is not redialled at that pace.
        this.#releaseDials = bindRelayPoolDialCustody(pool)
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
      : this.#view.status === 'stale' ? `Signet last shared this copy${this.#view.issuedAt ? ` on ${new Date(this.#view.issuedAt * 1000).toLocaleString()}` : ''}, so names may be out of date. Tiers and checks are hidden until it shares a new one: open Signet and unlock your contacts. Known blocks remain.`
      : this.#view.status === 'lapsed' ? 'Signet has not shared a new copy for over a month, so its names are hidden. Open Signet and unlock your contacts to refresh it. Known blocks remain.'
      : this.#view.status === 'revoked' ? 'This contact grant was revoked. Its contacts are hidden; known blocks remain.'
      : this.#view.status === 'unavailable' ? 'The contact cache needs attention. No contact names or tiers are being used.'
      : this.#view.status === 'waiting' ? 'Waiting for the first granted copy.' : 'Link Signet to read only the contacts and fields you approve.')
    const list = this.#el('signetGrantedContacts')
    const previous = new Map([...list.querySelectorAll<HTMLLIElement>('li')].map(row => [row.dataset.contact, row]))
    let index = 0
    const query = this.#el<HTMLInputElement>('signetContactsSearch').value.trim().toLocaleLowerCase()
    for (const contact of this.#view.contacts) {
      if (contact.pubkey === this.#account?.pubkey) continue
      const npub = npubEncode(contact.pubkey)
      if (query && !`${contact.name ?? ''} ${npub}`.toLocaleLowerCase().includes(query)) continue
      const row = previous.get(contact.pubkey) ?? document.createElement('li')
      previous.delete(contact.pubkey); row.dataset.contact = contact.pubkey
      const label = row.querySelector<HTMLSpanElement>('span') ?? document.createElement('span'); label.className = 'contactLabel'
      const duplicateName = !!contact.name && this.#view.contacts.some(other => other.pubkey !== contact.pubkey && other.name === contact.name)
      label.textContent = `${contact.name ?? `${npub.slice(0, 12)}…`}${duplicateName ? ` · ${npub.slice(0, 12)}…` : ''}${contact.tier ? ` · ${contact.tier}` : ''}`
      label.title = npub
      const message = row.querySelector<HTMLButtonElement>('button') ?? document.createElement('button'); message.type = 'button'; message.textContent = 'Message'
      message.dataset.contact = contact.pubkey; message.setAttribute('aria-label', `Message ${contact.name ?? npub}${duplicateName ? ` (${npub})` : ''}`)
      message.onclick = () => {
        message.disabled = true
        void this.#options.message(contact.pubkey, contact.name).finally(() => { message.disabled = false })
      }
      if (!row.childElementCount) row.append(label, message)
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null)
      index++
    }
    for (const row of previous.values()) row.remove()
    this.#el('signetContactsEmpty').hidden = list.childElementCount > 0
    this.#el('signetContactsEmpty').textContent = this.#view.contacts.length ? 'No matching contacts.' : 'Link your Signet contacts to find someone to message.'
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
