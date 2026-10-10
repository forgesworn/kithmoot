import './desktop.css'
import { loadDrawerOpen, saveDrawerOpen, wrapConversation } from './desktop-chat-drawer.js'
import {
  RAIL_DEFAULT_PX, RAIL_MIN_PX, RAIL_STEP_PX, RAIL_STEP_PX_LARGE, clampRailWidth, loadRailOpen, loadRailWidth, railMaxWidth,
  saveRailOpen, saveRailWidth, wrapRail,
} from './desktop-projects-rail.js'
import { installShareFitting } from './desktop-layout-fit.js'

// Reuse the same controls and media elements; moving them preserves listeners,
// tracks and chat state. The web/PWA keeps its existing document structure.
if (import.meta.env.VITE_DESKTOP === 'true') {
  document.documentElement.dataset.desktop = 'true'
  const room = document.getElementById('roomArea')!
  const stage = document.getElementById('callStageSlot')!
  const content = document.createElement('div')
  content.className = 'desktopRoomContent'
  // The conversation used to be its own permanent column; now it is a
  // drawer that slides over the stage, so it needs a class for that CSS on
  // top of the wrapper `wrapConversation` builds.
  const conversation = wrapConversation(stage)
  conversation.classList.add('desktopConversation')
  stage.before(content)
  content.append(stage, conversation)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.id = 'chatDrawerToggle'
  toggle.className = 'barBtn'
  toggle.textContent = 'Chat'
  toggle.setAttribute('aria-controls', 'chatDrawer')
  const setOpen = (open: boolean): void => {
    conversation.dataset.open = String(open)
    toggle.setAttribute('aria-expanded', String(open))
    saveDrawerOpen(window.localStorage, open)
  }
  toggle.addEventListener('click', () => setOpen(conversation.dataset.open !== 'true'))
  document.getElementById('roomMenu')?.before(toggle)
  // Open by default: chat has always been there on desktop, and a closed
  // default would quietly take it away from everyone upgrading into this.
  // Only a person who actually closes it once gets the closed default back.
  setOpen(loadDrawerOpen(window.localStorage, true))

  // The rooms rail, and a way to put it away. Same pattern as the drawer
  // above: one state on the root element, one control that says what it
  // will do, and this device's own answer remembered. Collapsed it keeps
  // the control and the unread total, so putting the rail away never means
  // losing track of a room that is talking.
  const rail = document.getElementById('workspaceNav')
  if (rail) {
    const body = wrapRail(rail)
    const bar = document.createElement('div')
    bar.className = 'railBar'
    const railToggle = document.createElement('button')
    railToggle.type = 'button'
    railToggle.id = 'projectsRailToggle'
    railToggle.className = 'barBtn'
    railToggle.setAttribute('aria-controls', body.id)
    // Both carry a spoken total in `aria-label`, not just the digits in
    // their text - a plain `<span>` has no role that lets `aria-label`
    // override its name, so standing alone here it needs one that does.
    const unread = document.createElement('span')
    unread.id = 'projectsRailUnread'
    unread.className = 'railUnread'
    unread.setAttribute('role', 'img')
    unread.hidden = true
    // An agent's tag, shown beside the people badge in the agent colour
    // used everywhere else an agent is marked out.
    const unreadAgents = document.createElement('span')
    unreadAgents.id = 'projectsRailUnreadAgents'
    unreadAgents.className = 'railUnreadAgent'
    unreadAgents.setAttribute('role', 'img')
    unreadAgents.hidden = true
    bar.append(railToggle, unread, unreadAgents)
    rail.prepend(bar)
    const setRailOpen = (open: boolean): void => {
      document.documentElement.dataset.rail = open ? 'open' : 'collapsed'
      railToggle.setAttribute('aria-expanded', String(open))
      // A glyph in a 3.5rem rail, and the whole sentence to anything that
      // reads it out or hovers it.
      railToggle.textContent = open ? '‹' : '›'
      const label = open ? 'Hide projects and rooms' : 'Show projects and rooms'
      railToggle.setAttribute('aria-label', label)
      railToggle.title = label
      saveRailOpen(window.localStorage, open)
    }
    railToggle.addEventListener('click', () => setRailOpen(document.documentElement.dataset.rail !== 'open'))
    setRailOpen(loadRailOpen(window.localStorage, true))
    installRailDivider(rail)
  }

  // A shared screen's box is shaped by the picture in it, and the rows are
  // bounded so a second sharer costs the first one size rather than a place
  // on screen. Only here: the installed window is the one whose height is
  // fixed and whose room can therefore be divided up. A browser tab gets
  // the same camera-beside-screen row from style.css, bounded by CSS alone.
  const shareStage = document.getElementById('callStage')
  const shareRoom = document.getElementById('room')
  if (shareRoom) installShareFitting(shareRoom, shareStage)

  const progress = document.createElement('div')
  progress.id = 'roomSwitchProgress'
  progress.hidden = true
  progress.setAttribute('role', 'status')
  room.append(progress)
  for (const id of ['forgetBrowser', 'forgetBrowserRoom']) {
    const button = document.getElementById(id)
    if (button) button.textContent = 'Forget this device'
  }
}

