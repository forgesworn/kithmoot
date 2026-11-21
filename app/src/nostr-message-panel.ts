import { npubEncode } from 'nostr-tools/nip19'
import type { SignetSession } from 'signet-login'
import type { Event } from 'nostr-tools/pure'
import { NostrMessage, nostrMessageRecipient, type NostrMessagePhase } from './nostr-message.js'
import type { OrdinaryOutgoingMessage } from './nostr-message-history.js'
import { nostrMessageIdentity } from './nostr-message-signer.js'
import { shortNpub } from './people.js'

interface Options {
  account(): SignetSession | undefined
  epoch(): number
  eligible(): boolean
  direct(): boolean
  allowLocal?(): boolean
  remoteSocket?(): typeof WebSocket | undefined
  blocked(peer: string): boolean
  lookup(authors: string[], current: () => boolean): Promise<Event[]>
  allowsRelay?(url: string): boolean
  publish(event: Event, relays: readonly string[], current: () => boolean, acknowledged: () => void): Promise<void | { unaccepted: readonly string[] }>
  rememberCopy(event: Event, account: SignetSession, current: () => boolean): Promise<void>
  recordOutgoing(outgoing: OrdinaryOutgoingMessage, account: SignetSession, current: () => boolean): Promise<void>
  recipientName(peer: string): string | undefined
  viewConversation(opener: HTMLElement, peer: string, messageId: string): void
}

const outcomeLabels: Record<NostrMessagePhase, string> = {
  closed: '', draft: '', checking: 'Checking inbox relays…', ready: 'Ready to send', preparing: 'Preparing encrypted message…',
  'not-sent': 'Not sent', sending: 'Sending…', unconfirmed: 'Send unconfirmed',
  'copy-unconfirmed': 'Sent to inbox relay', sent: 'Sent to inbox relay',
}
/** Explicit separate public conversation from the account home. No room
 * message, route, membership or private state enters this component. */
