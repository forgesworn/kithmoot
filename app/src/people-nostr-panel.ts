import './people-nostr.css'
import type { OrdinarySendStatus } from './nostr-message-history.js'
import { personAvatar, shortNpub } from './people.js'
import type { PeopleNostrInbox } from './people-nostr-inbox.js'

interface Contact {
  name?: string
  picture?: string
  known: boolean
}

interface Options {
  account(): string | undefined
  available(): boolean
  enabled(): boolean
  toggle(): Promise<void>
  refresh(): void
  inbox(): PeopleNostrInbox | undefined
  status(): string
  contact(peer: string): Contact
  configure(): void
  compose(opener: HTMLElement, reply?: { peer: string; parent: string }): void
  canCompose(): boolean
  invite(peer: string, name?: string): Promise<string | undefined>
  block(peer: string): void
}

function sendStatusLabel(status?: OrdinarySendStatus): HTMLElement {
  const label = document.createElement('small')
  label.className = 'peopleNostrDelivery'; label.dataset.status = status ?? 'history'
  label.textContent = status === 'sent' ? 'Sent to inbox relay'
    : status === 'copy-unconfirmed' ? 'Sent to inbox relay · Inbox sync unconfirmed'
    : status === 'unconfirmed' ? 'Send unconfirmed' : 'Send status unavailable'
  return label
}

export class PeopleNostrPanel {
  #dialog: HTMLDialogElement
  #title: HTMLElement
  #status: HTMLElement
  #toggle: HTMLButtonElement
  #refresh: HTMLButtonElement
  #compose: HTMLButtonElement
  #actions: HTMLElement
  #content: HTMLElement
  #account?: string
  #opener?: HTMLElement
  #peer?: string
  #painted = ''

