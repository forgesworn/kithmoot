export interface MessageAction {
  label: string
  text?: string
  danger?: boolean
  pressed?: boolean
  run: () => void
}

/** One lightweight action panel, outside the repainted conversation log. */
export class MessageActions {
  readonly #panel = document.createElement('div')
  #anchor: HTMLElement | undefined
  #target: { id: string; author: string; focusKey?: string } | undefined

  constructor() {
    this.#panel.id = 'messageActionPanel'
    this.#panel.className = 'messageActionPanel'
    this.#panel.popover = 'auto'
    this.#panel.setAttribute('role', 'dialog')
    this.#panel.setAttribute('aria-label', 'Message actions')
    document.body.append(this.#panel)
    this.#panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.close() }
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const buttons = Array.from(this.#panel.querySelectorAll('button'))
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        event.preventDefault()
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    })
    this.#panel.addEventListener('focusout', () => queueMicrotask(() => {
      const focused = document.activeElement
      if (this.#target && focused !== document.body && focused !== this.#anchor && !this.#panel.contains(focused)) this.close(false)
    }))
    this.#panel.addEventListener('toggle', event => {
      if ((event as ToggleEvent).newState === 'closed' && this.#target) this.close(document.activeElement === document.body)
    })
    window.addEventListener('resize', () => this.#position())
    document.getElementById('chatLog')?.addEventListener('scroll', () => this.#position(), { passive: true })
    window.visualViewport?.addEventListener('resize', () => this.#position())
  }

  open(anchor: HTMLElement, actions: MessageAction[], reactions: MessageAction[]): void {
    if (this.#anchor === anchor && this.#target) { this.close(); return }
    this.close(false)
    const row = anchor.closest<HTMLElement>('[data-message-id]')!
    this.#target = { id: row.dataset.messageId!, author: row.dataset.messageAuthor!, focusKey: anchor.dataset.focusKey }
    this.#anchor = anchor
    anchor.setAttribute('aria-expanded', 'true')
    const preview = document.createElement('p')
    preview.className = 'messageActionPreview'
    preview.textContent = row.querySelector('.bubble .text')?.textContent ?? ''
    this.#panel.replaceChildren(preview)
    const add = (action: MessageAction, into: HTMLElement): void => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.text ?? action.label
      button.setAttribute('aria-label', action.label)
      if (action.danger) button.className = 'danger'
      if (action.pressed !== undefined) button.setAttribute('aria-pressed', String(action.pressed))
      button.addEventListener('click', () => {
        if (!this.refresh()) return
        this.close()
        action.run()
      })
      into.append(button)
    }
    for (const action of actions) add(action, this.#panel)
    const group = document.createElement('div')
    group.className = 'messageReactionChoices'
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'React to this message')
    for (const reaction of reactions) add(reaction, group)
    this.#panel.append(group)
    this.#panel.showPopover()
    this.#position()
    this.#panel.querySelector('button')?.focus({ preventScroll: true })
  }

  /** Follow the same message after incoming messages or edits repaint it. */
  refresh(): boolean {
    if (!this.#target) return false
    const target = this.#target
    const row = Array.from(document.querySelectorAll<HTMLElement>('#chatLog [data-message-id]'))
      .find(row => row.dataset.messageId === target.id && row.dataset.messageAuthor === target.author)
    const anchor = Array.from(row?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? [])
      .find(button => button.dataset.focusKey === target.focusKey)
    if (!anchor) { this.close(); return false }
    this.#anchor = anchor
    anchor.setAttribute('aria-expanded', 'true')
    this.#panel.querySelector('p')!.textContent = row?.querySelector('.bubble .text')?.textContent ?? ''
    this.#position()
    return true
  }

  close(restore = true): void {
    const anchor = this.#anchor
    this.#target = undefined
    this.#anchor = undefined
    anchor?.setAttribute('aria-expanded', 'false')
    if (this.#panel.matches(':popover-open')) this.#panel.hidePopover()
    if (restore) (anchor?.isConnected ? anchor : document.getElementById('chatLog'))?.focus({ preventScroll: true })
  }

  #position(): void {
    if (!this.#anchor || !this.#panel.matches(':popover-open')) return
    const anchor = this.#anchor.getBoundingClientRect()
    const panel = this.#panel.getBoundingClientRect()
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? innerWidth
    const height = viewport?.height ?? innerHeight
    this.#panel.style.left = `${Math.max(left + 8, Math.min(anchor.right - panel.width, left + width - panel.width - 8))}px`
    const below = anchor.bottom + 6
    this.#panel.style.top = `${Math.max(top + 8, Math.min(below + panel.height <= top + height - 8 ? below : anchor.top - panel.height - 6, top + height - panel.height - 8))}px`
  }
}
