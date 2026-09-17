// Answers a page's getDisplayMedia request. Kept free of Electron imports so
// the decisions can be tested without a window.

export const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

// Electron 44 throws "Video was requested, but no video stream was provided"
// for callback({}), and a throw from the menu's close callback left the
// page's request unanswered. callback() with nothing refuses cleanly.
export function refuse(callback) {
  try { callback() } catch { /* already answered */ }
}

/**
 * Without macOS Screen Recording permission every capture fails with
 * "Invalid capture constraints", which tells nobody what to do. Check first
 * and say so. Asking for sources is what puts KithMoot in the System
 * Settings list, and on first use it raises macOS's own prompt as well.
 */
export async function screenAccessGranted({ platform, status, listSources, askToOpenSettings, openSettings }) {
  if (platform !== 'darwin' || status() === 'granted') return true
  if (await askToOpenSettings()) {
    await listSources().catch(() => [])
    await openSettings()
  }
  return false
}

export async function answerDisplayRequest(request, callback, deps) {
  let answered = false
  const finish = (selection) => {
    if (answered) return
    answered = true
    if (selection) callback(selection)
    else refuse(callback)
  }
  try {
    if (!deps.allowed(request)) return finish()
    if (!await deps.screenAccessGranted()) return finish()
    const sources = await deps.listSources()
    if (sources.length === 0) return finish()
    deps.choose(sources, source => finish(source ? { video: source } : undefined))
  } catch { finish() }
}
