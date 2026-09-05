/** Preserve the first visible message through redraws, including when older
 * history arrives or the retention cap removes messages above the reader. */
export class ChatScroll {
  #channel: string | undefined
  #ids = new Set<string>()
  readonly #log: HTMLElement
  readonly #button: HTMLButtonElement

  constructor(log: HTMLElement, button: HTMLButtonElement) {
    this.#log = log
    this.#button = button
    button.addEventListener('click', () => this.latest())
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
  }

  latest(): void {
    this.#button.hidden = true
    this.#log.scrollTop = this.#log.scrollHeight
  }

  before(channel: string): () => void {
    const log = this.#log
    const changed = this.#channel !== channel
    const selectedId = changed ? undefined : log.querySelector<HTMLElement>('.searchTarget')?.dataset.messageId
    const active = log.ownerDocument.activeElement as HTMLElement | null
    const focusedMessage = !changed && active && log.contains(active) ? active.closest<HTMLElement>('[data-message-id]') : null
    const focusedId = focusedMessage?.dataset.messageId
    const focusKey = active?.dataset.focusKey
    const follow = changed || this.#atBottom()
    const top = log.scrollTop
    const edge = log.getBoundingClientRect().top
    const anchor = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find(el => el.getBoundingClientRect().bottom > edge)
    const id = anchor?.dataset.messageId
    const offset = anchor ? anchor.getBoundingClientRect().top - edge : 0
    this.#channel = channel
    return () => {
      const messages = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
      const ids = new Set(messages.map(el => el.dataset.messageId!))
      const added = messages.some(el => !this.#ids.has(el.dataset.messageId!))
      this.#ids = ids
      const selected = messages.find(el => el.dataset.messageId === selectedId)
      if (selected) {
        selected.classList.add('searchTarget')
        selected.tabIndex = -1
      }
      if (follow) {
        log.scrollTop = log.scrollHeight
        this.#button.hidden = true
      } else {
        const replacement = messages.find(el => el.dataset.messageId === id)
        log.scrollTop = replacement
          ? log.scrollTop + replacement.getBoundingClientRect().top - log.getBoundingClientRect().top - offset
          : top
        if (added) this.#button.hidden = false
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
