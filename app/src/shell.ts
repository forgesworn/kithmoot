/**
 * The app shell: which destination is showing, and which pane of it.
 *
 * Three places a person can be (design-calm-shell, section 5.1): Chats,
 * People (signed in with Nostr only) and Boards, and Settings, which is a
 * sheet until stage 4. Each has a list and a main pane. Where the window is
 * wide enough both show side by side. Where it is not (under 900 px: a phone,
 * a tablet held upright), one shows at a time: the list is the first level,
 * and opening something pushes the main pane over it.
 *
 * This module owns only that: attributes on the root element that the
 * stylesheet reads, the rail and bottom bar buttons, the skip links and the
 * shortcuts that move between destinations. What a destination contains
 * (the rooms, the people, the boards) is drawn by whoever owns it, and they
 * learn of a change from the `shell:destination` event.
 *
 * Root attributes, for the stylesheet:
 *   data-destination  chats | people | boards
 *   data-level        list | detail, meaningful only below 900 px
 */

export type Destination = 'chats' | 'people' | 'boards' | 'settings'
type Place = Exclude<Destination, 'settings'>

const root = document.documentElement
/** Below this the shell shows one pane at a time. */
const ONE_PANE = window.matchMedia('(max-width: 899px)')
/** Below this the rail becomes the bottom bar. */
const COMPACT = window.matchMedia('(max-width: 599px)')

let destination: Place = 'chats'
let level: 'list' | 'detail' = location.hash.length > 1 ? 'detail' : 'list'
let peopleAvailable = false
const counts: Record<'chats' | 'boards', number> = { chats: 0, boards: 0 }

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/** Whether the shell is showing one pane at a time right now. */
export function onePane(): boolean {
  return ONE_PANE.matches
}

/** Whether the rail has become the bottom bar. */
export function compact(): boolean {
  return COMPACT.matches
}

export function currentDestination(): Place {
  return destination
}

