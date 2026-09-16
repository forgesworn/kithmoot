const room = document.getElementById('roomArea')!
const chat = document.getElementById('mobileChat')!
const call = document.getElementById('mobileCall')!
const compact = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 540px) and (max-width: 1024px)')

export function showMobileRoomView(view: 'chat' | 'call'): void {
  room.dataset.mobileView = view
  chat.setAttribute('aria-pressed', String(view === 'chat'))
  call.setAttribute('aria-pressed', String(view === 'call'))
  if (compact.matches) {
    document.querySelector<HTMLTextAreaElement>('#chatInput')?.blur()
    window.scrollTo(0, 0)
    if (view === 'call') for (const video of document.querySelectorAll<HTMLVideoElement>('#callStage video, #parked video')) void video.play().catch(() => {})
  }
}

showMobileRoomView('chat')
chat.addEventListener('click', () => showMobileRoomView('chat'))
call.addEventListener('click', () => {
  showMobileRoomView('call')
  document.getElementById('callToggle')!.click()
})
document.getElementById('mobileWork')!.addEventListener('click', () => document.getElementById('openAssignments')!.click())

// Extra controls open over the call, never expand the page beneath it.
const extras = document.getElementById('callExtras') as HTMLDetailsElement
const dialog = document.getElementById('mobileCallSettings') as HTMLDialogElement
const contents = document.getElementById('callExtrasContent')!
extras.querySelector('summary')!.addEventListener('click', event => {
  if (!compact.matches) return
  event.preventDefault()
  dialog.querySelector('.sheetBody')!.append(contents)
  dialog.showModal()
})
document.getElementById('mobileCallSettingsClose')!.addEventListener('click', () => dialog.close())
dialog.addEventListener('close', () => { extras.append(contents); extras.open = false; extras.querySelector('summary')!.focus() })

// Mobile keyboards resize the visual viewport, not necessarily 100dvh.
// Keep the composer in that visible area without shrinking pinch-zoomed text.
function fitVisibleViewport(): void {
  const viewport = window.visualViewport
  if (compact.matches && viewport && viewport.scale === 1) {
    document.documentElement.style.setProperty('--room-viewport-height', `${viewport.height}px`)
  } else document.documentElement.style.removeProperty('--room-viewport-height')
}
window.visualViewport?.addEventListener('resize', fitVisibleViewport)
window.addEventListener('resize', fitVisibleViewport)
fitVisibleViewport()
