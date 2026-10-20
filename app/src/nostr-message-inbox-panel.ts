import { npubEncode } from 'nostr-tools/nip19'
import type { SignetSession } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { DeviceStore } from './device-store.js'
import type { OrdinaryHistoryLock } from './nostr-message-history.js'
import { NostrMessageInbox } from './nostr-message-inbox.js'
import { ordinaryMessageDecrypt } from './nostr-message-receive-signer.js'

interface Options {
  account(): SignetSession | undefined; epoch(): number; eligible(): boolean; blocked(peer: string): boolean
  store: DeviceStore; acquire: OrdinaryHistoryLock
  receive(account: SignetSession, current: () => boolean): Promise<Pick<RelayTransport, 'subscribe' | 'close'>>
  reply(peer: string, parent: string): void
}
/** Account-only ordinary Nostr view, separate from room invitation handling. */
export class NostrMessageInboxPanel {
  #dialog: HTMLDialogElement
  #load: HTMLButtonElement
  #status: HTMLElement
  #list: HTMLElement
  #account?: SignetSession
  #epoch = 0
  #generation = 0
  #inbox?: NostrMessageInbox
  #return?: HTMLElement
  constructor(private readonly root: Document, private readonly options: Options) {
    this.#dialog = root.getElementById('nostrInboxDialog') as HTMLDialogElement
    this.#load = root.getElementById('nostrInboxLoad') as HTMLButtonElement
    this.#status = root.getElementById('nostrInboxStatus')!
    this.#list = root.getElementById('nostrInboxList')!
    this.#load.addEventListener('click', event => { if (event.isTrusted) this.#start() })
    root.getElementById('nostrInboxClose')!.addEventListener('click', () => this.close(true))
    this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(true) })
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.close() })
    root.defaultView?.addEventListener('pagehide', () => this.close())
  }
  get available(): boolean { try { return !!this.options.account() && this.options.eligible() } catch { return false } }
  #current = () => this.#dialog.open && this.available && this.#account === this.options.account() && this.#epoch === this.options.epoch()
  show(returnFocus: HTMLElement): void {
    this.close()
    if (!this.available) return
    this.#account = this.options.account(); this.#epoch = this.options.epoch(); this.#return = returnFocus
    this.#status.textContent = 'Choose Load messages to reopen saved encrypted copies and read your published Nostr inbox relays.'
    this.#load.disabled = false; this.#dialog.showModal()
  }
  #start(): void {
    if (!this.#current()) return
    this.#inbox?.close()
    const generation = ++this.#generation, account = this.#account!
    const inbox = new NostrMessageInbox({ account: account.pubkey, store: this.options.store, acquire: this.options.acquire,
      receive: current => this.options.receive(account, current), decrypt: ordinaryMessageDecrypt(account, this.options.account),
      current: () => generation === this.#generation && this.#current(), blocked: this.options.blocked,
      changed: () => this.reconcile(), failed: () => this.close() })
    this.#inbox = inbox
    void inbox.open().catch(() => { if (this.#inbox === inbox) this.close() })
  }
  reconcile(): void {
    try { this.#render() }
    catch { this.close() }
  }
  #render(): void {
    if (!this.#dialog.open) return
    if (!this.#current()) { this.close(); return }
    const state = this.#inbox?.snapshot()
    if (!state) return
    this.#load.disabled = state.loading || state.busy
    this.#load.textContent = 'Refresh messages'
    this.#status.textContent = state.status + (state.limited ? ' This view or saved-copy limit was reached; older encrypted copies may no longer be kept on this device.' : '')
    // Reuse stable rows: provider-status changes must not remove keyboard focus.
    const keep = new Set(state.messages.map(row => row.copy))
    // Remove revoked/expired plaintext before any later row rendering can fail.
    for (const item of [...this.#list.children]) if (!keep.has((item as HTMLElement).dataset.copy!)) {
      item.querySelector('.ordinaryMessageText')!.textContent = ''; item.remove()
    }
    for (const row of state.messages) {
      let item = [...this.#list.children].find(element => (element as HTMLElement).dataset.copy === row.copy) as HTMLLIElement | undefined
      if (!item) {
        item = this.root.createElement('li'); item.dataset.copy = row.copy
        const author = this.root.createElement('p'); author.className = 'ordinaryMessageAuthor'
        const status = this.root.createElement('p'); status.className = 'note ordinaryMessageStatus'
        const text = this.root.createElement('p'); text.className = 'ordinaryMessageText'; text.tabIndex = -1
        const open = this.root.createElement('button'); open.type = 'button'; open.className = 'ordinaryMessageOpen'
        open.addEventListener('click', event => { if (event.isTrusted && this.#current()) void this.#inbox?.openMessage(row.copy) })
        const reply = this.root.createElement('button'); reply.type = 'button'; reply.className = 'ordinaryMessageReply'; reply.textContent = 'Reply with public message'
        reply.addEventListener('click', event => {
          if (!event.isTrusted || !this.#current()) return
          const selected = this.#inbox?.snapshot().messages.find(entry => entry.copy === row.copy)
          const peer = selected?.message?.peer
          if (!peer || this.options.blocked(peer)) return
          const parent = selected!.message!.id
          this.close(); this.options.reply(peer, parent)
        })
        item.append(author, status, text, open, reply); this.#list.append(item)
      }
      const message = row.message
      item.querySelector('.ordinaryMessageAuthor')!.textContent = message ? `${message.author === this.#account!.pubkey ? 'You' : npubEncode(message.author)} · ${new Date(message.sentAt * 1000).toLocaleString()}` : 'Encrypted message copy'
      item.querySelector('.ordinaryMessageStatus')!.textContent = row.status === 'opened'
        ? '○ public. Message copy; this history does not record delivery or read receipts.' + (message!.members.length > 2 ? ' Group text; group replies are not available here.' : '')
        : row.status === 'opening' ? 'Waiting for your signer…'
        : row.status === 'unavailable' ? 'Use a compatible browser extension to open ordinary Nostr messages here.'
        : row.status === 'refused' ? 'This copy could not be opened as available ordinary text. Your signer may have refused, or the message may be blocked, expired, unsupported or an invitation.'
        : 'Encrypted. Choose Open message to ask your signer.'
      const text = item.querySelector('.ordinaryMessageText') as HTMLElement
      text.textContent = message?.text ?? ''; text.hidden = !message
      const open = item.querySelector('.ordinaryMessageOpen') as HTMLButtonElement
      const focused = this.root.activeElement === open
      open.textContent = row.status === 'refused' ? 'Try opening again' : 'Open message'
      open.hidden = row.status === 'opened' || row.status === 'unavailable'; open.disabled = state.busy
      const reply = item.querySelector('.ordinaryMessageReply') as HTMLButtonElement
      reply.hidden = !message?.peer; reply.disabled = state.busy
      if (focused && message) text.focus({ preventScroll: true })
    }
  }
  close(restoreFocus = false): void {
    ++this.#generation; this.#inbox?.close(); this.#inbox = undefined
    this.#account = undefined
    for (const text of this.#list.querySelectorAll('.ordinaryMessageText')) text.textContent = ''
    this.#list.replaceChildren(); this.#status.textContent = ''; this.#load.textContent = 'Load messages'
    const focus = this.#return; this.#return = undefined
    if (this.#dialog.open) this.#dialog.close()
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true })
  }
}
