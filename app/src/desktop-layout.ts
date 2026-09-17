import './desktop.css'
import { loadDrawerOpen, saveDrawerOpen, wrapConversation } from './desktop-chat-drawer.js'

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
  setOpen(loadDrawerOpen(window.localStorage, false))

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
