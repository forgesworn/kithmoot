import { screen } from 'electron'
import { BOX_MIN, captureOf, clampBox, insideHole, moveTo, placeBox, resizeFrom } from './redaction-geometry.mjs'

export const BOX_URL = 'about:blank#kithmoot-redaction-box-'
const BOX_ID = /^[a-z0-9-]{1,40}$/

export function boxId(url) {
  if (typeof url !== 'string' || !url.startsWith(BOX_URL)) return undefined
  const id = url.slice(BOX_URL.length)
  return BOX_ID.test(id) ? id : undefined
}

/**
 * Redaction boxes: see-through windows on the real screen whose areas are
 * painted black in every outgoing screen or area share. The page draws each
 * box's controls; this process owns where each box is and whether it is on,
 * because only real window bounds can say what a box covers.
 */
export class Redaction {
  boxes = new Map()
  capture = null
  cursorTimer
  constructor(owner) { this.owner = owner }
  // A display added, removed or rescaled moves every box's place in the
  // picture. `screen` exists only once the app is ready, so listen lazily.
  listen() {
    if (this.listening) return
    this.listening = true
    const report = () => this.report()
    screen.on('display-added', report)
    screen.on('display-removed', report)
    screen.on('display-metrics-changed', report)
  }
  anyOn() { return [...this.boxes.values()].some(box => box.on) }
  state() {
    const displays = screen.getAllDisplays().map(display => ({ id: String(display.id), bounds: { ...display.bounds } }))
    const boxes = [...this.boxes].filter(([, box]) => !box.window.isDestroyed()).map(([id, box]) => ({ id, on: box.on, bounds: box.window.getBounds() }))
    return { boxes, displays, source: this.capture }
  }
  report() { this.owner()?.webContents.send('desktop:redaction-state', this.state()) }
  /** A new share is about to be chosen: forget the last one's source. */
  begin() { this.capture = null; this.report() }
  /** The source the display handler actually answered with. */
  captured(source) { this.capture = captureOf(source, screen.getAllDisplays()); this.report() }
  capturedDisplay(display) { this.capture = display ? { kind: 'screen', displayId: String(display.id) } : null; this.report() }
  attach(window, id) {
    if (this.boxes.has(id)) { window.close(); return }
    this.listen()
    const box = { window, on: true, ignoring: undefined, drag: undefined }
    this.boxes.set(id, box)
    window.setParentWindow(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    if (process.platform === 'linux') window.setAlwaysOnTop(true)
    else window.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Where the OS honours it, the box itself stays out of every capture. A
    // nice extra only: the black comes from the page, never from this.
    window.setContentProtection(true)
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    window.setBounds(placeBox(display.workArea, this.boxes.size - 1))
    window.on('move', () => this.report())
    window.on('resize', () => this.report())
    window.on('closed', () => { if (this.boxes.get(id) === box) this.boxes.delete(id); this.watchCursor(); this.report() })
    this.watchCursor()
    this.report()
  }
  action(id, action, value) {
    if (action === 'all') {
      if (typeof value !== 'boolean') return
      for (const box of this.boxes.values()) box.on = value
      return this.report()
    }
    if (action === 'close-all') return this.closeAll()
    const box = this.boxes.get(id)
    if (!box || box.window.isDestroyed()) return
    const window = box.window
    if (action === 'close') return window.close()
    if (action === 'toggle') { box.on = typeof value === 'boolean' ? value : !box.on; return this.report() }
    // Moving and resizing follow the real cursor, not renderer coordinates,
    // which lag behind a window that moves under the pointer.
    if (action === 'move-start' || action === 'resize-start') {
      const cursor = screen.getCursorScreenPoint(), bounds = window.getBounds()
      if (action === 'resize-start' && !['nw', 'ne', 'sw', 'se'].includes(value)) return
      box.drag = { cursor, bounds, corner: action === 'resize-start' ? value : undefined }
      this.setIgnore(box, false)
      return
    }
    if (action === 'drag' && box.drag) {
      const cursor = screen.getCursorScreenPoint()
      const { bounds, corner } = box.drag
      const next = corner ? resizeFrom(corner, bounds, cursor.x - box.drag.cursor.x, cursor.y - box.drag.cursor.y) : moveTo(cursor, { x: box.drag.cursor.x - bounds.x, y: box.drag.cursor.y - bounds.y }, bounds)
      if (next) window.setBounds(next)
      return
    }
    if (action === 'drag-end') { box.drag = undefined; return }
    // Keyboard: arrow keys nudge the box or one corner by a fixed step.
    if (action === 'nudge' && value && Number.isFinite(value.dx) && Number.isFinite(value.dy)) {
      const dx = Math.max(-50, Math.min(50, value.dx)), dy = Math.max(-50, Math.min(50, value.dy))
      const bounds = window.getBounds()
      const next = value.corner ? resizeFrom(value.corner, bounds, dx, dy) : clampBox({ ...bounds, x: bounds.x + dx, y: bounds.y + dy })
      if (next) window.setBounds(next)
    }
  }
  setIgnore(box, ignore) {
    if (box.ignoring === ignore || box.window.isDestroyed()) return
    box.ignoring = ignore
    box.window.setIgnoreMouseEvents(ignore, { forward: true })
  }
  // Forwarded mouse moves are unreliable on Windows and Linux, so the page
  // cannot be trusted to say when the pointer leaves the see-through middle.
  // Watch the real cursor here instead, as the area frame does.
  watchCursor() {
    if (this.boxes.size === 0) { clearInterval(this.cursorTimer); this.cursorTimer = undefined; return }
    if (this.cursorTimer) return
    this.cursorTimer = setInterval(() => {
      const cursor = screen.getCursorScreenPoint()
      for (const box of this.boxes.values()) {
        if (box.window.isDestroyed()) continue
        this.setIgnore(box, !box.drag && insideHole(cursor, box.window.getBounds()))
      }
    }, 50)
  }
  closeAll() {
    for (const box of [...this.boxes.values()]) if (!box.window.isDestroyed()) box.window.close()
    this.boxes.clear()
    this.watchCursor()
    this.report()
  }
}

export const BOX_WINDOW = {
  transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true, hasShadow: false,
  resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
  width: 360, height: 220, minWidth: BOX_MIN.width, minHeight: BOX_MIN.height,
}
