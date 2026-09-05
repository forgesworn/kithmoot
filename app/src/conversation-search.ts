import type { ChatMessage } from '../../src/chat.js'

/** Searches only the conversation already decrypted in this tab. No relay
 * queries, attachment downloads or persisted search history. */
export class ConversationSearch {
  readonly #dialog: HTMLDialogElement
  readonly #query: HTMLInputElement
  readonly #files: HTMLInputElement
  readonly #results: HTMLElement
  readonly #status: HTMLElement
  #returnFocus: HTMLElement
  readonly #log: HTMLElement
  #messages: ChatMessage[] = []
  #name: (message: ChatMessage) => string = message => message.name ?? message.participant.slice(0, 8)

  constructor(root: Document) {
    this.#dialog = root.getElementById('conversationSearch') as HTMLDialogElement
    this.#query = root.getElementById('messageSearchQuery') as HTMLInputElement
    this.#files = root.getElementById('messageSearchFiles') as HTMLInputElement
    this.#results = root.getElementById('messageSearchResults')!
    this.#status = root.getElementById('messageSearchStatus')!
    this.#returnFocus = root.getElementById('roomMenu')!
    this.#log = root.getElementById('chatLog')!
    this.#query.addEventListener('input', () => this.#render())
    this.#files.addEventListener('change', () => this.#render())
    // Search inputs consume Escape to clear their value in some browsers.
    // In this sheet Escape consistently closes it and returns to the room.
    this.#dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      this.#dialog.close()
    }, { capture: true })
    root.getElementById('messageSearchClose')!.addEventListener('click', () => this.#dialog.close())
    this.#dialog.addEventListener('close', () => {
      this.#query.value = ''
      this.#files.checked = false
      this.#results.replaceChildren()
      this.#status.textContent = ''
      this.#returnFocus.focus({ preventScroll: true })
    })
  }

  update(messages: ChatMessage[], label: string, name: (message: ChatMessage) => string): void {
    messages = messages.filter(message => !message.reaction)
    this.#messages = messages
    this.#name = name
    this.#dialog.querySelector('#messageSearchScope')!.textContent =
      `${label} · ${messages.length} loaded message${messages.length === 1 ? '' : 's'}. ` +
      'Search stays on this device. Only loaded history is included, up to 500 messages from the last 30 days. Files are searched by name; nothing is downloaded.'
    if (this.#dialog.open) this.#render()
  }

  open(returnFocus?: HTMLElement): void {
    if (this.#dialog.open) return
    this.#returnFocus = returnFocus ?? this.#dialog.ownerDocument.getElementById('roomMenu')!
    this.#render()
    this.#dialog.showModal()
    this.#query.focus()
  }

  #render(): void {
    const query = this.#query.value.trim().toLocaleLowerCase()
    const filesOnly = this.#files.checked
    const focusedId = (this.#results.ownerDocument.activeElement as HTMLElement | null)?.dataset.resultId
    this.#results.replaceChildren()
    if (!query && !filesOnly) {
      this.#status.textContent = 'Find a message, a person or a file name. Choose Files only to browse shared files.'
      return
    }
    const matches = this.#messages.filter(message => {
      if (filesOnly && !message.attachments?.length) return false
      const text = [message.text, this.#name(message), message.name ?? '',
        ...(message.attachments ?? []).map(file => file.name ?? 'Encrypted file')].join('\n')
      return text.toLocaleLowerCase().includes(query)
    }).slice().reverse()
    this.#status.textContent = matches.length
      ? `${matches.length} matching message${matches.length === 1 ? '' : 's'}. Newest first.`
      : 'No matching messages in the loaded history. Try another word or conversation.'

    for (const message of matches) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.resultId = message.id
      const sender = document.createElement('span')
      sender.className = 'searchSender'
      sender.textContent = `${this.#name(message)} · ${message.participant.slice(0, 8)}`
      const time = document.createElement('time')
      const date = new Date(message.sentAt * 1000)
      time.dateTime = date.toISOString()
      time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      button.append(sender, time)
      const text = document.createElement('span')
      text.className = 'searchExcerpt'
      const at = message.text.toLocaleLowerCase().indexOf(query)
      const start = Math.max(0, at - 60)
      const excerpt = message.text.slice(start, start + 240)
      text.textContent = `${start ? '…' : ''}${excerpt}${start + excerpt.length < message.text.length ? '…' : ''}`
      button.append(text)
      if (message.attachments?.length) {
        const files = document.createElement('span')
        files.className = 'searchFiles'
        files.textContent = message.attachments.map(file => file.name ?? 'Encrypted file').join(' · ')
        button.append(files)
      }
      button.addEventListener('click', () => {
        const target = Array.from(this.#log.querySelectorAll<HTMLElement>('[data-message-id]'))
          .find(element => element.dataset.messageId === message.id)
        if (!target) {
          this.#status.textContent = 'That message is no longer in the loaded history.'
          return
        }
        // The dialog's close event restores its opener. Move focus after
        // that event so keyboard readers land on the selected message.
        this.#dialog.addEventListener('close', () => {
          this.#log.querySelector('.searchTarget')?.classList.remove('searchTarget')
          target.classList.add('searchTarget')
          target.tabIndex = -1
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'center' })
        }, { once: true })
        this.#dialog.close()
      })
      item.append(button)
      this.#results.append(item)
      if (focusedId === message.id) button.focus({ preventScroll: true })
    }
  }
}
