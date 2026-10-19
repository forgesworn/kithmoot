/**
 * The app's popover menu: one keyboard model for the New menu, a chat row's
 * ⋯ menu and, in stage 3, the room's own ⋯ (design-calm-shell, section 9.1).
 *
 * The menu is a native popover, so it sits in the top layer and a screen
 * reader that knows `role="menu"` reads it as one. It is `popover="manual"`
 * and closes itself on a click elsewhere: the browser's own light dismiss
 * closes a menu opened by a right-click on the button's release, which is
 * the same gesture that opened it. What the browser does not give is the
 * model a menu promises:
 *
 *  - the opener says `aria-haspopup="menu"` and `aria-expanded`;
 *  - opening moves focus to the first item (Down on the opener, or a click);
 *  - Up and Down move, wrapping; Home and End jump; a letter jumps to the
 *    next item that starts with it;
 *  - Escape closes and returns focus to the opener;
 *  - Tab closes and carries on from the opener, so the menu is never a trap.
 *
 * Items are ordinary buttons with `role="menuitem"`; build them with
 * `menuItem` and the helper does the rest. Nothing here is specific to rooms.
 */

export interface MenuOptions {
  /** Which edge of the opener the menu lines up with. Default: the end, so a
   *  menu on the right of a column opens leftwards, towards the room. */
  align?: 'start' | 'end'
  /** Runs just before the menu is shown, for a caller that builds its items
   *  or hides some of them on demand. */
  beforeOpen?: () => void
}

export interface MenuHandle {
  /** Show the menu below its opener and focus the first item. */
  open(): void
  /** Show it where the pointer is, for a right-click on what it is about. */
  openAt(x: number, y: number): void
  close(): void
  readonly menu: HTMLElement
}

export interface MenuItemOptions {
  danger?: boolean
  /** Written as `data-action`, for the specs and the row's own bookkeeping. */
  action?: string
  id?: string
  /** A symbol id from the icon sprite (without the `i-` prefix). */
  icon?: string
}

/** One menu item: a button the menu can walk. Clicking it closes the menu
 *  first, so a dialog the action opens takes focus from a closed popover. */
export function menuItem(menu: HTMLElement, text: string, run: () => void, options: MenuItemOptions = {}): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  button.tabIndex = -1
  if (options.id) button.id = options.id
  if (options.danger) button.className = 'danger'
  if (options.action) button.dataset.action = options.action
  if (options.icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'i')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
    use.setAttribute('href', `#i-${options.icon}`)
    svg.append(use)
    button.append(svg)
  }
  const label = document.createElement('span')
  label.textContent = text
  button.append(label)
  button.addEventListener('click', () => { hide(menu); run() })
  menu.append(button)
  return button
}

/** Below its opener where there is room, flipped above where there is not,
 *  clamped to the window: the same placement the chat log's reaction list
 *  uses. */
