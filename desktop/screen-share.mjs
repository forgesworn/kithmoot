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

const isScreen = source => typeof source?.id === 'string' && source.id.startsWith('screen:')

/**
 * The desktop chooser's half of `answerDisplayRequest`. `showMenu(items,
 * cancel)` shows the items (a `source` on those that pick one) and calls
 * `cancel` when dismissed; a second answer after a pick is ignored.
 * `redaction` records the source actually answered with, and while any box
 * is on only whole screens are offered: a box cannot follow an app's window.
 */
export function displayChoice({ request, platform, areaMode, redaction, screenAccessGranted, listSources, showMenu }) {
  return {
    allowed: () => true,
    screenAccessGranted,
    listSources,
    selection: source => {
      redaction?.captured(source)
      return { video: source, ...(request.audioRequested && ['darwin', 'win32'].includes(platform) ? { audio: 'loopback' } : {}) }
    },
    choose: (sources, chosen) => {
      let picked = false
      const hiding = redaction?.anyOn() ?? false
      const offered = hiding ? sources.filter(isScreen) : sources
      const left = sources.length - offered.length
      const pick = source => { if (!picked) { picked = true; chosen(hiding && source && !isScreen(source) ? undefined : source) } }
      // On Wayland the portal already asked; a menu of its one answer is a second prompt.
      if (areaMode === 'preview' && sources.length === 1) return pick(sources[0])
      showMenu([
        { label: 'Choose what to share', enabled: false },
        ...offered.map(source => ({ label: source.name, source, click: () => pick(source) })),
        // Said beneath the screens, where the windows would have been.
        ...(hiding && left > 0 ? [{ label: `${left === 1 ? '1 window is' : `${left} windows are`} not listed: a window cannot be shared while part of the screen is hidden`, enabled: false }] : []),
      ], () => pick())
    },
  }
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
    deps.choose(sources, source => finish(source ? (deps.selection?.(source, request) ?? { video: source }) : undefined))
  } catch { finish() }
}
