import { app, screen } from 'electron'
import { overlayBounds } from './redaction-geometry.mjs'
import { watchShareWindow } from './watch-share-window.mjs'

export const MARKS_URL = 'about:blank#kithmoot-share-marks'
export const MARKS_TOOLS_URL = 'about:blank#kithmoot-share-mark-tools'

/** A canvas over the actual capture, plus a small, separate Draw toolbar.
 * Native window geometry follows moves, resizes and minimisation without
 * capturing pixels or inspecting another app's UI. */
export class MarksOverlay {
  window
  tools
  drawing = false
  bounds
  constructor(capture, { watch = (id, report) => watchShareWindow(id, report, { packaged: app.isPackaged }) } = {}) {
    this.capture = capture
    this.watch = watch
    this.place = () => this.#place()
  }
  #secure(window) {
    window.setParentWindow(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform !== 'win32') window.setContentProtection(true)
  }
  attach(window) {
    this.stopWatching?.(); this.stopWatching = undefined
    this.bounds = undefined; this.drawing = false; this.#listen(false)
    if (this.window && !this.window.isDestroyed()) this.window.close()
    this.window = window
    this.#secure(window)
    window.setIgnoreMouseEvents(true)
    window.setFocusable(false)
    window.on('closed', () => {
      if (this.window !== window) return
      this.window = undefined
      this.stopWatching?.(); this.stopWatching = undefined
      this.bounds = undefined; this.drawing = false; this.#listen(false)
      if (this.tools && !this.tools.isDestroyed()) this.tools.close()
    })
    const source = this.capture()
    if (source?.kind === 'window' && source.captureId) {
      window.setAlwaysOnTop(false)
      this.stopWatching = this.watch(source.captureId, raw => {
        if (this.window !== window || window.isDestroyed()) return
        this.bounds = raw ? this.#dipBounds(raw) : undefined
        if (!this.bounds) { this.action('draw', false); window.hide(); this.tools?.hide(); return }
        window.setBounds(this.bounds)
        // Keep other apps above their own windows; marks belong to the
        // selected window rather than floating over whatever later covers it.
        try { window.moveAbove(source.captureId) } catch { window.hide(); this.tools?.hide(); return }
        if (!window.isVisible()) window.showInactive()
        this.#placeTools()
      })
    } else {
      window.setAlwaysOnTop(true, process.platform === 'linux' ? 'normal' : 'screen-saver')
      if (!this.#place()) return
      this.#listen(true)
      window.showInactive()
    }
  }
  attachTools(window) {
    if (this.tools && !this.tools.isDestroyed()) this.tools.close()
    this.tools = window
    this.#secure(window)
    window.setAlwaysOnTop(true)
    window.on('closed', () => { if (this.tools === window) { this.tools = undefined; this.action('draw', false) } })
    this.#placeTools()
  }
  action(action, value) {
    const window = this.window
    if (!window || window.isDestroyed() || action !== 'draw' || typeof value !== 'boolean') return
    if (this.drawing === value) return
    this.drawing = value
    window.setIgnoreMouseEvents(!value)
    this.changed?.(value)
    // Canvas drawing does not need keyboard focus; Escape is handled by the
    // toolbar's own button. The shared app retains its normal focus.
    this.#placeTools()
  }
  close() {
    this.stopWatching?.(); this.stopWatching = undefined
    if (this.window && !this.window.isDestroyed()) this.window.close()
    if (this.tools && !this.tools.isDestroyed()) this.tools.close()
    this.window = this.tools = undefined
    this.bounds = undefined; this.drawing = false; this.#listen(false)
  }
  #dipBounds(raw) {
    let rect = raw
    if (process.platform === 'win32') rect = screen.screenToDipRect(null, raw)
    else if (process.platform === 'linux') {
      const origin = screen.screenToDipPoint({ x: Math.round(raw.x), y: Math.round(raw.y) })
      const display = screen.getDisplayNearestPoint(origin)
      rect = { ...origin, width: raw.width / display.scaleFactor, height: raw.height / display.scaleFactor }
    }
    return Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value)]))
  }
  #placeTools() {
    if (!this.tools || this.tools.isDestroyed() || !this.bounds || !this.window?.isVisible()) { this.tools?.hide(); return }
    const area = screen.getDisplayMatching(this.bounds).workArea
    const width = 290, height = 48
    this.tools.setBounds({ x: Math.round(Math.max(area.x, Math.min(this.bounds.x + this.bounds.width - width, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(this.bounds.y - height, area.y + area.height - height))), width, height })
    if (!this.tools.isVisible()) this.tools.showInactive()
  }
  #place() {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    const bounds = overlayBounds(this.capture(), screen.getAllDisplays())
    if (!bounds) { this.close(); return false }
    this.bounds = bounds
    window.setBounds(bounds)
    this.#placeTools()
    return true
  }
  #listen(on) {
    if (this.listening === on) return
    this.listening = on
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen[on ? 'on' : 'removeListener'](event, this.place)
  }
}
export const MARKS_WINDOW = {
  transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true, hasShadow: false,
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
  skipTaskbar: true, focusable: false, show: false, enableLargerThanScreen: true,
  width: 400, height: 300,
}
export const MARKS_TOOLS_WINDOW = {
  backgroundColor: '#101114', frame: false, alwaysOnTop: true, resizable: false, movable: false,
  minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
  width: 290, height: 48,
}
