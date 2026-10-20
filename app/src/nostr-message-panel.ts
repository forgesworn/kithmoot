import { npubEncode } from 'nostr-tools/nip19'
import type { SignetSession } from 'signet-login'
import type { Event } from 'nostr-tools/pure'
import { NostrMessage, nostrMessageRecipient, NOSTR_MESSAGE_WARNING, NOSTR_MESSAGE_LANE } from './nostr-message.js'
import { nostrMessageIdentity } from './nostr-message-signer.js'

interface Options {
  account(): SignetSession | undefined
  epoch(): number
  eligible(): boolean
  blocked(peer: string): boolean
  lookup(authors: string[], current: () => boolean): Promise<Event[]>
  publish(event: Event, relays: readonly string[], current: () => boolean): Promise<void>
}
/** Explicit separate public conversation from the account home. No room
 * message, route, membership or private state enters this component. */
export class NostrMessagePanel {
  readonly #dialog: HTMLDialogElement
  readonly #recipient: HTMLInputElement
  readonly #text: HTMLTextAreaElement
  readonly #review: HTMLButtonElement
  readonly #send: HTMLButtonElement
  readonly #status: HTMLElement
  readonly #summary: HTMLElement
  #account?: SignetSession
  #epoch = 0
  #generation = 0
  #message?: NostrMessage
  #focus?: HTMLElement
  constructor(private readonly root: Document, private readonly options: Options) {
    const el = (id: string) => root.getElementById(id)!
    this.#dialog = el('nostrMessageDialog') as HTMLDialogElement
    this.#recipient = el('nostrMessageRecipient') as HTMLInputElement
    this.#text = el('nostrMessageText') as HTMLTextAreaElement
    this.#review = el('nostrMessageReview') as HTMLButtonElement
    this.#send = el('nostrMessageSend') as HTMLButtonElement
    this.#status = el('nostrMessageStatus'); this.#summary = el('nostrMessageSummary')
    el('nostrMessageWarning').textContent = NOSTR_MESSAGE_WARNING
    el('nostrMessageLane').textContent = NOSTR_MESSAGE_LANE
    el('nostrMessageForm').addEventListener('submit', event => {
      event.preventDefault()
      if (!event.isTrusted || !this.#current()) return
      const message = this.#message, generation = this.#generation
      try {
        const recipient = nostrMessageRecipient(this.#recipient.value)
        void message?.review(recipient, this.#text.value).then(() => { if (generation === this.#generation) this.reconcile() })
      } catch { this.#status.textContent = 'Enter their Nostr public key (npub), not a secret key.' }
    })
    for (const input of [this.#recipient, this.#text]) input.addEventListener('input', () => {
      // Editing discards any previously reviewed target/content. An older
      // lookup callback cannot re-enable Send for a different draft.
      if (this.#message?.snapshot().busy || this.#message?.snapshot().attempted) return
      this.#replaceMessage(); this.reconcile()
    })
    this.#send.addEventListener('click', event => { if (event.isTrusted && this.#current()) void this.#message?.send() })
    el('nostrMessageClose').addEventListener('click', () => this.close(true))
    this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(true) })
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.close() })
    root.defaultView?.addEventListener('pagehide', () => this.close())
  }
  get available(): boolean {
    try { const account = this.options.account(); return !!account && this.options.eligible() && !!nostrMessageIdentity(account, this.options.account) }
    catch { return false }
  }
  #current = (): boolean => this.#dialog.open && this.available && this.#account === this.options.account() && this.#epoch === this.options.epoch()
  show(focus: HTMLElement): void {
    this.close()
    if (!this.available) return
    this.#account = this.options.account(); this.#epoch = this.options.epoch(); this.#focus = focus
    this.#dialog.showModal(); this.#replaceMessage(); this.reconcile(); this.#recipient.focus()
  }
  #replaceMessage(): void {
    this.#message?.close(); this.#message = undefined
    const account = this.#account, generation = ++this.#generation
    if (!account || !this.#current()) return
    const identity = nostrMessageIdentity(account, this.options.account)
    if (!identity) { this.close(); return }
    this.#message = new NostrMessage({ identity, current: () => generation === this.#generation && this.#current(),
      blocked: this.options.blocked, lookup: this.options.lookup, publish: this.options.publish,
      changed: () => this.reconcile() })
  }
  reconcile(): void {
    if (!this.#dialog.open) return
    if (!this.#current()) { this.close(); return }
    const state = this.#message?.snapshot()
    if (!state) return
    if (!state.status) { this.close(); return }
    this.#recipient.disabled = state.busy || state.attempted; this.#text.disabled = state.busy || state.attempted
    this.#review.disabled = state.busy || state.attempted
    this.#send.hidden = !state.review; this.#send.disabled = state.busy || state.attempted && !state.retry
    this.#send.textContent = state.retry ? 'Retry same public message' : 'Send public'
    this.#status.textContent = state.status
    this.#summary.textContent = state.review ? `To ${npubEncode(state.review.recipient)}\nRecipient inbox: ${state.review.recipientRelays.join(', ')}\nYour encrypted copy: ${state.review.senderRelays.join(', ')}` : ''
  }
  close(restoreFocus = false): void {
    ++this.#generation; this.#message?.close(); this.#message = undefined; this.#account = undefined
    this.#recipient.value = ''; this.#text.value = ''; this.#summary.textContent = ''; this.#status.textContent = ''
    this.#recipient.disabled = false; this.#text.disabled = false; this.#review.disabled = true; this.#send.hidden = true
    const focus = this.#focus; this.#focus = undefined
    if (this.#dialog.open) this.#dialog.close()
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true })
  }
}
