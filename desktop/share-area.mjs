import { screen, desktopCapturer } from 'electron'

export const AREA_URL = 'about:blank#kithmoot-share-area'
import { areaRect, areaShape, insideArea } from './share-area-geometry.mjs'
import { sourceForDisplay, sourceForPortal } from './share-area-source.mjs'
import { refuse } from './screen-share.mjs'

export class ShareArea {
  window
  display
  releaseOwnerFront
  refusal
  drawing = false
  // X11 is given the frame's shape, so the server itself sends clicks in the
  // hole to whatever is beneath. Watching the cursor cannot do that job
  // there: Electron's cursor position stops updating once the pointer is
  // over another program's window, so with KithMoot minimised a frame that
  // went click-through stayed so.
  constructor(owner, mode = 'frame', { shaped = process.platform === 'linux' } = {}) { this.owner = owner; this.mode = mode; this.shaped = shaped }
  get preview() { return this.mode === 'preview' }
  attach(window) {
    this.close()
    this.window = window
    // A window opened by the renderer is otherwise a native child of the main
    // window on macOS. Detach it so either window can be deliberately raised.
    window.setParentWindow(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    // A preview is an ordinary window: the renderer owns the rectangle.
    if (this.preview) {
      window.on('closed', () => { if (this.window === window) this.window = undefined })
      return
    }
    if (process.platform === 'linux') window.setAlwaysOnTop(true)
    else window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    const report = () => { this.owner()?.webContents.send('desktop:area-state', this.state()); this.reportCheck() }
    window.on('move', report)
    window.on('resize', () => { this.shape(window); report() })
    window.on('closed', () => { if (this.window === window) { this.window = undefined; this.display = undefined; report() } })
    this.shape(window)
  }
  // Drawing needs the hole back: the pen is taken by a canvas that fills it.
  // The whole window is named outright, because an empty list did not give
  // the hole back on X11.
  shape(window) {
    if (!this.shaped || window.isDestroyed()) return
    const { width, height } = window.getBounds()
    window.setShape(this.drawing ? [{ x: 0, y: 0, width, height }] : areaShape({ width, height }))
  }
  /** Whether the part to be shared sits wholly on one display. */
  fits() {
    if (!this.window || this.window.isDestroyed() || this.preview) return false
    const bounds = this.window.getBounds()
    return areaRect(bounds, screen.getDisplayMatching(bounds).bounds) !== null
  }
  /** Where the frame stands, and why the last request to share was refused. */
  check() { return { fits: this.fits(), refusal: this.refusal ?? null } }
  reportCheck() { this.owner()?.webContents.send('desktop:area-check', this.check()) }
  // A refusal the person can put right is remembered, so the page can say
  // what to do rather than close the frame without a word.
  refused(reason, callback) {
    this.refusal = reason
    this.display = undefined
    this.reportCheck()
    refuse(callback)
  }
  state() {
    if (!this.window || this.window.isDestroyed() || !this.display) return null
    const display = screen.getAllDisplays().find(item => item.id === this.display.id)
    if (!display || JSON.stringify(display.bounds) !== JSON.stringify(this.display.bounds)) return null
    return areaRect(this.window.getBounds(), display.bounds)
  }
  async capture(request, callback) {
    if (!this.window || this.window.isDestroyed()) return refuse(callback)
    const window = this.window
    if (this.preview) {
      const source = sourceForPortal(await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }))
      if (!source || this.window !== window || window.isDestroyed()) return refuse(callback)
      return callback({ video: source })
    }
    this.refusal = undefined
    this.display = screen.getDisplayMatching(window.getBounds())
    const display = this.display
    if (!this.state()) return this.refused('placement', callback)
    const displays = screen.getAllDisplays()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const source = sourceForDisplay(sources, display, displays)
    if (this.window !== window || window.isDestroyed()) return refuse(callback)
    if (this.display !== display || !this.state()) return this.refused('placement', callback)
    if (!source) return this.refused('source', callback)
    this.owner()?.webContents.send('desktop:area-state', this.state())
    callback({ video: source, ...(request.audioRequested && ['darwin', 'win32'].includes(process.platform) ? { audio: 'loopback' } : {}) })
  }
  action(action, value) {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (action === 'close') return this.close()
    if (action === 'owner') return this.showOwner()
    if (this.preview) return
    if (action === 'drawing' && typeof value === 'boolean') { this.drawing = value; this.shape(window) }
    if (action === 'passthrough' && typeof value === 'boolean' && !this.shaped) this.passthrough(window, value)
    // Moving follows the real cursor rather than renderer coordinates, which
    // lag behind a window that moves under the pointer.
    if (action === 'move-start') {
      const cursor = screen.getCursorScreenPoint(), [x, y] = window.getPosition()
      this.moveOffset = { x: cursor.x - x, y: cursor.y - y }
    }
    if (action === 'move' && this.moveOffset) {
      const cursor = screen.getCursorScreenPoint()
      window.setPosition(Math.max(-32000, Math.min(32000, cursor.x - this.moveOffset.x)), Math.max(-32000, Math.min(32000, cursor.y - this.moveOffset.y)))
    }
    if (action === 'move-end') this.moveOffset = undefined
    if (action === 'bounds' && value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) {
      window.setBounds({ x: Math.max(-32000, Math.min(32000, Math.round(value.x))), y: Math.max(-32000, Math.min(32000, Math.round(value.y))), width: Math.max(460, Math.min(8000, Math.round(value.width))), height: Math.max(200, Math.min(8000, Math.round(value.height))) })
    }
    if (action === 'resize' && value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
      window.setSize(Math.max(460, Math.min(8000, Math.round(value.width))), Math.max(200, Math.min(8000, Math.round(value.height))))
    }
  }
  // Linux cannot forward mouse moves to an ignoring window, and Windows does
  // not reliably either, so the renderer may never learn the pointer has left
  // the hole and the whole frame stays click-through. Watch the cursor here.
  passthrough(window, ignore) {
    clearInterval(this.passthroughTimer)
    this.passthroughTimer = undefined
    window.setIgnoreMouseEvents(ignore, { forward: true })
    if (!ignore) return
    this.passthroughTimer = setInterval(() => {
      if (window.isDestroyed() || this.window !== window) return clearInterval(this.passthroughTimer)
      if (!insideArea(screen.getCursorScreenPoint(), window.getBounds())) this.passthrough(window, false)
    }, 50)
  }
  showOwner() {
    const window = this.window
    const owner = this.owner()
    if (!window || window.isDestroyed() || !owner || owner.isDestroyed()) return
    this.releaseOwnerFront?.()
    if (owner.isMinimized()) owner.restore()
    owner.show()
    if (this.preview) return owner.focus()
    // Give the call window the same native level briefly so it can sit above
    // the capture frame while the person uses it. The frame retakes the front
    // as soon as they return to another app.
    if (process.platform === 'linux') owner.setAlwaysOnTop(true)
    else owner.setAlwaysOnTop(true, 'screen-saver')
    owner.moveTop()
    owner.focus()
    let released = false
    const release = () => {
      if (released) return
      released = true
      owner.removeListener('blur', release)
      this.releaseOwnerFront = undefined
      if (!owner.isDestroyed()) owner.setAlwaysOnTop(false)
      if (this.window === window && !window.isDestroyed()) {
        if (process.platform === 'linux') window.setAlwaysOnTop(true)
        else window.setAlwaysOnTop(true, 'screen-saver')
        window.moveTop()
      }
    }
    this.releaseOwnerFront = release
    owner.once('blur', release)
  }
  close() {
    clearInterval(this.passthroughTimer)
    this.passthroughTimer = undefined
    this.releaseOwnerFront?.()
    const window = this.window
    this.window = undefined
    this.display = undefined
    this.moveOffset = undefined
    this.refusal = undefined
    this.drawing = false
    if (window && !window.isDestroyed()) window.close()
  }
}
