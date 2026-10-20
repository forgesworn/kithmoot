const room = document.getElementById('roomArea')!
const compact = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 540px) and (max-width: 1024px)')

/** A phone shows the call's stage or the conversation, one at a time. On a
 *  call the call bar's Chat button swaps them (app/src/call-focus.ts); there
 *  is no row of tabs for it. The bar itself stays in both. */
export function showMobileRoomView(view: 'chat' | 'call'): void {
  room.dataset.mobileView = view
  if (compact.matches) {
    document.querySelector<HTMLTextAreaElement>('#chatInput')?.blur()
    window.scrollTo(0, 0)
    if (view === 'call') for (const video of document.querySelectorAll<HTMLVideoElement>('#callStage video, #parked video')) if (!video.hasAttribute('data-gallery-off-page') && !video.closest('[data-gallery-collapsed]')) void video.play().catch(() => {})
  }
}

showMobileRoomView('chat')

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