export function placeMenu(menu: HTMLElement, anchor: DOMRect, align: 'start' | 'end' = 'end'): void {
  menu.style.inset = 'auto'
  const bounds = menu.getBoundingClientRect()
  const left = align === 'end' ? anchor.right - bounds.width : anchor.left
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - bounds.width - 8))}px`
  const below = anchor.bottom + 4
  menu.style.top = `${below + bounds.height <= innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 4)}px`
}

function hide(menu: HTMLElement): void {
  try { if (menu.matches(':popover-open')) menu.hidePopover() } catch { /* Not a popover yet. */ }
}

function visibleItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .filter(item => !item.hidden && !(item as HTMLButtonElement).disabled && !item.closest('[hidden]'))
}

/** Give a menu element and the button that opens it the full keyboard model.
 *  The menu needs an id; its items are `role="menuitem"` buttons. */
export function wireMenu(opener: HTMLElement, menu: HTMLElement, options: MenuOptions = {}): MenuHandle {
  if (!menu.id) throw new Error('a menu needs an id')
  menu.popover = 'manual'
  menu.setAttribute('role', 'menu')
  menu.classList.add('menuPopover')
  if (!menu.hasAttribute('aria-label') && !menu.hasAttribute('aria-labelledby')) {
    const name = opener.getAttribute('aria-label') ?? opener.textContent?.trim()
    if (name) menu.setAttribute('aria-label', name)
  }
  opener.setAttribute('aria-haspopup', 'menu')
  opener.setAttribute('aria-expanded', 'false')
  opener.setAttribute('aria-controls', menu.id)
  // The declarative invoker, so pressing the opener again while the menu is
  // open closes it rather than light-dismissing and reopening it.
  opener.setAttribute('popovertarget', menu.id)

  // An item chosen closes the menu BEFORE its own handler runs, so a dialog
  // the action opens takes focus from a menu that is already gone and the
  // popover's focus restoration cannot take it back.
  menu.addEventListener('click', event => {
    if ((event.target as Element | null)?.closest('[role="menuitem"]')) hide(menu)
  }, true)

  const align = options.align ?? 'end'
  let at: { x: number; y: number } | undefined
  let focusFirst = true
  let typed = ''
  let typedAt = 0

  const focusItem = (item: HTMLElement | undefined): void => { item?.focus({ preventScroll: true }) }

  // A click or touch anywhere outside closes it; focus is left where the
  // person put it.
  const outside = (event: Event): void => {
    const target = event.target as Node | null
    if (target && !menu.contains(target) && !opener.contains(target)) hide(menu)
  }
  menu.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState === 'open') {
      // One menu open at a time.
      for (const other of document.querySelectorAll<HTMLElement>('.menuPopover:popover-open, .rowMenuPopover:popover-open')) if (other !== menu) hide(other)
      options.beforeOpen?.()
    }
  })
  menu.addEventListener('toggle', event => {
    const open = (event as ToggleEvent).newState === 'open'
    opener.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('pointerdown', outside, true)
    else document.removeEventListener('pointerdown', outside, true)
    if (open) {
      if (at) {
        menu.style.inset = 'auto'
        const bounds = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(at.x, innerWidth - bounds.width - 8))}px`
        menu.style.top = `${Math.max(8, Math.min(at.y, innerHeight - bounds.height - 8))}px`
      } else placeMenu(menu, opener.getBoundingClientRect(), align)
      if (focusFirst) focusItem(visibleItems(menu)[0])
    } else {
      at = undefined
      // Escape and a chosen item leave focus on a closed menu; a click
      // somewhere else has already put it where the person wanted it.
      const active = document.activeElement
      if (!active || active === document.body || menu.contains(active)) {
        if (opener.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true })
      }
    }
  })

  opener.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!menu.matches(':popover-open')) handle.open()
    const items = visibleItems(menu)
    focusItem(event.key === 'ArrowUp' ? items.at(-1) : items[0])
  })

  menu.addEventListener('keydown', event => {
    const items = visibleItems(menu)
    if (!items.length) return
    const index = items.indexOf(document.activeElement as HTMLElement)
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusItem(items[(index + 1) % items.length]); return
      case 'ArrowUp': event.preventDefault(); focusItem(items[(index <= 0 ? items.length : index) - 1]); return
      case 'Home': event.preventDefault(); focusItem(items[0]); return
      case 'End': event.preventDefault(); focusItem(items.at(-1)); return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        hide(menu)
        if (opener.isConnected) opener.focus({ preventScroll: true })
        return
      case 'Tab':
        // Closed, and focus put back on the opener, so Tab goes on from there
        // instead of from an element that has just vanished.
        hide(menu)
        if (opener.isConnected) opener.focus({ preventScroll: true })
        return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key === ' ') return
    const now = Date.now()
    typed = now - typedAt > 700 ? event.key.toLocaleLowerCase() : typed + event.key.toLocaleLowerCase()
    typedAt = now
    const order = [...items.slice(index + 1), ...items.slice(0, index + 1)]
    const match = order.find(item => (item.textContent ?? '').trim().toLocaleLowerCase().startsWith(typed))
    if (match) { event.preventDefault(); focusItem(match) }
  })

  const handle: MenuHandle = {
    menu,
    open() { at = undefined; focusFirst = true; if (!menu.matches(':popover-open')) menu.showPopover() },
    openAt(x, y) { at = { x, y }; focusFirst = true; if (menu.matches(':popover-open')) hide(menu); menu.showPopover() },
    close() { hide(menu) },
  }
  return handle
}
