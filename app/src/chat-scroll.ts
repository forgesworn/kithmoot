/** Preserve the first visible message through redraws, including when older
 * history arrives or the retention cap removes messages above the reader. */
interface ReadingPlace {
  id?: string
  offset: number
  top: number
  follow: boolean
}

export class ChatScroll {
  #channel: string | undefined
  #ids = new Set<string>()
  #places = new Map<string, ReadingPlace>()
  #boundary: string | undefined
  readonly #log: HTMLElement
  readonly #button: HTMLButtonElement

  constructor(log: HTMLElement, button: HTMLButtonElement) {
    this.#log = log
    this.#button = button
    button.addEventListener('click', () => {
      this.latest()
      log.focus({ preventScroll: true })
    })
    log.addEventListener('scroll', () => {
      if (this.#atBottom()) button.hidden = true
    })
  }

  #atBottom(): boolean {
    return this.#log.scrollHeight - this.#log.clientHeight - this.#log.scrollTop < 48
  }

  reset(): void {
    this.#channel = undefined
    this.#ids.clear()
    this.#places.clear()
    this.#boundary = undefined
  }

  latest(): void {
    this.#button.hidden = true
    this.#log.scrollTop = this.#log.scrollHeight
  }

  #place(): ReadingPlace {
    const log = this.#log
    const edge = log.getBoundingClientRect().top
    const anchor = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find(el => el.getBoundingClientRect().bottom > edge)
    return {
      id: anchor?.dataset.messageId,
      offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
      top: log.scrollTop,
      follow: this.#atBottom(),
    }
  }

  /** Call before changing the composer or toolbar for another conversation. */
  remember(): void {
    if (this.#channel !== undefined) this.#places.set(this.#channel, this.#place())
  }

  before(channel: string, unread: ReadonlySet<string> = new Set()): () => void {
    const log = this.#log
    const changed = this.#channel !== channel
    const selectedId = changed ? undefined : log.querySelector<HTMLElement>('.searchTarget')?.dataset.messageId
    const active = log.ownerDocument.activeElement as HTMLElement | null
    const focusedMessage = !changed && active && log.contains(active) ? active.closest<HTMLElement>('[data-message-id]') : null
    const focusedId = focusedMessage?.dataset.messageId
    const focusKey = active?.dataset.focusKey
    const saved = changed ? this.#places.get(channel) : this.#place()
    if (changed) this.#boundary = undefined
    this.#channel = channel
    return () => {
      const messages = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
      const ids = new Set(messages.map(el => el.dataset.messageId!))
      const added = messages.some(el => !this.#ids.has(el.dataset.messageId!))
      this.#ids = ids
      const firstUnread = messages.find(el => unread.has(el.dataset.messageId!))
      // Keep the boundary still while reading, even when a repaint follows
      // an edit or a profile lookup. It resets on the next conversation visit.
      if (!this.#boundary && firstUnread && (changed || !saved?.follow)) this.#boundary = firstUnread.dataset.messageId
      const boundary = messages.find(el => el.dataset.messageId === this.#boundary)
      let divider: HTMLElement | undefined
      if (boundary) {
        // A new reading boundary needs its own sender heading, even when
        // it divides consecutive messages from the same person.
        boundary.classList.remove('continuation')
        divider = log.ownerDocument.createElement('div')
        divider.className = 'unreadDivider'
        divider.textContent = 'New messages'
        boundary.before(divider)
      }
      const selected = messages.find(el => el.dataset.messageId === selectedId)
      if (selected) {
        selected.classList.add('searchTarget')
        selected.tabIndex = -1
      }
      const replacement = messages.find(el => el.dataset.messageId === saved?.id)
      if (saved && !saved.follow && replacement) {
        log.scrollTop += replacement.getBoundingClientRect().top - log.getBoundingClientRect().top - saved.offset
        this.#button.hidden = this.#atBottom()
      } else if (changed && firstUnread) {
        const target = divider ?? firstUnread
        log.scrollTop += target.getBoundingClientRect().top - log.getBoundingClientRect().top
        this.#button.hidden = this.#atBottom()
      } else if (!saved || saved.follow) {
        log.scrollTop = log.scrollHeight
        this.#button.hidden = true
      } else {
        log.scrollTop = saved.top
        if (added || changed) this.#button.hidden = this.#atBottom()
      }
      if (focusedId) {
        const message = messages.find(el => el.dataset.messageId === focusedId)
        const control = focusKey && message
          ? Array.from(message.querySelectorAll<HTMLElement>('[data-focus-key]')).find(el => el.dataset.focusKey === focusKey)
          : undefined
        const target = control ?? message ?? log
        if (!control) target.tabIndex = -1
        target.focus({ preventScroll: true })
      }
    }
  }
}
