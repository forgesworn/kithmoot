import { npubEncode } from 'nostr-tools/nip19'
import type { SignetSession } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import { LegacyMessageInbox, type LegacyMessage } from './legacy-message-inbox.js'
import { legacyMessageDecrypt } from './legacy-message-signer.js'

interface Options {
  account(): SignetSession | undefined
  epoch(): number
  eligible(): boolean
  blocked(peer: string): boolean
  borrowDefault(): Pick<RelayTransport, 'subscribe' | 'close'>
}
interface Row {
  element: HTMLLIElement
  author: HTMLElement
  time: HTMLElement
  warning: HTMLElement
  status: HTMLElement
  text: HTMLElement
  open: HTMLButtonElement
}

/** A separately opened compatibility view, outside rooms and calls. Merely
 * opening it does not subscribe or ask a signer. Only its own relay hold is
 * released; the shared account relay and existing AUTH policy stay intact. */
export class LegacyMessagePanel {
  readonly #dialog: HTMLDialogElement
  readonly #load: HTMLButtonElement
  readonly #status: HTMLElement
  readonly #list: HTMLElement
  #account?: SignetSession
  #epoch = 0
  #generation = 0
  #started = false
  #inbox?: LegacyMessageInbox
  #rows = new Map<string, Row>()
  #returnFocus?: HTMLElement

  constructor(private readonly root: Document, private readonly options: Options) {
    this.#dialog = root.getElementById('legacyMessagesDialog') as HTMLDialogElement
    this.#load = root.getElementById('legacyMessagesLoad') as HTMLButtonElement
    this.#status = root.getElementById('legacyMessagesStatus')!
    this.#list = root.getElementById('legacyMessagesList')!
    this.#load.addEventListener('click', event => { if (event.isTrusted) this.#start() })
    root.getElementById('legacyMessagesClose')!.addEventListener('click', () => this.close(true))
    this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(true) })
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.close() })
    root.defaultView?.addEventListener('pagehide', () => this.close())
  }

  get available(): boolean {
    try { return !!this.options.account() && this.options.eligible() } catch { return false }
  }

  show(returnFocus: HTMLElement): void {
    this.close()
    if (!this.available) return
    this.#account = this.options.account()
    this.#epoch = this.options.epoch()
    this.#returnFocus = returnFocus
    this.#load.disabled = false
    this.#status.textContent = 'Choose Load legacy messages to read your configured account relays. Nothing is opened automatically.'
    this.#dialog.showModal()
  }

  #current(): boolean {
    return this.#dialog.open && this.available && this.options.account() === this.#account && this.options.epoch() === this.#epoch
  }

  /** Called by real account/room transitions and contact-policy updates;
   * pending callbacks also check the same lifetime at actual provider start. */
  reconcile(): void {
    if (!this.#dialog.open) return
    if (!this.#current()) { this.close(); return }
    this.#render()
  }

  #start(): void {
    if (this.#started || !this.#current()) return
    this.#started = true
    this.#load.disabled = true
    const account = this.#account!, generation = this.#generation
    let transport: Pick<RelayTransport, 'subscribe' | 'close'> | undefined
    try {
      transport = this.options.borrowDefault()
      if (!this.#current() || generation !== this.#generation) { transport.close(); return }
      this.#inbox = new LegacyMessageInbox({ account: account.pubkey, transport,
        decrypt: legacyMessageDecrypt(account, () => this.options.account()),
        current: () => generation === this.#generation && this.#current(),
        blocked: peer => this.options.blocked(peer), changed: () => this.reconcile() })
      this.#inbox.open()
      this.#render()
    } catch {
      try { transport?.close() } catch { /* Cleanup must not retain message text. */ }
      this.#inbox?.close(); this.#inbox = undefined
      if (this.#current() && generation === this.#generation) {
        this.#status.textContent = 'Legacy messages could not be loaded. Close this view and check your account and relays.'
      }
    }
  }

  #row(message: LegacyMessage): Row {
    const element = this.root.createElement('li')
    element.dataset.message = message.id
    const author = this.root.createElement('p'), time = this.root.createElement('p')
    author.className = 'legacyMessageAuthor'; time.className = 'note'
    const warning = this.root.createElement('p'); warning.className = 'legacyMessageWarning'
    warning.id = `legacy-warning-${message.id}`
    const status = this.root.createElement('p'); status.className = 'note'; status.id = `legacy-status-${message.id}`
    const text = this.root.createElement('p'); text.className = 'legacyMessageText'; text.tabIndex = -1
    const open = this.root.createElement('button'); open.type = 'button'; open.textContent = 'Open message'
    open.setAttribute('aria-describedby', `${warning.id} ${status.id}`)
    open.addEventListener('click', event => {
      if (!event.isTrusted || !this.#current()) return
      void this.#inbox?.openMessage(message.id)
    })
    element.append(author, time, warning, status, text, open)
    return { element, author, time, warning, status, text, open }
  }

  #render(): void {
    if (!this.#current()) { this.close(); return }
    const state = this.#inbox?.snapshot()
    if (!state || !this.#current()) return
    const live = new Set<string>()
    state.messages.forEach((message, index) => {
      live.add(message.id)
      const row = this.#rows.get(message.id) ?? this.#row(message)
      this.#rows.set(message.id, row)
      row.author.textContent = npubEncode(message.author)
      const date = new Date(message.sentAt * 1000)
      row.time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Message date unavailable'
      row.warning.textContent = message.warning
      row.status.textContent = message.status === 'sealed' ? 'Encrypted. Open only if you want to ask your signer.'
        : message.status === 'opening' ? 'Waiting for your signer…'
        : message.status === 'opened' ? 'Opened on this device.'
        : message.status === 'unavailable' ? 'This sign-in cannot open legacy messages here. This view currently supports a compatible browser extension.'
        : 'Your signer did not open this message. You can choose to try again.'
      // Text is never parsed as markup, an invitation, a URL or an attachment.
      if (row.text.textContent !== (message.text ?? '')) row.text.textContent = message.text ?? ''
      row.text.hidden = message.status !== 'opened'
      const wasFocused = this.root.activeElement === row.open
      row.open.hidden = message.status === 'opened' || message.status === 'unavailable'
      row.open.disabled = state.busy
      row.open.textContent = message.status === 'refused' ? 'Try opening again' : 'Open message'
      if (this.#list.children[index] !== row.element) this.#list.insertBefore(row.element, this.#list.children[index] ?? null)
      if (wasFocused && message.status === 'opened') row.text.focus({ preventScroll: true })
    })
    for (const [id, row] of this.#rows) if (!live.has(id)) {
      row.text.textContent = ''; row.element.remove(); this.#rows.delete(id)
    }
    this.#status.textContent = state.error ?? (state.busy ? 'Waiting for your signer…'
      : `${state.messages.length} legacy message${state.messages.length === 1 ? '' : 's'} received. No messages are sent from this view.`)
      + (state.limited ? ' This view reached its message or processing limit. Close it before loading again.' : '')
  }

  close(restoreFocus = false): void {
    ++this.#generation
    const inbox = this.#inbox, returnFocus = this.#returnFocus
    this.#inbox = undefined; this.#account = undefined; this.#returnFocus = undefined; this.#started = false
    inbox?.close()
    for (const row of this.#rows.values()) row.text.textContent = ''
    this.#rows.clear(); this.#list.replaceChildren(); this.#status.textContent = ''
    this.#load.disabled = true
    if (this.#dialog.open) this.#dialog.close()
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  }
}
