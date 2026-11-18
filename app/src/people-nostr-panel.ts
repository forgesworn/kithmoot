import './people-nostr.css'
import { shortNpub } from './people.js'
import type { PeopleNostrInbox } from './people-nostr-inbox.js'

interface Options {
  account(): string | undefined
  available(): boolean
  enabled(): boolean
  toggle(): Promise<void>
  refresh(): void
  inbox(): PeopleNostrInbox | undefined
  status(): string
  contact(peer: string): { name?: string; known: boolean }
  configure(): void
  compose(opener: HTMLElement, reply?: { peer: string; parent: string }): void
  canCompose(): boolean
  remoteSigner(): boolean
  invite(peer: string, name?: string): Promise<string | undefined>
  block(peer: string): void
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
  show(opener: HTMLElement): void {
    this.close()
    if (!this.options.available()) return
    this.#account = this.options.account()
    this.#opener = opener
    this.#dialog.showModal()
    this.reconcile()
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
    const threads = inbox?.threads().map(thread => ({ ...thread, ...this.options.contact(thread.peer) })) ?? []
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
      ? [thread.peer, thread.name, thread.unread, thread.messages.map(row => row.id), this.options.canCompose()]
      : threads.map(({ peer, known, name, unread }) => [peer, known, name, unread]))
    if (painted === this.#painted) return
    this.#painted = painted
    const focused = this.#content.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined
    const body = thread ? this.#thread(thread) : this.#list(threads)
    this.#content.replaceChildren(body)
    if (focused) this.#content.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true })
  }

  #list(threads: { peer: string; known: boolean; name?: string; unread: number }[]): DocumentFragment {
    const fragment = document.createDocumentFragment()
    for (const [title, known] of [['Message requests', false], ['Messages', true]] as const) {
      const rows = threads.filter(thread => thread.known === known)
      if (!rows.length) continue
      const heading = document.createElement('h3'); heading.textContent = title
      const list = document.createElement('ul'); list.className = 'peopleNostrThreads'
      for (const row of rows) {
        const item = document.createElement('li')
        const label = row.name ?? shortNpub(row.peer)
        const button = this.#button(row.unread ? `${label} (${row.unread})` : label, () => {
          this.#peer = row.peer
          this.reconcile()
          this.#content.querySelector<HTMLElement>('[data-action="back"]')?.focus()
          this.#markRead()
        }, row.peer)
        if (row.unread) button.setAttribute('aria-label', `${label}, ${row.unread} unread`)
        item.append(button); list.append(item)
      }
      fragment.append(heading, list)
    }
    return fragment
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
      const meta = document.createElement('p'); meta.className = 'note'
      const author = row.author === this.#account ? 'You' : thread.name ?? shortNpub(row.author)
      meta.textContent = `${author} · ${new Date(row.sentAt * 1000).toLocaleString()}`
      const body = document.createElement('p'); body.textContent = row.text
      item.append(meta, body); messages.append(item)
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
    if (this.options.remoteSigner() && !this.options.canCompose()) {
      const note = document.createElement('p'); note.className = 'note'
      note.textContent = 'Remote signer connected for incoming Nostr messages only.'
      fragment.append(note)
    }
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