function render(): void {
  root.dataset.destination = destination
  root.dataset.level = level
  for (const button of document.querySelectorAll<HTMLElement>('#rail [data-destination]')) {
    if (button.dataset.destination === destination) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  const people = destination === 'people'
  const peopleList = el('peopleList'), peoplePane = el('peoplePane')
  if (peopleList) peopleList.hidden = !people
  if (peoplePane) peoplePane.hidden = !people
  // Below 900 px with the main pane hidden, the list is what a screen reader
  // should find as the page's main landmark. The real main is not rendered
  // then, so there is still exactly one.
  const dock = el('callDock')
  const listIsMain = onePane() && destination !== 'boards' && level === 'list' && !(dock && !dock.hidden)
  const column = el('listColumn')
  if (column) {
    if (listIsMain) column.setAttribute('role', 'main')
    else column.removeAttribute('role')
  }
}

function announce(): void {
  document.dispatchEvent(new CustomEvent('shell:destination', { detail: { destination } }))
}

/** Switch destination. `settings` opens the settings sheet and leaves the
 *  destination as it was. */
export function openDestination(name: Destination): void {
  if (name === 'settings') {
    el('openAppSettings')?.click()
    document.dispatchEvent(new CustomEvent('shell:destination', { detail: { destination: 'settings' } }))
    return
  }
  destination = name
  // Choosing a destination from the rail or bar shows its list; a person who
  // wants a room opens it from there.
  level = 'list'
  render()
  announce()
}

/** At one-pane widths, push the main pane over the list: a full screen with
 *  a back arrow. Where the list and the main pane already sit side by side
 *  there is nothing to push, and this does nothing.
 *
 *  Stage 2 deviation, noted in the report: the brief asked for a no-op at
 *  medium widths too, but the medium layout is one pane (rail plus the list
 *  or the room), so opening a room has to push there as well. */
export function openDetail(): void {
  if (!ONE_PANE.matches) return
  level = 'detail'
  render()
}

/** Back to the list. */
export function closeDetail(): void {
  level = 'list'
  render()
}

/** Whether the main pane is what is showing (and so a back arrow belongs). */
export function detailOpen(): boolean {
  return level === 'detail'
}

/** People shows in the rail and bottom bar only for somebody signed in with
 *  Nostr (Q14): a name-only visitor never sees it. */
export function setPeopleAvailable(available: boolean): void {
  peopleAvailable = available
  const button = el('railPeople')
  if (button) button.hidden = !available
  if (!available && destination === 'people') openDestination('chats')
}

/** The counts on the rail and bottom bar: Chats shows unread people, Boards
 *  what needs you. Zero hides the pill; the spoken name carries the number. */
export function setCounts(next: Partial<typeof counts>): void {
  Object.assign(counts, next)
  for (const [key, id, label] of [['chats', 'railChats', 'Chats'], ['boards', 'railBoards', 'Boards']] as const) {
    const button = el(id), pill = el(id + 'Count')
    if (!button || !pill) continue
    const n = counts[key]
    pill.hidden = n <= 0
    pill.textContent = n > 99 ? '99+' : String(n)
    button.setAttribute('aria-label', n > 0 ? `${label}, ${n} ${key === 'chats' ? 'unread' : 'need you'}` : label)
  }
}

/** Show the list and put the cursor in its search: Cmd or Ctrl+K, the skip
 *  link, and a back arrow's neighbour. A no-op before there is a list (the
 *  first-run screen has none). */
export function focusSearch(): void {
  const search = el<HTMLInputElement>('homeRoomQuery')
  if (!search || !search.closest('#rooms') || (search.closest('#rooms') as HTMLElement).hidden) return
  if (destination !== 'chats') openDestination('chats')
  else if (level === 'detail') closeDetail()
  search.focus({ preventScroll: true })
  search.select()
}

const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

function shortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.shiftKey || event.isComposing) return
  // Command on a Mac, Control elsewhere; the help says "Control / Command", and either works.
  if (!(event.metaKey || event.ctrlKey)) return
  if (document.querySelector('dialog:modal')) return
  const key = event.key.toLowerCase()
  if (key === 'k') { event.preventDefault(); focusSearch(); return }
  if (key !== '1' && key !== '2' && key !== '3') return
  const target: Place = key === '1' ? 'chats' : key === '2' ? 'people' : 'boards'
  if (target === 'people' && !peopleAvailable) return
  event.preventDefault()
  openDestination(target)
}

/** Skip links: first in the tab order, they take a keyboard user past the
 *  rail and the list. Buttons dressed as links, because a real `#fragment`
 *  link would overwrite the room's own fragment in the address bar. */
function skip(kind: string): void {
  const room = el('roomArea')
  const roomShowing = !!room && !room.hidden && room.getClientRects().length > 0
  if (kind === 'chats') { focusSearch(); if (document.activeElement !== el('homeRoomQuery')) el('rooms')?.querySelector<HTMLElement>('button')?.focus() }
  else if (kind === 'messages' && roomShowing) {
    if (onePane() && level !== 'detail') openDetail()
    el('chatLog')?.focus({ preventScroll: true })
  } else if (kind === 'composer' && roomShowing) {
    if (onePane() && level !== 'detail') openDetail()
    const input = el('chatInput')
    if (input && input.getClientRects().length) input.focus({ preventScroll: true })
    else el('chatLog')?.focus({ preventScroll: true })
  }
}

/** Under 600 px there is no rail, so Settings and Sign in sit in the list's
 *  own header beside New, as they do in the Android app. */
function placeEnd(): void {
  const end = el('railEnd'), head = document.querySelector<HTMLElement>('#rooms .listHead'), rail = el('rail')
  if (!end || !head || !rail) return
  if (COMPACT.matches) { if (end.parentElement !== head) head.insertBefore(end, el('newMenuButton')) }
  else if (end.parentElement !== rail) rail.append(end)
}

/** Where this device remembers how wide the list is. The key the old rooms
 *  rail used, so a width somebody chose is not lost (it is clamped). */
