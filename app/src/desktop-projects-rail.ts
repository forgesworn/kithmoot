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
