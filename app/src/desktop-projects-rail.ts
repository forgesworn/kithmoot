// The rooms rail on the left of the installed window, and the owner's
// request: "the projects on the left hand side we should be able to
// show/hide."
//
// Built the way the chat drawer was, and for the same reason: the parts
// that can be tested without a browser are kept out of the DOM wiring in
// desktop-layout.ts. That is whether the rail should start open on this
// device, how the unread total is worded once the room names it was beside
// have gone, and where the rail's own contents go so one rule can hide
// them as a block.

const STORAGE_KEY = 'kithmoot.desktopProjectsRailOpen'

/** Whether the rail should be open, read back from what this device last
 *  left it as. Shown by default: somebody upgrading into this should find
 *  their rooms where they left them, and only a person who has actually
 *  collapsed it once gets the collapsed default. Any storage failure -
 *  private browsing, a full quota, no `localStorage` at all - falls back
 *  rather than throwing. */
export function loadRailOpen(storage: Pick<Storage, 'getItem'>, fallback: boolean): boolean {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === 'open') return true
    if (raw === 'collapsed') return false
  } catch {
    // Fall through to fallback.
  }
  return fallback
}

/** Remembers the rail's state for next time, on this device only. */
export function saveRailOpen(storage: Pick<Storage, 'setItem'>, open: boolean): void {
  try {
    storage.setItem(STORAGE_KEY, open ? 'open' : 'collapsed')
  } catch {
    // Nothing to do: the control still works for the rest of this session.
  }
}

/** What the slim rail says instead of a list of rooms. Empty when there is
 *  nothing new, because a nought is a thing to read and to dismiss; capped,
 *  because the rail is 3.5rem wide and "127" in it is a smear. */
export function railUnreadLabel(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return ''
  return total > 99 ? '99+' : String(Math.floor(total))
}

/** And what it says out loud, where there is no width limit. */
export function railUnreadDescription(total: number): string {
  const count = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  return count === 1 ? '1 unread message in your rooms' : `${count} unread messages in your rooms`
}

/** Wraps the rail's contents - brand, search, the rooms themselves - in one
 *  element, so collapsing is one rule against one node rather than a list
 *  of children that grows every time something is added to the rail.
 *  Idempotent: called again on the same document it hands back the wrapper
 *  already made. */
export function wrapRail(nav: HTMLElement): HTMLElement {
  const existing = document.getElementById('workspaceRailBody')
  if (existing) return existing
  const body = document.createElement('div')
  body.id = 'workspaceRailBody'
  body.className = 'workspaceRailBody'
  while (nav.firstChild) body.append(nav.firstChild)
  nav.append(body)
  return body
}

/** The unread totals on the slim rail, split the same way a room's own
 *  badges are: people in the usual badge, an agent's tag beside it in a
 *  visually distinct one, shown only while there is something in it. A
 *  no-op in a browser tab and on a phone, where there is no rail to put it
 *  on. */
export function setProjectsRailUnread(people: number, agents: number): void {
  const badge = document.getElementById('projectsRailUnread')
  if (badge) {
    const label = railUnreadLabel(people)
    badge.textContent = label
    badge.hidden = label === ''
    badge.setAttribute('aria-label', railUnreadDescription(people))
  }
  const agentBadge = document.getElementById('projectsRailUnreadAgents')
  if (agentBadge) {
    const label = railUnreadLabel(agents)
    agentBadge.textContent = label
    agentBadge.hidden = label === ''
    agentBadge.setAttribute('aria-label', `${label === '' ? 0 : Math.floor(agents)} from agents`)
  }
}

// ---------------------------------------------------------------------------
// The rail's width, dragged by hand. The owner's words: "you added the
// numbers of unread on the desktop, but now it's too squashed - we need a
// drag line like we have between video and chat." A room's count, its star
// and its buttons all sit beside its name in a 13rem rail, so the name is
// what got squeezed. The divider itself is wired in desktop-layout.ts; the
// clamping and the storage are kept here so they are tested without a
// browser.

const WIDTH_KEY = 'kithmoot.desktopProjectsRailWidth'

/** The rail before anybody drags it, and its bounds. 13rem is `--rail-w`'s
 *  default in desktop.css (RAIL_WIDTH_PX). The ceiling is also held to a
 *  share of the window there, by `min(..., 40vw)`, so a width remembered
 *  from a big window never crowds out the room in a small one. */
export const RAIL_DEFAULT_PX = 208
export const RAIL_MIN_PX = 176
export const RAIL_MAX_PX = 512
export const RAIL_MAX_FRACTION = 0.4

/** How far one press of an arrow key moves the divider, and with Shift. */
export const RAIL_STEP_PX = 16
export const RAIL_STEP_PX_LARGE = 64

/** The widest the rail may be in a window `windowWidth` wide. */
export function railMaxWidth(windowWidth: number): number {
  return Math.max(RAIL_MIN_PX, Math.min(RAIL_MAX_PX, Math.floor(windowWidth * RAIL_MAX_FRACTION)))
}

/** `px` held between the rail's floor and its ceiling for this window. */
export function clampRailWidth(px: number, windowWidth: number): number {
  if (!Number.isFinite(px)) return RAIL_DEFAULT_PX
  return Math.round(Math.max(RAIL_MIN_PX, Math.min(px, railMaxWidth(windowWidth))))
}

/** The width this device last dragged the rail to, or undefined for the
 *  default. Anything unreadable is the default rather than an error. */
export function loadRailWidth(storage: Pick<Storage, 'getItem'>): number | undefined {
  try {
    const raw = storage.getItem(WIDTH_KEY)
    if (raw === null) return undefined
    const px = Number(raw)
    return Number.isFinite(px) && px >= RAIL_MIN_PX && px <= RAIL_MAX_PX ? Math.round(px) : undefined
  } catch {
    return undefined
  }
}

/** Remembers a dragged width; undefined forgets it, for the reset. */
export function saveRailWidth(storage: Pick<Storage, 'setItem' | 'removeItem'>, px: number | undefined): void {
  try {
    if (px === undefined) storage.removeItem(WIDTH_KEY)
    else storage.setItem(WIDTH_KEY, String(Math.round(px)))
  } catch {
    // The divider still works for the rest of this session.
  }
}
