import './desktop.css'
import { loadDrawerOpen, saveDrawerOpen, wrapConversation } from './desktop-chat-drawer.js'
import { loadRailOpen, saveRailOpen, wrapRail } from './desktop-projects-rail.js'
import { installShareFitting } from './desktop-layout-fit.js'

// Reuse the same controls and media elements; moving them preserves listeners,
// tracks and chat state. The web/PWA keeps its existing document structure.
if (import.meta.env.VITE_DESKTOP === 'true') {
  document.documentElement.dataset.desktop = 'true'
  const room = document.getElementById('roomArea')!
  const stage = document.getElementById('callStage')!
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
    const unread = document.createElement('span')
    unread.id = 'projectsRailUnread'
    unread.className = 'railUnread'
    unread.hidden = true
    bar.append(railToggle, unread)
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
