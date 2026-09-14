/**
 * The call's extra settings, folded on a phone.
 *
 * Background blur, voice masking and the two-device switches sit under one
 * "More" fold in index.html. On a wide screen the fold is open and its
 * summary is not drawn, so nothing changes there. On a phone the four
 * controls that matter during a call share one row, and everything else
 * waits behind "More" rather than pushing the conversation off the screen.
 * The query is the one style.css uses for the compact call.
 */

const compact = matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 540px) and (max-width: 1024px)')

function sync(): void {
  const fold = document.getElementById('callExtras')
  if (fold instanceof HTMLDetailsElement) fold.open = !compact.matches
}

sync()
compact.addEventListener('change', sync)
