// Desktop's conversation panel used to be a permanent column: `main.ts`
// wired nothing, `desktop-layout.ts` built one column and `desktop.css` gave
// it a width and never took it away. Turning it into a drawer needed two
// things kept separate from that DOM wiring, so they could be tested without
// a browser: whether it should start open, on this device, and where the
// conversation's elements go so they can slide as one panel rather than as a
// column of independent siblings.

const STORAGE_KEY = 'kithmoot.desktopChatDrawerOpen'

/** Whether the drawer should be open, read back from what this device last
 *  left it as. Any storage failure - private browsing, a full quota, no
 *  `localStorage` at all - falls back to `fallback` rather than throwing: a
 *  drawer that cannot remember is better than a room that cannot open. */
export function loadDrawerOpen(storage: Pick<Storage, 'getItem'>, fallback: boolean): boolean {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === 'open') return true
    if (raw === 'closed') return false
  } catch {
    // Fall through to fallback.
  }
  return fallback
}

/** Remembers the drawer's state for next time, on this device only. */
export function saveDrawerOpen(storage: Pick<Storage, 'setItem'>, open: boolean): void {
  try {
    storage.setItem(STORAGE_KEY, open ? 'open' : 'closed')
  } catch {
    // Nothing to do: the toggle still works for the rest of this session.
  }
}

/** Wraps everything after the call stage - conversation nav, messages,
 *  composer - in one element, so `desktop.css` can slide it as a single
 *  panel instead of animating a column of independent siblings. Idempotent:
 *  called again on the same document, it hands back the wrapper already
 *  made rather than nesting a second one inside itself. */
export function wrapConversation(stage: HTMLElement): HTMLElement {
  const existing = document.getElementById('chatDrawer')
  if (existing) return existing
  const wrapper = document.createElement('div')
  wrapper.id = 'chatDrawer'
  wrapper.className = 'chatDrawer'
  while (stage.nextElementSibling) wrapper.append(stage.nextElementSibling)
  stage.after(wrapper)
  return wrapper
}

/** True when a share's owner has no camera live, and their tile should show
 *  a name plate where the camera would otherwise be - so the pairing of
 *  person and screen still reads even with no picture of them. */
export function needsNamePlaceholder(hasCamera: boolean): boolean {
  return !hasCamera
}
