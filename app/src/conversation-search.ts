import type { ChatMessage } from '../../src/chat.js'
import { resolveConversation, type ResolvedMessage } from '../../src/messages.js'

export interface SearchConversation {
  channel: string | undefined
  label: string
  messages: ChatMessage[]
}

interface SearchResult {
  channel: string | undefined
  label: string
  message: ResolvedMessage
}

const resultKey = (result: SearchResult): string =>
  JSON.stringify([result.channel ?? '', result.message.original.participant, result.message.original.id])

/** Searches the room's already decrypted history. Queries and results stay
 * in this tab; searching never subscribes to another room or fetches files. */
export class ConversationSearch {
  readonly #dialog: HTMLDialogElement
  readonly #query: HTMLInputElement
  readonly #files: HTMLInputElement
  readonly #conversation: HTMLSelectElement
  readonly #results: HTMLElement
  readonly #status: HTMLElement
  readonly #back: HTMLButtonElement
  readonly #more: HTMLButtonElement
  readonly #log: HTMLElement
  readonly #select: (channel: string | undefined) => void
  #returnFocus: HTMLElement
  #conversations: SearchConversation[] = []
  #active: string | undefined
  #jump: SearchResult | undefined
  #lastResult: string | undefined
  #limit = 100
  #name: (message: ChatMessage) => string = message => message.name ?? message.participant.slice(0, 8)

