/** Preserve the first visible message through redraws, including when older
 * history arrives or the retention cap removes messages above the reader. */
interface ReadingPlace {
  id?: string
  offset: number
  top: number
  follow: boolean
}

export class ChatScroll {
  #scope = ''
  #paused = true
  #pending?: ReadingPlace
  #painted?: { top: number; place: ReadingPlace }
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
      if (!this.#pending && this.#atBottom()) button.hidden = true
    })
    // An explicit reading gesture takes precedence over history arriving late.
    const readingGesture = () => { this.#pending = undefined; this.#painted = undefined }
    for (const event of ['wheel', 'touchstart', 'pointerdown']) log.addEventListener(event, readingGesture, { passive: true })
    log.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) readingGesture()
    })
    log.addEventListener('focusin', event => {
      if ((event.target as HTMLElement).closest('.searchTarget')) readingGesture()
    })
    new ResizeObserver(() => {
      // Navigation and roster updates can resize the log after its last
      // redraw. Keep a reader who chose the latest messages at the bottom.
      if (this.#paused || this.#pending || !this.#painted?.place.follow) return
      if (log.scrollTop !== this.#painted.top && log.scrollTop < log.scrollHeight - log.clientHeight) return
      log.scrollTop = log.scrollHeight
      this.#painted = { top: log.scrollTop, place: this.#place() }
    }).observe(log)
  }

  #atBottom(): boolean {
    return this.#log.scrollHeight - this.#log.clientHeight - this.#log.scrollTop < 48
  }

  /** Freeze before tearing down a room; hidden or empty logs cannot replace it. */
  suspend(): void {
    this.remember()
    this.#paused = true
    this.#channel = undefined
    this.#ids.clear()
    this.#boundary = undefined
    this.#pending = undefined
    this.#painted = undefined
  }

  /** Resume only after the joined room is visible and can be measured. */
  resume(scope: string): void { this.#scope = scope; this.#paused = false }

  get restoring(): boolean { return this.#paused || this.#pending !== undefined }

  latest(): void {
    this.#pending = undefined
    this.#button.hidden = true
    this.#log.scrollTop = this.#log.scrollHeight
    this.#painted = { top: this.#log.scrollTop, place: this.#place() }
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

  #readingPlace(): ReadingPlace {
    // Keep the intended offset through fractional pixel rounding and layout
    // changes. A reader moving the scrollbar starts a new position.
    return this.#painted?.top === this.#log.scrollTop ? this.#painted.place : this.#place()
  }

  /** Call before changing the composer or toolbar for another conversation. */
  remember(): void {
    if (!this.#paused && this.#channel !== undefined) this.#places.set(this.#channel, this.#pending ?? this.#readingPlace())
  }

  before(channel: string, unread: ReadonlySet<string> = new Set()): () => void {
    if (this.#paused) return () => {}
    channel = JSON.stringify([this.#scope, channel])
    const log = this.#log
    const changed = this.#channel !== channel
    const selectedId = changed ? undefined : log.querySelector<HTMLElement>('.searchTarget')?.dataset.messageId
    const active = log.ownerDocument.activeElement as HTMLElement | null
    const focusedMessage = !changed && active && log.contains(active) ? active.closest<HTMLElement>('[data-message-id]') : null
    const focusedId = focusedMessage?.dataset.messageId
    const focusKey = active?.dataset.focusKey
    const saved = changed ? this.#places.get(channel) : this.#pending ?? this.#readingPlace()
    if (changed) {
      this.#boundary = undefined
      this.#pending = saved?.id && !saved.follow ? saved : undefined
    }
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
        this.#button.hidden = false
        log.scrollTop += replacement.getBoundingClientRect().top - log.getBoundingClientRect().top - saved.offset
        // The anchor can arrive before enough following history exists to
        // scroll it into place. Keep the latest button visible (it affects
        // the log's height) until the reader's position fits above the bottom.
        this.#pending = !this.#atBottom() && Math.abs(replacement.getBoundingClientRect().top - log.getBoundingClientRect().top - saved.offset) < 1 ? undefined : saved
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
      // The old message may be delayed or no longer retained. Always leave a
      // visible way to choose the latest messages and abandon restoration.
      if (this.#pending) this.#button.hidden = false
      this.#painted = { top: log.scrollTop, place: saved && !saved.follow && replacement ? { ...saved, top: log.scrollTop } : this.#place() }
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
