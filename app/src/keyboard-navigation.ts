/** Keyboard shortcuts operate only in the joined room and never through a modal. */
export function installKeyboardNavigation(root: Document): void {
  const get = (id: string) => root.getElementById(id)!
  const log = get('chatLog')
  const input = get('chatInput') as HTMLTextAreaElement
  const help = get('keyboardShortcuts') as HTMLDialogElement
  const available = (element: HTMLElement | null | undefined): element is HTMLElement => Boolean(element &&
    element.getClientRects().length && !element.closest('[hidden], [inert]') && !element.matches(':disabled') &&
    getComputedStyle(element).visibility !== 'hidden')
  let helpReturn: HTMLElement | undefined
  let helpMessage: { id: string; author: string; control?: string } | undefined
  let helpChannel: string | undefined
  const showHelp = (from: HTMLElement) => {
    helpReturn = from
    const row = from.closest<HTMLElement>('[data-message-id]')
    helpMessage = row ? { id: row.dataset.messageId!, author: row.dataset.messageAuthor!, control: from.dataset.focusKey } : undefined
    helpChannel = get('conversationNav').contains(from) ? from.dataset.channel : undefined
    help.showModal()
  }
  get('keyboardHelp').addEventListener('click', () => {
    const sheet = get('roomSheet') as HTMLDialogElement
    if (sheet.open) {
      sheet.addEventListener('close', () => showHelp(get('roomMenu')), { once: true })
      sheet.close()
    } else showHelp(get('keyboardHelp'))
  })
  get('keyboardShortcutsClose').addEventListener('click', () => help.close())
  help.addEventListener('close', () => {
    // The native dialog may restore focus before its queued close event.
    // Do not undo a shortcut or click the reader used in the meantime.
    const active = root.activeElement
    const restore = !active || active === root.body || active === helpReturn || help.contains(active)
    let target = helpReturn
    if (!available(target ?? null) && helpMessage) {
      const row = Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(row => row.dataset.messageId === helpMessage!.id && row.dataset.messageAuthor === helpMessage!.author)
      target = row && (Array.from(row.querySelectorAll<HTMLElement>('[data-focus-key]')).find(control => control.dataset.focusKey === helpMessage!.control) ?? row)
      if (target === row && row) row.tabIndex = -1
    }
    if (!available(target ?? null) && helpChannel !== undefined) target = Array.from(get('conversationNav').querySelectorAll<HTMLElement>('[data-channel]')).find(tab => tab.dataset.channel === helpChannel)
    if (!available(target ?? null)) target = log
    if (restore && available(target)) target.focus({ preventScroll: true })
    helpReturn = undefined; helpMessage = undefined; helpChannel = undefined
  })
  help.addEventListener('click', event => {
    if (event.target !== help) return
    const rect = help.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) help.close()
  })
  const focusMessage = (message: HTMLElement | undefined) => {
    if (!message) return
    message.tabIndex = -1
    message.focus({ preventScroll: true })
    message.scrollIntoView({ block: 'nearest' })
  }
  root.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || !available(get('roomArea')) ||
      root.querySelector('dialog[open], [popover]:popover-open')) return
    const active = root.activeElement as HTMLElement | null
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === '/') {
      event.preventDefault(); showHelp(active ?? log); return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'F6') {
      const sections = [
        [get('workspaceNav'), get('workspaceQuery')],
        [get('roomArea').querySelector<HTMLElement>('.roomBar')!, get('roomIdentity')],
        [get('conversationNav'), get('conversationNav').querySelector<HTMLElement>('[aria-pressed=true]')],
        [get('roomArea').querySelector<HTMLElement>('.conversationTools')!,
          Array.from(get('roomArea').querySelectorAll<HTMLElement>('.conversationTools button')).find(available) ?? null],
        [get('chatViewport'), log], [get('chatForm'), input],
      ].filter((section): section is [HTMLElement, HTMLElement] => available(section[0]) && available(section[1]))
      if (!sections.length) return
      const current = sections.findIndex(([section]) => active && section.contains(active))
      const next = current < 0 ? (event.shiftKey ? sections.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + sections.length) % sections.length
      event.preventDefault(); sections[next]![1].focus({ preventScroll: true }); return
    }
    if (event.ctrlKey || event.metaKey) return
    const messages = () => Array.from(log.querySelectorAll<HTMLElement>('[data-message-id]'))
    if (active === input) {
      if (event.key === 'ArrowUp' && !event.shiftKey && !input.value && input.getAttribute('aria-expanded') !== 'true') {
        const last = messages().at(-1)
        if (last) { event.preventDefault(); focusMessage(last) }
      }
      return
    }
    if (!active || !log.contains(active) || active.closest('input, textarea, select, [contenteditable=true]')) return
    const message = active.closest<HTMLElement>('[data-message-id]')
    if (event.key === 'Escape' && !event.shiftKey && available(input)) {
      event.preventDefault(); input.focus({ preventScroll: true }); return
    }
    // Arrow keys on a message's own button/link retain native behaviour.
    if (active !== log && active !== message) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || (!event.shiftKey && event.key === 'Enter')) {
      const more = message?.querySelector<HTMLButtonElement>('.messageMore')
      if (more) { event.preventDefault(); more.click() }
      return
    }
    if (event.shiftKey) return
    const rows = messages()
    const index = message ? rows.indexOf(message) : -1
    let next: number
    if (event.key === 'ArrowUp') next = index < 0 ? rows.length - 1 : Math.max(0, index - 1)
    else if (event.key === 'ArrowDown') next = index < 0 ? 0 : Math.min(rows.length - 1, index + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else return
    if (rows[next]) { event.preventDefault(); focusMessage(rows[next]) }
  })
}
