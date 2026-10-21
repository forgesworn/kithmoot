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
  #painted?: { top: number; height: number; width: number; total: number; place: ReadingPlace }
  #channel: string | undefined
  #ids = new Set<string>()
  #places = new Map<string, ReadingPlace>()
  #boundary: string | undefined
  #enterLatest = false
  /** Set while the reader has been taken to a message further up (a quote
   *  followed): the latest button stays until they scroll or press it. */
  #jumped = false
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
      if (this.#jumped) { if (!this.#atBottom()) button.hidden = false }
      else if (!this.#pending && this.#atBottom()) button.hidden = true
      // Scrollbars and accessibility tools can move the reader without a
      // pointer event. A scroll in an unchanged layout abandons follow mode;
      // WebKit's automatic anchoring during a resize does not.
      const painted = this.#painted
      if (painted && log.scrollTop !== painted.top && log.clientHeight === painted.height && log.scrollHeight === painted.total) this.#painted = undefined
    })
    // An explicit reading gesture takes precedence over history arriving late.
    const readingGesture = () => { this.#pending = undefined; this.#painted = undefined; this.#jumped = false }
    // Pressing a control inside the log (React, More, a link) still ends a
    // pending restore, as any gesture does, but it is not reading: it must
    // not drop a reader who is at the bottom out of follow mode, or the
    // reaction they just added lands under the log's edge (#458). A drag that
    // starts on one still scrolls, and the scroll handler above notices.
    const onControl = (event: Event) => event.target instanceof Element && !!event.target.closest('button, a, summary, input, textarea')
    for (const event of ['wheel', 'touchstart', 'pointerdown']) {
      log.addEventListener(event, e => {
        if (event !== 'wheel' && onControl(e)) this.#pending = undefined
        else readingGesture()
      }, { passive: true })
    }
    // A picture or sticker that finishes loading under the newest message
    // makes the log taller after it was painted; a reader at the bottom
    // stays there.
    log.addEventListener('load', () => this.#stay(), true)
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
      // WebKit can deliver resize before a queued scrollbar/programmatic
      // scroll event. A move beyond the resize's anchoring allowance means
      // the reader already left the bottom; do not reinstate follow mode.
      // A new width is different: every message reflows, and scroll
      // anchoring holds the top message still by moving as far as the text
      // above it grew, which can be thousands of pixels.
      const resizedBy = Math.abs(log.clientHeight - this.#painted.height)
      const reflowed = log.clientWidth !== this.#painted.width
      if (!reflowed && Math.abs(log.scrollTop - this.#painted.top) > resizedBy + 48) {
        this.#paint()
        return
      }
      log.scrollTop = log.scrollHeight
      this.#paint()
    }).observe(log)
  }

  /** Content grew under a reader who is following the latest messages. */
  #stay(): void {
    if (this.#paused || this.#pending || !this.#painted?.place.follow) return
    this.#log.scrollTop = this.#log.scrollHeight
    this.#paint()
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
  resume(scope: string): void { this.#scope = scope; this.#paused = false; this.#enterLatest = true }

  get restoring(): boolean { return this.#paused || this.#pending !== undefined }

  /**
   * Take the reader to a message: centred, smooth only when asked, focus on
   * the row, and the way back one press away on the latest button. Used by
   * the quote inside a reply. The row is made focusable here when it has no
   * focusable target of its own.
   */
  jumpTo(row: HTMLElement, smooth: boolean): void {
    this.#pending = undefined
    this.#painted = undefined
    this.#jumped = true
    row.tabIndex = -1
    // Only the log moves, and only up or down: scrollIntoView would also
    // scroll the page's fixed panes sideways when a row is wider than the
    // screen, which clipped the log on a 320 px phone.
    const log = this.#log.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    const top = this.#log.scrollTop + (box.top - log.top) - Math.max(0, (this.#log.clientHeight - box.height) / 2)
    this.#log.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
    row.focus({ preventScroll: true })
    this.#button.hidden = false
    const settle = () => {
      this.#log.removeEventListener('scrollend', settle)
      clearTimeout(timer)
      this.#jumped = false
      this.#button.hidden = this.#atBottom()
      this.#paint()
    }
    // `scrollend` is not everywhere; a smooth scroll is done well inside a second.
    const timer = setTimeout(settle, smooth ? 900 : 60)
    this.#log.addEventListener('scrollend', settle, { once: true })
  }

  latest(): void {
    this.#jumped = false
    this.#pending = undefined
    this.#button.hidden = true
    this.#log.scrollTop = this.#log.scrollHeight
    this.#paint()
  }

  #paint(place = this.#place()): void {
    this.#painted = { top: this.#log.scrollTop, height: this.#log.clientHeight, width: this.#log.clientWidth, total: this.#log.scrollHeight, place }
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

  before(channel: string, unread: ReadonlySet<string> = new Set(), keepReading = false): () => void {
    if (this.#paused) return () => {}
    channel = JSON.stringify([this.#scope, channel])
    const log = this.#log
    const changed = this.#channel !== channel
    const entering = this.#enterLatest
    this.#enterLatest = false
    const selectedId = changed ? undefined : log.querySelector<HTMLElement>('.searchTarget')?.dataset.messageId
    const active = log.ownerDocument.activeElement as HTMLElement | null
    const focusedMessage = !changed && active && log.contains(active) ? active.closest<HTMLElement>('[data-message-id]') : null
    const focusedId = focusedMessage?.dataset.messageId
    const focusKey = active?.dataset.focusKey
    // Entering a room starts at its latest messages. Switching conversations
    // within that room still preserves an intentional reading position.
    let saved = entering ? undefined : changed ? this.#places.get(channel) : this.#pending ?? this.#readingPlace()
    // An open receipt is being read even when its message was at the bottom.
    if (keepReading && saved) saved = { ...saved, follow: false }
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
      } else if (changed && firstUnread && !entering) {
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
      this.#paint(saved && !saved.follow && replacement ? { ...saved, top: log.scrollTop } : this.#place())
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
