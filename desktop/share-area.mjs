import { screen, desktopCapturer } from 'electron'

export const AREA_URL = 'about:blank#kithmoot-share-area'
import { areaRect } from './share-area-geometry.mjs'

export class ShareArea {
  window
  display
  constructor(owner) { this.owner = owner }
  attach(window) {
    this.close()
    this.window = window
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
    if (!this.window || this.window.isDestroyed()) return callback({})
    const window = this.window
    this.display = screen.getDisplayMatching(window.getBounds())
    const display = this.display
    if (!this.state()) return callback({})
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const source = sources.find(item => item.display_id === String(display.id))
    if (!source || this.window !== window || window.isDestroyed() || this.display !== display || !this.state()) return callback({})
    this.owner()?.webContents.send('desktop:area-state', this.state())
    callback({ video: source, ...(request.audioRequested && ['darwin', 'win32'].includes(process.platform) ? { audio: 'loopback' } : {}) })
  }
  action(action, value) {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (action === 'close') return this.close()
    if (action === 'passthrough' && typeof value === 'boolean') window.setIgnoreMouseEvents(value, { forward: true })
    if (action === 'bounds' && value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))) {
      window.setBounds({ x: Math.max(-32000, Math.min(32000, Math.round(value.x))), y: Math.max(-32000, Math.min(32000, Math.round(value.y))), width: Math.max(460, Math.min(8000, Math.round(value.width))), height: Math.max(200, Math.min(8000, Math.round(value.height))) })
    }
    if (action === 'resize' && value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
      window.setSize(Math.max(460, Math.min(8000, Math.round(value.width))), Math.max(200, Math.min(8000, Math.round(value.height))))
    }
  }
  close() { const window = this.window; this.window = undefined; this.display = undefined; if (window && !window.isDestroyed()) window.close() }
}
