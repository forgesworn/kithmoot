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
 *  - Tab closes and carries on from the opener, so the menu is never a trap;
 *  - an item with a submenu (`menuSubmenu`) opens it with Right or Enter, and
 *    Left or Escape closes just that submenu and returns focus to its item.
 *    A submenu is a nested `role="menu"` inside the same popover, so the
 *    browser's one-popover-at-a-time rule never closes it from under its
 *    parent. On a narrow screen it replaces the menu's items, with a Back
 *    item first, rather than flying out beside them;
 *  - `sheet` lays the menu out as a sheet from the bottom edge on a narrow
 *    screen, which is where a thumb is.
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
  /** A media query under which the menu is a bottom sheet instead of a
   *  popover beside its opener. */
  sheet?: string
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
  /** Makes it a `menuitemradio` that says whether it is the chosen one. */
  checked?: boolean
  /** With `checked`: one of several that may all be on (a reaction), so a
   *  `menuitemcheckbox`, not a radio. */
  toggle?: boolean
  /** Shown at the right edge, in words the platform uses ("⌘I"). */
  shortcut?: string
}

/** One menu item: a button the menu can walk. Clicking it closes the menu
 *  first, so a dialog the action opens takes focus from a closed popover. */
export function menuItem(menu: HTMLElement, text: string, run: () => void, options: MenuItemOptions = {}): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', options.checked === undefined ? 'menuitem' : options.toggle ? 'menuitemcheckbox' : 'menuitemradio')
  if (options.checked !== undefined) button.setAttribute('aria-checked', String(options.checked))
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
  label.className = 'menuLabel'
  label.textContent = text
  button.append(label)
  if (options.shortcut) {
    // Drawn by the stylesheet from the attribute, so it is a hint for the eye
    // and no part of the item's name or its text.
    button.dataset.shortcut = options.shortcut
    button.setAttribute('aria-keyshortcuts', options.shortcut.replace('⌘', 'Meta+').replace(/Ctrl\+/, 'Control+'))
  }
  // A submenu's own item only opens it (`wireMenu` does that), so it neither closes the menu nor runs anything.
  button.addEventListener('click', () => { if (button.hasAttribute('aria-haspopup')) return; hide(menu); run() })
  menu.append(button)
  return button
}

/** A line between two groups of items. Callers that show groups on demand
 *  use `menuGroups`, which never leaves one at an edge or doubled. */
export function menuSeparator(menu: HTMLElement): HTMLHRElement {
  const rule = document.createElement('hr')
  rule.setAttribute('role', 'separator')
  menu.append(rule)
  return rule
}

/** Build a menu from groups of items, dropping the empty ones and putting a
 *  separator between those that remain, so an item that is not offered here
 *  leaves no stray line behind it. */
export function menuGroups(menu: HTMLElement, groups: Array<(menu: HTMLElement) => void>): void {
  menu.replaceChildren()
  let first = true
  for (const build of groups) {
    const rule = first ? undefined : menuSeparator(menu)
    const before = menu.childElementCount
    build(menu)
    if (menu.childElementCount === before) rule?.remove()
    else first = false
  }
}

/** An item that opens a submenu: `build` fills the submenu with
 *  `menuItem(sub, ...)`. Returns the item, which says `aria-haspopup` and
 *  `aria-expanded`. Opening and closing are `wireMenu`'s. */
