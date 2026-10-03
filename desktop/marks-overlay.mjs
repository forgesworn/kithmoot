import { screen } from 'electron'
import { overlayBounds } from './redaction-geometry.mjs'

export const MARKS_URL = 'about:blank#kithmoot-share-marks'

/**
 * The marks other people draw on a whole-screen share, shown on the screen
 * being shared: one see-through window over the whole display that never
 * takes a click, a key or the focus. The page paints it (`app/src/share-marks-
 * overlay.ts`); this process only puts it in the right place and keeps it
 * there. Without it, the person sharing saw marks only on KithMoot's own
 * preview of their share, a blank tile while the whole screen is shared.
 */
export class MarksOverlay {
  window = undefined
  constructor(capture) {
    this.capture = capture
    this.place = () => this.#place()
  }
  attach(window) {
    if (this.window && !this.window.isDestroyed()) this.window.close()
    this.window = window
    window.setParentWindow(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.setIgnoreMouseEvents(true)
    window.setFocusable(false)
    if (process.platform === 'linux') window.setAlwaysOnTop(true)
    else window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Where the OS honours it the marks stay out of the share, which already
    // carries them to everyone else. Where it does not, they are painted twice
    // in the same place, which is harmless.
    window.setContentProtection(true)
    window.on('closed', () => { if (this.window === window) this.window = undefined; this.#listen(false) })
    if (!this.#place()) return
    this.#listen(true)
    window.showInactive()
  }
  close() {
    if (this.window && !this.window.isDestroyed()) this.window.close()
    this.window = undefined
  }
  #place() {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    const bounds = overlayBounds(this.capture(), screen.getAllDisplays())
    if (!bounds) { this.close(); return false }
    window.setBounds(bounds)
    return true
  }
  #listen(on) {
    if (this.listening === on) return
    this.listening = on
    const method = on ? 'on' : 'removeListener'
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen[method](event, this.place)
  }
}

export const MARKS_WINDOW = {
  transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true, hasShadow: false,
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
  skipTaskbar: true, focusable: false, show: false, enableLargerThanScreen: true,
  width: 400, height: 300,
}
