import './desktop.css'

// Reuse the same controls and media elements; moving them preserves listeners,
// tracks and chat state. The web/PWA keeps its existing document structure.
if (import.meta.env.VITE_DESKTOP === 'true') {
  document.documentElement.dataset.desktop = 'true'
  const room = document.getElementById('roomArea')!
  const stage = document.getElementById('callStage')!
  const content = document.createElement('div')
  content.className = 'desktopRoomContent'
  const conversation = document.createElement('div')
  conversation.className = 'desktopConversation'
  while (stage.nextElementSibling) conversation.append(stage.nextElementSibling)
  stage.before(content)
  content.append(stage, conversation)
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