/**
 * The drag line on the rail's right edge, the same control as the one
 * between the call and the conversation (call-focus.ts): drag it, or focus
 * it and use the arrow keys, Home and End; Enter or a double-click puts the
 * rail back to its default. The width goes to `--rail-open-w`, which
 * desktop.css also holds to 40% of the window, so the stored width never
 * has to be re-applied when the window changes size.
 */
function installRailDivider(rail: HTMLElement): void {
  const root = document.documentElement
  const divider = document.createElement('div')
  divider.id = 'railDivider'
  divider.setAttribute('role', 'separator')
  divider.setAttribute('aria-orientation', 'vertical')
  divider.setAttribute('aria-label', 'Resize projects and rooms')
  divider.setAttribute('aria-controls', 'workspaceNav')
  divider.title = 'Drag to resize. Double-click to reset.'
  divider.tabIndex = 0
  rail.append(divider)

  let width = loadRailWidth(window.localStorage)
  const current = (): number => rail.getBoundingClientRect().width || width || RAIL_DEFAULT_PX
  const render = (): void => {
    if (width === undefined) root.style.removeProperty('--rail-open-w')
    else root.style.setProperty('--rail-open-w', `${width}px`)
    const shown = Math.round(current())
    divider.setAttribute('aria-valuemin', String(RAIL_MIN_PX))
    divider.setAttribute('aria-valuemax', String(railMaxWidth(window.innerWidth)))
    divider.setAttribute('aria-valuenow', String(shown))
    divider.setAttribute('aria-valuetext', `Projects and rooms ${shown} pixels wide`)
  }
  const apply = (px: number): void => { width = clampRailWidth(px, window.innerWidth); render() }
  const reset = (): void => { width = undefined; saveRailWidth(window.localStorage, undefined); render() }
  render()

  let drag: { pointerId: number; startX: number; startWidth: number } | null = null
  let frame = 0
  let lastX = 0
  divider.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: current() }
    lastX = event.clientX
    divider.setPointerCapture(event.pointerId)
    divider.dataset.dragging = ''
    root.setAttribute('data-rail-dragging', '')
    divider.focus({ preventScroll: true })
    event.preventDefault()
  })
  divider.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    lastX = event.clientX
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (drag) apply(drag.startWidth + (lastX - drag.startX))
    })
  })
  const end = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    if (frame) { cancelAnimationFrame(frame); frame = 0 }
    apply(drag.startWidth + (lastX - drag.startX))
    if (divider.hasPointerCapture(drag.pointerId)) divider.releasePointerCapture(drag.pointerId)
    drag = null
    delete divider.dataset.dragging
    root.removeAttribute('data-rail-dragging')
    saveRailWidth(window.localStorage, width)
  }
  divider.addEventListener('pointerup', end)
  divider.addEventListener('pointercancel', end)
  divider.addEventListener('dblclick', reset)
  divider.addEventListener('keydown', event => {
    const step = event.shiftKey ? RAIL_STEP_PX_LARGE : RAIL_STEP_PX
    switch (event.key) {
      case 'ArrowLeft': apply(current() - step); break
      case 'ArrowRight': apply(current() + step); break
      case 'Home': apply(RAIL_MIN_PX); break
      case 'End': apply(railMaxWidth(window.innerWidth)); break
      case 'Enter': reset(); return event.preventDefault()
      default: return
    }
    event.preventDefault()
    saveRailWidth(window.localStorage, width)
  })
  window.addEventListener('resize', render)
}