const WIDTH_KEY = 'kithmoot.desktopProjectsRailWidth'
export const LIST_DEFAULT_PX = 300
export const LIST_MIN_PX = 240
export const LIST_MAX_PX = 480

function clampList(px: number): number {
  return Math.round(Math.max(LIST_MIN_PX, Math.min(LIST_MAX_PX, px)))
}

/**
 * The drag line on the list column's right edge, the same control as the one
 * between the call and the conversation: drag it, or focus it and use the
 * arrow keys; Home or Enter or a double-click puts the list back to 300 px,
 * End makes it as wide as it goes. Only there while the list and the room
 * share the screen (900 px and up).
 */
function installListDivider(): void {
  const divider = document.createElement('div')
  divider.id = 'railDivider'
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize chats list')
  divider.setAttribute('aria-controls', 'listColumn')
  divider.title = 'Drag to resize. Double-click to reset.'
  divider.tabIndex = 0
  document.body.append(divider)
  let width = LIST_DEFAULT_PX
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(saved) && saved > 0) width = clampList(saved)
  } catch { /* No storage: the width lasts for this visit. */ }
  const render = (): void => {
    root.style.setProperty('--shell-list', `${width}px`)
    divider.setAttribute('aria-valuemin', String(LIST_MIN_PX))
    divider.setAttribute('aria-valuemax', String(LIST_MAX_PX))
    divider.setAttribute('aria-valuenow', String(width))
    divider.setAttribute('aria-valuetext', `Chats list ${width} pixels wide`)
  }
  const apply = (px: number, keep = true): void => {
    width = clampList(px)
    render()
    if (keep) try { localStorage.setItem(WIDTH_KEY, String(width)) } catch { /* As above. */ }
  }
  const reset = (): void => {
    width = LIST_DEFAULT_PX
    render()
    try { localStorage.removeItem(WIDTH_KEY) } catch { /* As above. */ }
  }
  render()
  let drag: { id: number; startX: number; startWidth: number } | null = null
  divider.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    drag = { id: event.pointerId, startX: event.clientX, startWidth: width }
    divider.setPointerCapture(event.pointerId)
    divider.dataset.dragging = ''
    root.setAttribute('data-rail-dragging', '')
    divider.focus({ preventScroll: true })
    event.preventDefault()
  })
  divider.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.id) apply(drag.startWidth + event.clientX - drag.startX, false)
  })
  const end = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return
    apply(drag.startWidth + event.clientX - drag.startX)
    if (divider.hasPointerCapture(drag.id)) divider.releasePointerCapture(drag.id)
    drag = null
    delete divider.dataset.dragging
    root.removeAttribute('data-rail-dragging')
  }
  divider.addEventListener('pointerup', end)
  divider.addEventListener('pointercancel', end)
  divider.addEventListener('dblclick', reset)
  divider.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 16
    switch (event.key) {
      case 'ArrowLeft': apply(width - step); break
      case 'ArrowRight': apply(width + step); break
      case 'Home': case 'Enter': reset(); break
      case 'End': apply(LIST_MAX_PX); break
      default: return
    }
    event.preventDefault()
  })
}

function init(): void {
  installListDivider()
  for (const button of document.querySelectorAll<HTMLElement>('#rail [data-destination]')) {
    button.addEventListener('click', () => openDestination(button.dataset.destination as Destination))
  }
  for (const link of document.querySelectorAll<HTMLElement>('[data-skip]')) {
    link.addEventListener('click', event => { event.preventDefault(); skip(link.dataset.skip!) })
  }
  document.addEventListener('keydown', shortcut)
  const hint = el('searchHint')
  if (hint) hint.textContent = isMac ? '⌘K' : 'Ctrl K'
  // A docked call keeps a strip of the main pane on screen over the list.
  const dock = el('callDock')
  if (dock) new MutationObserver(render).observe(dock, { attributes: true, attributeFilter: ['hidden'] })
  ONE_PANE.addEventListener('change', render)
  COMPACT.addEventListener('change', placeEnd)
  placeEnd()
  render()
}

init()
