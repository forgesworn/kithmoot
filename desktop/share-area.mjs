import { screen, desktopCapturer } from 'electron'

export const AREA_URL = 'about:blank#kithmoot-share-area'
import { areaRect } from './share-area-geometry.mjs'
import { refuse } from './screen-share.mjs'

export class ShareArea {
  window
  display
  releaseOwnerFront
  constructor(owner) { this.owner = owner }
  attach(window) {
    this.close()
    this.window = window
    // A window opened by the renderer is otherwise a native child of the main
    // window on macOS. Detach it so either window can be deliberately raised.
    window.setParentWindow(null)
    window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    const report = () => this.owner()?.webContents.send('desktop:area-state', this.state())
    window.on('move', report)
    window.on('resize', report)
    window.on('closed', () => { if (this.window === window) { this.window = undefined; this.display = undefined; report() } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
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
    this.display = screen.getDisplayMatching(window.getBounds())
    const display = this.display
    if (!this.state()) return refuse(callback)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const source = sources.find(item => item.display_id === String(display.id))
    if (!source || this.window !== window || window.isDestroyed() || this.display !== display || !this.state()) return refuse(callback)
    this.owner()?.webContents.send('desktop:area-state', this.state())
    callback({ video: source, ...(request.audioRequested && ['darwin', 'win32'].includes(process.platform) ? { audio: 'loopback' } : {}) })
  }
  action(action, value) {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (action === 'close') return this.close()
    if (action === 'owner') return this.showOwner()
    if (action === 'passthrough' && typeof value === 'boolean') window.setIgnoreMouseEvents(value, { forward: true })
    if (action === 'bounds' && value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) {
      window.setBounds({ x: Math.max(-32000, Math.min(32000, Math.round(value.x))), y: Math.max(-32000, Math.min(32000, Math.round(value.y))), width: Math.max(460, Math.min(8000, Math.round(value.width))), height: Math.max(200, Math.min(8000, Math.round(value.height))) })
    }
    if (action === 'resize' && value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
      window.setSize(Math.max(460, Math.min(8000, Math.round(value.width))), Math.max(200, Math.min(8000, Math.round(value.height))))
    }
  }
  showOwner() {
    const window = this.window
    const owner = this.owner()
    if (!window || window.isDestroyed() || !owner || owner.isDestroyed()) return
    this.releaseOwnerFront?.()
    if (owner.isMinimized()) owner.restore()
    owner.show()
    // Give the call window the same native level briefly so it can sit above
    // the capture frame while the person uses it. The frame retakes the front
    // as soon as they return to another app.
    owner.setAlwaysOnTop(true, 'screen-saver')
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
        window.setAlwaysOnTop(true, 'screen-saver')
        window.moveTop()
      }
    }
    this.releaseOwnerFront = release
    owner.once('blur', release)
  }
  close() {
    this.releaseOwnerFront?.()
    const window = this.window
    this.window = undefined
    this.display = undefined
    if (window && !window.isDestroyed()) window.close()
  }
}