export class NostrMessagePanel {
  readonly #dialog: HTMLDialogElement
  readonly #form: HTMLFormElement
  readonly #title: HTMLElement
  readonly #address: HTMLElement
  readonly #recipient: HTMLInputElement
  readonly #to: HTMLElement
  readonly #toName: HTMLElement
  readonly #toKey: HTMLElement
  readonly #draft: HTMLElement
  readonly #text: HTMLTextAreaElement
  readonly #preview: HTMLElement
  readonly #review: HTMLButtonElement
  readonly #send: HTMLButtonElement
  readonly #view: HTMLButtonElement
  readonly #close: HTMLButtonElement
  readonly #outcome: HTMLElement
  readonly #state: HTMLElement
  readonly #status: HTMLElement
  readonly #details: HTMLDetailsElement
  readonly #summary: HTMLElement
  #account?: SignetSession
  #epoch = 0
  #generation = 0
  #message?: NostrMessage
  #focus?: HTMLElement
  #reply?: { peer: string; parent?: string }
  #direct = false
  #wasBusy = false
  #invalidAddress = false
  constructor(private readonly root: Document, private readonly options: Options) {
    const el = <T extends HTMLElement>(id: string) => root.getElementById(id)! as T
    this.#dialog = el('nostrMessageDialog'); this.#form = el('nostrMessageForm'); this.#title = el('nostrMessageTitle')
    this.#address = el('nostrMessageAddress'); this.#recipient = el('nostrMessageRecipient')
    this.#to = el('nostrMessageTo'); this.#toName = el('nostrMessageToName'); this.#toKey = el('nostrMessageToKey')
    this.#draft = el('nostrMessageDraft'); this.#text = el('nostrMessageText'); this.#preview = el('nostrMessagePreview')
    this.#review = el('nostrMessageReview'); this.#send = el('nostrMessageSend'); this.#view = el('nostrMessageView'); this.#close = el('nostrMessageClose')
    this.#outcome = el('nostrMessageOutcome'); this.#state = el('nostrMessageState'); this.#status = el('nostrMessageStatus')
    this.#details = el('nostrMessageDetails'); this.#summary = el('nostrMessageSummary')
    this.#form.addEventListener('submit', event => {
      event.preventDefault()
      if (event.isTrusted) void this.#act(this.#direct)
    })
    for (const input of [this.#recipient, this.#text]) input.addEventListener('input', () => {
      // Editing discards any previously reviewed target/content. An older
      // lookup callback cannot re-enable Send for a different draft.
      if (this.#message?.snapshot().busy || this.#message?.snapshot().attempted) return
      this.#invalidAddress = false
      this.#replaceMessage(); this.reconcile()
    })
    this.#send.addEventListener('click', event => { if (event.isTrusted) void this.#act(true) })
    this.#view.addEventListener('click', event => { if (event.isTrusted) this.#dismiss() })
    this.#close.addEventListener('click', () => this.#dismiss())
    this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.#dismiss() })
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.close() })
    root.defaultView?.addEventListener('pagehide', () => this.close())
  }
  get available(): boolean {
    try { const account = this.options.account(); return !!account && this.options.eligible() && !!this.#identity(account) }
    catch { return false }
  }
  #identity(account: SignetSession) {
    return nostrMessageIdentity(account, this.options.account, this.options.allowLocal?.(), this.options.remoteSocket?.())
  }
  #current = (): boolean => this.#dialog.open && this.available && this.#account === this.options.account() &&
    this.#epoch === this.options.epoch() && this.#direct === this.options.direct()
  show(focus: HTMLElement, reply?: { peer: string; parent?: string }): void {
    this.close()
    if (!this.available) return
    this.#account = this.options.account(); this.#epoch = this.options.epoch(); this.#focus = focus
    this.#direct = this.options.direct()
    this.#reply = reply
    if (reply) this.#recipient.value = npubEncode(reply.peer)
    this.#title.textContent = reply?.parent ? 'Reply on Nostr' : 'New Nostr message'
    this.#dialog.showModal(); this.#replaceMessage(); this.reconcile()
    ;(reply ? this.#text : this.#recipient).focus()
  }

  async #act(send: boolean): Promise<void> {
    const message = this.#message
    if (!message || !this.#current() || message.snapshot().busy) return
    if (send && message.snapshot().review) { await message.send(); return }
    if (send !== this.#direct || !this.#form.reportValidity()) return
    let recipient: string
    try { recipient = this.#reply?.peer ?? nostrMessageRecipient(this.#recipient.value) }
    catch {
      this.#invalidAddress = true; this.reconcile(); this.#recipient.focus(); return
    }
    await message.review(recipient, this.#text.value, this.#reply?.parent)
    if (send && this.#message === message && this.#current()) await message.send()
  }

  #replaceMessage(): void {
    this.#message?.close(); this.#message = undefined
    const account = this.#account, generation = ++this.#generation
    if (!account || !this.#current()) return
    const identity = this.#identity(account)
    if (!identity) { this.close(); return }
    this.#message = new NostrMessage({ identity, current: () => generation === this.#generation && this.#current(),
      blocked: this.options.blocked, lookup: this.options.lookup, publish: this.options.publish,
      allowsRelay: this.options.allowsRelay,
      rememberCopy: (event, current) => this.options.rememberCopy(event, account, current),
      recordOutgoing: (outgoing, current) => this.options.recordOutgoing(outgoing, account, current),
      changed: () => this.reconcile() })
  }

  reconcile(): void {
    if (!this.#dialog.open) return
    if (!this.#current()) { this.close(); return }
    const state = this.#message?.snapshot()
    if (!state) return
    if (state.phase === 'closed') { this.close(); return }
    const reviewed = state.review
    const peer = this.#reply?.peer ?? (state.attempted ? reviewed?.recipient : undefined)
    this.#address.hidden = !!peer
    this.#to.hidden = !peer
    if (peer) {
      const name = this.options.recipientName(peer), key = shortNpub(peer)
      this.#toName.textContent = name ?? key
      this.#toKey.textContent = name ? key : ''
      this.#to.title = npubEncode(peer)
    }
    this.#draft.hidden = !state.busy && state.attempted
    this.#preview.hidden = !this.#draft.hidden
    this.#preview.textContent = this.#draft.hidden ? reviewed?.text ?? '' : ''
    this.#recipient.disabled = state.busy || state.attempted; this.#text.disabled = state.busy || state.attempted
    this.#recipient.setAttribute('aria-invalid', String(this.#invalidAddress))
    this.#review.hidden = this.#direct || !!reviewed; this.#review.disabled = this.#review.hidden || state.busy
    this.#send.hidden = state.attempted && !state.retry && !state.busy || !this.#direct && !reviewed
    this.#send.disabled = state.busy || this.#send.hidden
    this.#send.textContent = state.retry ? state.phase === 'copy-unconfirmed' ? 'Retry inbox sync' : 'Retry same message'
      : state.retryPreparation ? 'Retry send' : 'Send encrypted message'
    this.#view.hidden = !this.#direct || !state.attempted || state.busy
    this.#view.classList.toggle('quiet', state.retry)
    const phase = this.#invalidAddress ? 'not-sent' : state.phase
    const label = outcomeLabels[phase]
    const detail = this.#invalidAddress ? 'Enter the recipient’s public key starting with npub1.' : state.status
    this.#outcome.hidden = !label
    this.#outcome.dataset.phase = phase
    if (this.#state.textContent !== label) this.#state.textContent = label
    if (this.#status.textContent !== detail) this.#status.textContent = detail
    this.#details.hidden = !reviewed
    const unconfirmed = state.unconfirmedRelays?.length ? `\nRecipient relays without confirmation: ${state.unconfirmedRelays.join(', ')}` : ''
    this.#summary.textContent = reviewed ? `To ${npubEncode(reviewed.recipient)}\nRecipient inbox: ${reviewed.recipientRelays.join(', ')}\nYour inbox: ${reviewed.senderRelays.join(', ')}${unconfirmed}` : ''
    if (this.#wasBusy && !state.busy) {
      const action = [this.#send, this.#view, this.#review, this.#close].find(button => !button.hidden && !button.disabled)
      action?.focus({ preventScroll: true })
    }
    this.#wasBusy = state.busy
  }

  #dismiss(): void {
    const focus = this.#focus
    const state = this.#current() ? this.#message?.snapshot() : undefined
    if (focus && this.#direct && state?.review && state.messageId) {
      this.close()
      this.options.viewConversation(focus, state.review.recipient, state.messageId)
    } else this.close(true)
  }

  close(restoreFocus = false): void {
    ++this.#generation; this.#message?.close(); this.#message = undefined; this.#account = undefined
    this.#reply = undefined; this.#invalidAddress = false; this.#wasBusy = false
    this.#recipient.value = ''; this.#text.value = ''; this.#summary.textContent = ''; this.#status.textContent = ''; this.#state.textContent = ''
    this.#toName.textContent = ''; this.#toKey.textContent = ''; this.#to.title = ''; this.#preview.textContent = ''
    this.#outcome.hidden = true; this.#details.open = false; this.#details.hidden = true; this.#view.hidden = true
    this.#recipient.disabled = false; this.#text.disabled = false; this.#review.disabled = true; this.#send.hidden = true
    const focus = this.#focus; this.#focus = undefined
    if (this.#dialog.open) this.#dialog.close()
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true })
  }
}