  constructor(root: Document, private readonly options: Options) {
    const el = <T extends HTMLElement>(id: string) => root.getElementById(id)! as T
    this.#dialog = el('peopleNostrDialog')
    this.#title = el('peopleNostrTitle')
    this.#status = el('peopleNostrStatus')
    this.#toggle = el('peopleNostrToggle')
    this.#refresh = el('peopleNostrRefresh')
    this.#compose = el('peopleNostrCompose')
    this.#actions = el('peopleNostrActions')
    this.#content = el('peopleNostrContent')
    root.getElementById('peopleNostrClose')!.addEventListener('click', () => this.close(true))
    this.#dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(true) })
    this.#dialog.addEventListener('close', () => { if (!this.#dialog.open) this.close() })
    root.defaultView?.addEventListener('pagehide', () => this.close())
    this.#toggle.addEventListener('click', event => {
      if (!event.isTrusted || !this.#current()) return
      this.#toggle.disabled = true
      void this.options.toggle().finally(() => { this.#toggle.disabled = false; this.reconcile() })
    })
    this.#refresh.addEventListener('click', () => { if (this.#current()) this.options.refresh() })
    el('peopleNostrRelays').addEventListener('click', () => { if (this.#current()) { this.close(); this.options.configure() } })
    this.#compose.addEventListener('click', () => this.#startMessage())
  }

  #current(): boolean {
    return this.#dialog.open && this.options.available() && !!this.#account && this.options.account() === this.#account
  }
  show(opener: HTMLElement, peer?: string): void {
    this.close()
    if (!this.options.available()) return
    this.#account = this.options.account()
    this.#opener = opener
    this.#peer = peer
    this.#dialog.showModal()
    this.reconcile()
    if (peer) this.#markRead()
  }

  showMessage(opener: HTMLElement, peer: string, messageId: string): void {
    this.show(this.#opener ?? opener, peer)
    this.#content.querySelector<HTMLElement>(`[data-message="${messageId}"]`)?.focus()
  }
  close(focus = false): void {
    this.#peer = undefined
    this.#account = undefined
    this.#painted = ''
    this.#content.replaceChildren()
    const opener = this.#opener
    this.#opener = undefined
    if (this.#dialog.open) this.#dialog.close()
    if (focus && opener?.isConnected) opener.focus({ preventScroll: true })
  }

  reconcile(): void {
    if (!this.#dialog.open) return
    if (!this.#current()) { this.close(); return }
    const enabled = this.options.enabled()
    const inbox = this.options.inbox()
    const threads = inbox?.threads().map(thread => {
      const contact = this.options.contact(thread.peer)
      const request = !contact.known && !thread.messages.some(message => message.author === this.#account)
      return { ...thread, ...contact, request, sendStatus: thread.messages.at(-1)?.sendStatus }
    }) ?? []
    const thread = threads.find(row => row.peer === this.#peer)
    if (!thread) this.#peer = undefined
    this.#status.textContent = this.options.status() || inbox?.status || (!enabled
      ? 'The Nostr inbox is turned off on this device.'
      : threads.length ? '' : 'No Nostr messages yet.')
    this.#toggle.textContent = enabled ? 'Turn off inbox' : 'Turn on inbox'
    this.#refresh.hidden = !enabled
    this.#compose.hidden = !enabled || !this.options.canCompose()
    this.#actions.hidden = !!thread
    this.#title.textContent = thread ? thread.name ?? shortNpub(thread.peer) : 'Nostr messages'
    const painted = JSON.stringify(thread
      ? [thread.peer, thread.name, thread.unread, thread.messages.map(row => [row.id, row.sendStatus]), this.options.canCompose()]
      : threads.map(({ peer, request, name, unread, picture, sendStatus }) => [peer, request, name, unread, picture, sendStatus]))
    if (painted === this.#painted) return
    this.#painted = painted
    const focused = this.#content.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : undefined
    const body = thread ? this.#thread(thread) : this.#list(threads)
    this.#content.replaceChildren(body)
    if (focused?.action) this.#content.querySelector<HTMLElement>(`[data-action="${focused.action}"]`)?.focus({ preventScroll: true })
    if (focused?.message) this.#content.querySelector<HTMLElement>(`[data-message="${focused.message}"]`)?.focus({ preventScroll: true })
  }

  #list(threads: { peer: string; request: boolean; name?: string; picture?: string; unread: number; sendStatus?: OrdinarySendStatus }[]): HTMLUListElement {
    const list = document.createElement('ul'); list.className = 'peopleNostrThreads'
    for (const row of threads) {
      const item = document.createElement('li')
      const label = row.name ?? shortNpub(row.peer)
      const button = this.#button('', () => {
        this.#peer = row.peer
        this.reconcile()
        this.#content.querySelector<HTMLElement>('[data-action="back"]')?.focus()
        this.#markRead()
      }, row.peer)
      button.setAttribute('aria-label', row.unread ? `${label}, ${row.unread} unread` : label)
      const description = document.createElement('span')
      description.className = 'peopleNostrThreadLabel'
      const name = document.createElement('span')
      name.className = 'peopleNostrThreadName'
      name.textContent = label
      description.append(name)
      if (row.request) {
        const request = document.createElement('small')
        request.className = 'note'
        request.id = `peopleNostrRequest-${row.peer}`
        request.textContent = 'Message request'
        description.append(request)
        button.setAttribute('aria-describedby', request.id)
      }
      if (row.sendStatus) {
        const status = sendStatusLabel(row.sendStatus)
        status.id = `peopleNostrDelivery-${row.peer}`
        button.setAttribute('aria-describedby', status.id)
        description.append(status)
      }
      button.append(personAvatar(row.peer, row.name, row.picture, 'personAvatar'), description)
      if (row.unread) {
        const count = document.createElement('span')
        count.className = 'peopleNostrThreadCount'
        count.textContent = String(row.unread)
        count.setAttribute('aria-hidden', 'true')
        button.append(count)
      }
      item.append(button); list.append(item)
    }
    return list
  }

  #thread(thread: ReturnType<PeopleNostrInbox['threads']>[number] & { name?: string }): DocumentFragment {
    const fragment = document.createDocumentFragment()
    const actions = document.createElement('div'); actions.className = 'peopleNostrActions'
    actions.append(this.#button('Back to messages', () => {
      const peer = this.#peer
      this.#peer = undefined; this.reconcile()
      this.#content.querySelector<HTMLElement>(`[data-action="${peer}"]`)?.focus()
    }, 'back'))
    if (thread.unread) actions.append(this.#button('Mark as read', () => this.#markRead(), 'read'))
    const messages = document.createElement('ol'); messages.className = 'peopleNostrTranscript'
    for (const row of thread.messages) {
      const item = document.createElement('li')
      item.dataset.message = row.id; item.tabIndex = -1
      const meta = document.createElement('p'); meta.className = 'note'
      const outgoing = row.author === this.#account
      const author = outgoing ? 'You' : thread.name ?? shortNpub(row.author)
      meta.textContent = `${author} · ${new Date(row.sentAt * 1000).toLocaleString()}`
      const body = document.createElement('p'); body.textContent = row.text
      item.append(meta, body)
      if (outgoing) item.append(sendStatusLabel(row.sendStatus))
      messages.append(item)
    }
    const footer = document.createElement('div'); footer.className = 'peopleNostrActions'
    if (this.options.canCompose()) footer.append(this.#button('Reply on Nostr', () => this.#startMessage({ peer: thread.peer, parent: thread.messages.at(-1)!.id }), 'reply'))
    const invite = this.#button('Invite to KithMoot chat', () => {
      invite.disabled = true
      void this.options.invite(thread.peer, thread.name).then(note => {
        if (note && this.#current() && this.#peer === thread.peer) this.#status.textContent = note
      }).finally(() => { invite.disabled = false })
    }, 'invite')
    footer.append(invite)
    footer.append(this.#button('Block sender', () => { this.options.block(thread.peer); this.reconcile() }, 'block'))
    fragment.append(actions, messages)
    fragment.append(footer)
    return fragment
  }

  #markRead(): void {
    const inbox = this.options.inbox()
    const thread = inbox?.threads().find(row => row.peer === this.#peer)
    if (thread?.unread) void inbox?.markRead(new Set(thread.messages.map(row => row.id)))
  }

  #startMessage(reply?: { peer: string; parent: string }): void {
    if (!this.#current() || !this.options.canCompose()) return
    const focus = this.#dialog.ownerDocument.activeElement
    const opener = focus instanceof HTMLElement && this.#dialog.contains(focus) ? focus : this.#opener!
    this.options.compose(opener, reply)
  }

  #button(text: string, action: () => void, id: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'quiet'; button.textContent = text; button.dataset.action = id
    button.addEventListener('click', event => { if (event.isTrusted && this.#current()) action() })
    return button
  }
}