export function menuSubmenu(menu: HTMLElement, text: string, build: (sub: HTMLElement) => void, options: { id?: string; icon?: string } = {}): HTMLButtonElement {
  const parent = menuItem(menu, text, () => {}, options)
  parent.setAttribute('aria-haspopup', 'menu')
  parent.setAttribute('aria-expanded', 'false')
  parent.dataset.submenu = 'true'
  const sub = document.createElement('div')
  sub.className = 'menuSub'
  sub.setAttribute('role', 'menu')
  sub.setAttribute('aria-label', text)
  sub.hidden = true
  build(sub)
  menu.append(sub)
  return parent
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

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

/** The items of one level: the menu's own, or those of one open submenu,
 *  never both. */
function visibleItems(level: HTMLElement): HTMLElement[] {
  return Array.from(level.querySelectorAll<HTMLElement>(ITEM))
    .filter(item => item.closest('[role="menu"]') === level && !item.hidden && !(item as HTMLButtonElement).disabled && !item.closest('[hidden]'))
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

  const sheetQuery = options.sheet ? window.matchMedia(options.sheet) : undefined
  const asSheet = (): boolean => Boolean(sheetQuery?.matches)
  // The items a narrow screen's submenu has hidden to take their place.
  let covered: HTMLElement[] = []

  const openSubmenu = (parent: HTMLElement, focus: boolean): void => {
    const sub = parent.nextElementSibling
    if (!(sub instanceof HTMLElement) || sub.getAttribute('role') !== 'menu') return
    closeSubmenus()
    sub.hidden = false
    parent.setAttribute('aria-expanded', 'true')
    if (asSheet()) {
      // Replaces the menu's items, with a way back as the first of its own.
      covered = Array.from(menu.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== sub && !child.hidden)
      for (const child of covered) child.hidden = true
      sub.classList.add('menuSubReplaces')
      if (!sub.querySelector('[data-back]')) {
        const back = document.createElement('button')
        back.type = 'button'; back.tabIndex = -1; back.dataset.back = 'true'
        back.setAttribute('role', 'menuitem')
        back.textContent = '‹ Back'
        back.addEventListener('click', event => { event.stopPropagation(); closeSubmenus(parent) })
        sub.prepend(back)
      }
    } else {
      sub.classList.remove('menuSubReplaces')
      // Beside the item, on whichever side of the menu has the room.
      const room = innerWidth - menu.getBoundingClientRect().right
      sub.classList.toggle('menuSubLeft', room < sub.getBoundingClientRect().width + 8)
      sub.style.top = `${parent.offsetTop - 6}px`
    }
    if (focus) visibleItems(sub)[0]?.focus({ preventScroll: true })
  }
  const closeSubmenus = (focusParent?: HTMLElement): void => {
    for (const child of covered) child.hidden = false
    covered = []
    for (const sub of menu.querySelectorAll<HTMLElement>('[role="menu"]')) {
      if (sub === menu || sub.hidden) continue
      sub.hidden = true
      sub.previousElementSibling?.setAttribute('aria-expanded', 'false')
    }
    focusParent?.focus({ preventScroll: true })
  }

  // An item chosen closes the menu BEFORE its own handler runs, so a dialog
  // the action opens takes focus from a menu that is already gone and the
  // popover's focus restoration cannot take it back. An item that opens a
  // submenu is not a choice, and leaves the menu where it is.
  menu.addEventListener('click', event => {
    const item = (event.target as Element | null)?.closest(ITEM)
    if (!item) return
    if (item.hasAttribute('aria-haspopup')) { openSubmenu(item as HTMLElement, event.detail === 0); return }
    if ((item as HTMLElement).dataset.back) return
    hide(menu)
  }, true)

  const align = options.align ?? 'end'
  let at: { x: number; y: number } | undefined
  let focusFirst = true
  let typed = ''
  let typedAt = 0

  const focusItem = (item: HTMLElement | undefined): void => { item?.focus({ preventScroll: true }) }

  // A click or touch anywhere outside closes it; focus is left where the
  // person put it. A sheet's backdrop belongs to the menu element itself, so
  // there a press outside its own box counts as outside.
  const outside = (event: Event): void => {
    const target = event.target as Node | null
    if (!target) return
    if (target === menu && menu.classList.contains('menuSheetOn')) {
      const box = menu.getBoundingClientRect()
      const { clientX, clientY } = event as PointerEvent
      if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) hide(menu)
      return
    }
    if (!menu.contains(target) && !opener.contains(target)) hide(menu)
  }
  menu.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState === 'open') {
      // One menu open at a time.
      for (const other of document.querySelectorAll<HTMLElement>('.menuPopover:popover-open, .rowMenuPopover:popover-open')) if (other !== menu) hide(other)
      closeSubmenus()
      options.beforeOpen?.()
      menu.classList.toggle('menuSheetOn', asSheet())
    }
  })
  menu.addEventListener('toggle', event => {
    const open = (event as ToggleEvent).newState === 'open'
    opener.setAttribute('aria-expanded', String(open))
    if (open) document.addEventListener('pointerdown', outside, true)
    else document.removeEventListener('pointerdown', outside, true)
    if (open) {
      if (asSheet()) {
        menu.style.inset = ''
        menu.style.left = ''
        menu.style.top = ''
      } else if (at) {
        menu.style.inset = 'auto'
        const bounds = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(8, Math.min(at.x, innerWidth - bounds.width - 8))}px`
        menu.style.top = `${Math.max(8, Math.min(at.y, innerHeight - bounds.height - 8))}px`
      } else placeMenu(menu, opener.getBoundingClientRect(), align)
      if (focusFirst) focusItem(visibleItems(menu)[0])
    } else {
      at = undefined
      closeSubmenus()
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
    const active = document.activeElement as HTMLElement | null
    const level = (active?.closest('[role="menu"]') as HTMLElement | null) ?? menu
    const inSub = level !== menu
    const items = visibleItems(level)
    if (!items.length) return
    const index = items.indexOf(active as HTMLElement)
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusItem(items[(index + 1) % items.length]); return
      case 'ArrowUp': event.preventDefault(); focusItem(items[(index <= 0 ? items.length : index) - 1]); return
      case 'Home': event.preventDefault(); focusItem(items[0]); return
      case 'End': event.preventDefault(); focusItem(items.at(-1)); return
      case 'ArrowRight':
        if (active?.hasAttribute('aria-haspopup') && !inSub) { event.preventDefault(); openSubmenu(active, true) }
        return
      case 'ArrowLeft':
        if (inSub) { event.preventDefault(); closeSubmenus(level.previousElementSibling as HTMLElement) }
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        // A submenu closes by itself; the menu closes on the next Escape.
        if (inSub) { closeSubmenus(level.previousElementSibling as HTMLElement); return }
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