  constructor(root: Document, select: (channel: string | undefined) => void) {
    this.#select = select
    this.#dialog = root.getElementById('conversationSearch') as HTMLDialogElement
    this.#query = root.getElementById('messageSearchQuery') as HTMLInputElement
    this.#files = root.getElementById('messageSearchFiles') as HTMLInputElement
    this.#conversation = root.getElementById('messageSearchConversation') as HTMLSelectElement
    this.#results = root.getElementById('messageSearchResults')!
    this.#status = root.getElementById('messageSearchStatus')!
    this.#back = root.getElementById('backToSearch') as HTMLButtonElement
    this.#more = root.getElementById('messageSearchMore') as HTMLButtonElement
    this.#returnFocus = root.getElementById('roomMenu')!
    this.#log = root.getElementById('chatLog')!
    const refine = () => { this.#limit = 100; this.#render() }
    this.#query.addEventListener('input', refine)
    this.#files.addEventListener('change', refine)
    this.#conversation.addEventListener('change', refine)
    this.#more.addEventListener('click', () => {
      const firstNew = this.#limit
      this.#limit += 100
      this.#render()
      this.#results.querySelectorAll<HTMLButtonElement>('button')[firstNew]?.focus()
    })
    this.#back.addEventListener('click', () => {
      this.#returnFocus = this.#back
      this.#render()
      this.#dialog.showModal()
      const result = Array.from(this.#results.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.dataset.resultKey === this.#lastResult)
      ;(result ?? this.#query).focus({ preventScroll: true })
    })
    // Search inputs consume Escape to clear their value in some browsers.
    this.#dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      this.#dialog.close()
    }, { capture: true })
    root.getElementById('messageSearchClose')!.addEventListener('click', () => this.#dialog.close())
    this.#dialog.addEventListener('close', () => {
      const jump = this.#jump
      this.#jump = undefined
      if (jump) {
        // The selected message receives focus after dialog restoration.
        const target = Array.from(this.#log.querySelectorAll<HTMLElement>('[data-message-id]'))
          .find(element => element.dataset.messageId === jump.message.original.id && element.dataset.messageAuthor === jump.message.original.participant)
        if (target) {
          this.#log.querySelector('.searchTarget')?.classList.remove('searchTarget')
          target.classList.add('searchTarget')
          target.tabIndex = -1
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'center' })
        } else this.#log.focus({ preventScroll: true })
        return
      }
      this.#query.value = ''
      this.#files.checked = false
      this.#results.replaceChildren()
      this.#status.textContent = ''
      this.#back.hidden = true
      this.#lastResult = undefined
      const opener = this.#returnFocus === this.#back ? root.getElementById('chatSearch')! : this.#returnFocus
      opener.focus({ preventScroll: true })
    })
  }

  reset(): void {
    this.#jump = undefined
    this.#lastResult = undefined
    this.#conversations = []
    this.#active = undefined
    this.#query.value = ''
    this.#files.checked = false
    this.#results.replaceChildren()
    this.#status.textContent = ''
    this.#back.hidden = true
    this.#dialog.close()
  }

  update(conversations: SearchConversation[], active: string | undefined, name: (message: ChatMessage) => string): void {
    this.#conversations = conversations
    this.#active = active
    this.#name = name
    if (this.#dialog.open) this.#render()
  }

  open(returnFocus?: HTMLElement, scope: 'room' | 'conversation' = 'room'): void {
    if (this.#dialog.open) return
    this.#returnFocus = returnFocus ?? this.#dialog.ownerDocument.getElementById('roomMenu')!
    this.#query.value = ''
    this.#files.checked = false
    this.#back.hidden = true
    this.#lastResult = undefined
    this.#limit = 100
    this.#options(scope === 'room' ? '*' : this.#active ?? '')
    this.#render()
    this.#dialog.showModal()
    this.#query.focus()
  }

  #options(selected: string): void {
    const options = [['*', 'All conversations'], ...this.#conversations.map(conversation => [conversation.channel ?? '', conversation.label])]
    // Leave a focused select in place when only messages, not channels, change.
    if (JSON.stringify(Array.from(this.#conversation.options, option => [option.value, option.text])) !== JSON.stringify(options)) {
      this.#conversation.replaceChildren(...options.map(([value, label]) => new Option(label, value)))
    }
    this.#conversation.value = options.some(([value]) => value === selected) ? selected : '*'
  }

  #render(): void {
    this.#options(this.#conversation.value)
    const query = this.#query.value.trim().toLocaleLowerCase()
    const filesOnly = this.#files.checked
    const scope = this.#conversation.value
    const focusedKey = (this.#results.ownerDocument.activeElement as HTMLElement | null)?.dataset.resultKey
    const entries: SearchResult[] = []
    for (const conversation of this.#conversations) {
      if (scope !== '*' && scope !== (conversation.channel ?? '')) continue
      const walk = (message: ResolvedMessage): void => {
        if (!message.retracted) entries.push({ channel: conversation.channel, label: conversation.label, message })
        for (const reply of message.replies) walk(reply)
      }
      for (const message of resolveConversation(conversation.messages).stream) walk(message)
    }
    const label = scope === '*' ? 'All conversations' : this.#conversations.find(conversation => (conversation.channel ?? '') === scope)?.label ?? 'Conversation'
    this.#dialog.querySelector('#messageSearchScope')!.textContent =
      `${label} · ${entries.length} loaded message${entries.length === 1 ? '' : 's'}. Search stays on this device.`
    this.#results.replaceChildren()
    this.#more.hidden = true
    if (!query && !filesOnly) {
      this.#status.textContent = 'Find a message, a person or a file name across this room. Choose Files only to browse shared files.'
      return
    }
    const matches = entries.filter(({ message: { shown: message } }) => {
      if (filesOnly && !message.attachments?.length) return false
      const text = [message.text, this.#name(message), message.name ?? '',
        ...(message.attachments ?? []).map(file => file.name ?? 'Encrypted file')].join('\n')
      return text.toLocaleLowerCase().includes(query)
    }).sort((a, b) => b.message.original.sentAt - a.message.original.sentAt || resultKey(b).localeCompare(resultKey(a)))
    this.#status.textContent = matches.length
      ? `${matches.length} matching message${matches.length === 1 ? '' : 's'}. Newest first.${matches.length > this.#limit ? ` Showing ${this.#limit}.` : ''}`
      : 'No matching messages in the loaded history. Try another word or conversation.'
    this.#more.hidden = matches.length <= this.#limit
    this.#more.textContent = `Show ${Math.min(100, Math.max(0, matches.length - this.#limit))} more results`

    for (const result of matches.slice(0, this.#limit)) {
      const { shown: message, original } = result.message
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.resultId = original.id
      button.dataset.resultKey = resultKey(result)
      const conversation = document.createElement('span')
      conversation.className = 'searchConversation'
      conversation.textContent = result.label
      const sender = document.createElement('span')
      sender.className = 'searchSender'
      sender.textContent = `${this.#name(message)} · ${message.participant.slice(0, 8)}`
      const time = document.createElement('time')
      const date = new Date(original.sentAt * 1000)
      time.dateTime = date.toISOString()
      time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      button.append(conversation, sender, time)
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
        this.#jump = result
        this.#lastResult = resultKey(result)
        this.#back.hidden = false
        // Keep the sheet open during the switch so landing at the bottom
        // cannot mark an unseen conversation read before the result is shown.
        if (result.channel !== this.#active) this.#select(result.channel)
        this.#dialog.close()
      })
      item.append(button)
      this.#results.append(item)
      if (focusedKey === resultKey(result)) button.focus({ preventScroll: true })
    }
    // If a focused result is retracted, do not leave keyboard focus on body.
    if (focusedKey && !this.#results.querySelector('button:focus')) this.#query.focus({ preventScroll: true })
  }
}
