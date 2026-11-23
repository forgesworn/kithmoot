import type { AnnotationPoint, ScreenAnnotation } from '../../src/signal.js'
type Bridge = NonNullable<Window['kithmootDesktop']>
const MARKS_URL = 'about:blank#kithmoot-share-marks'
const TOOLS_URL = 'about:blank#kithmoot-share-mark-tools'

export interface ShareMarksOverlayOptions {
  paint: (canvas: HTMLCanvasElement, shareId: () => string | undefined) => () => void
  draw: (annotation: ScreenAnnotation) => void
  stop: () => void
  watch: (shareId: () => string | undefined, paint: (marks: { points: AnnotationPoint[]; color: string; alpha: number }[]) => void) => () => void
}

/** The main process positions this canvas over the actual selected window or
 * display. The separate toolbar switches between ordinary use and drawing. */
export class ShareMarksOverlay {
  #popup?: Window
  #tools?: Window
  #dispose?: () => void
  #lease?: string
  constructor(private readonly bridge: Bridge | undefined, private readonly opts: ShareMarksOverlayOptions) {}
  get supported(): boolean { return Boolean(this.bridge?.supportsRedaction) }
  get isOpen(): boolean { return Boolean(this.#popup && !this.#popup.closed) }

  async openCompositor(kind: 'window' | 'screen', shareId: () => string | undefined): Promise<boolean> {
    this.close()
    const bridge = this.bridge
    if (!bridge?.supportsCompositorMarks || !bridge.compositorMarksBegin || !bridge.onCompositorMark) return false
    const lease = crypto.randomUUID()
    this.#lease = lease
    const stopEvents = bridge.onCompositorMark((incoming, command) => {
      const id = shareId()
      if (this.#lease !== lease || incoming !== lease || !id) return
      if (command.op === 'stop') this.opts.stop()
      else this.opts.draw({ op: command.op, shareId: id, strokeId: command.op === 'stroke' ? crypto.randomUUID() : '', ...(command.op === 'stroke' ? { points: command.points } : {}) })
    })
    this.#dispose = stopEvents
    const ready = await bridge.compositorMarksBegin(lease, kind).catch(() => false)
    if (this.#lease !== lease) return false
    if (!ready) { this.close(); return false }
    const stopWatching = this.opts.watch(shareId, marks => bridge.compositorMarksPaint?.(lease, marks))
    this.#dispose = () => { stopEvents(); stopWatching() }
    return true
  }

  open(shareId: () => string | undefined): void {
    if (!this.supported) return
    this.close()
    const popup = window.open(MARKS_URL, '_blank', 'popup,width=400,height=300')
    if (!popup) return
    this.#popup = popup
    const doc = popup.document
    doc.title = 'Marks on your share'
    const style = doc.createElement('style')
    style.textContent = 'html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;pointer-events:none}canvas{display:block;width:100vw;height:100vh;touch-action:none}body.drawing{pointer-events:auto;cursor:crosshair}'
    doc.head.append(style)
    const canvas = doc.createElement('canvas')
    canvas.className = 'shareMarksOverlay'
    canvas.setAttribute('aria-label', 'Draw on your shared window or screen')
    doc.body.append(canvas)
    const stopPainting = this.opts.paint(canvas, shareId)
    const tools = window.open(TOOLS_URL, '_blank', 'popup,width=290,height=48')
    if (!tools) { stopPainting(); this.close(); return }
    this.#tools = tools
    const toolDoc = tools.document
    toolDoc.title = 'Share drawing controls'
    const rules = toolDoc.createElement('style')
    rules.textContent = 'html,body{margin:0;background:#101114;color:white;font:13px sans-serif}body{display:flex;align-items:center;justify-content:center;gap:6px;height:48px}button{font:inherit;padding:8px;min-height:36px}button[aria-pressed=true]{background:#4ecbff;color:#101114}'
    toolDoc.head.append(rules)
    let drawing = false, pointer: number | undefined, points: AnnotationPoint[] = [], sent = 0
    const flush = () => {
      const id = shareId()
      if (!id || points.length < 2) return
      this.opts.draw({ op: 'stroke', shareId: id, strokeId: crypto.randomUUID(), points: [...points] })
      points = [points.at(-1)!]; sent = performance.now()
    }
    const finish = () => { flush(); points = []; pointer = undefined }
    const button = (label: string, action: () => void) => {
      const node = toolDoc.createElement('button'); node.type = 'button'; node.textContent = label
      node.onclick = action; toolDoc.body.append(node); return node
    }
    const setDrawing = (value: boolean, notify = true) => {
      finish(); drawing = value
      draw.setAttribute('aria-pressed', String(value))
      draw.textContent = value ? 'Use window' : 'Draw'
      doc.body.classList.toggle('drawing', value)
      if (notify) this.bridge?.marksAction?.('draw', value)
    }
    const draw = button('Draw', () => setDrawing(!drawing))
    draw.setAttribute('aria-pressed', 'false')
    const stopDrawingState = this.bridge?.onMarksDrawing?.(value => { if (drawing !== value) { points = []; pointer = undefined; setDrawing(value, false) } })
    button('Clear marks', () => {
      const id = shareId(); if (id) this.opts.draw({ op: 'clear', shareId: id, strokeId: '' })
    })
    button('Stop sharing', () => this.opts.stop())
    const point = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
    }
    canvas.onpointerdown = event => {
      if (!drawing || event.button !== 0 || pointer !== undefined) return
      pointer = event.pointerId; points = [point(event)]; sent = 0
      canvas.setPointerCapture(pointer)
    }
    canvas.onpointermove = event => {
      if (pointer !== event.pointerId) return
      points.push(point(event))
      if (performance.now() - sent >= 50 || points.length >= 128) flush()
    }
    const release = (event: PointerEvent) => { if (pointer === event.pointerId) finish() }
    popup.addEventListener('pointerup', release); popup.addEventListener('pointercancel', release)
    tools.addEventListener('keydown', event => { if (event.key === 'Escape') setDrawing(false) })
    const gone = () => this.close()
    popup.addEventListener('pagehide', gone); tools.addEventListener('pagehide', gone)
    this.#dispose = () => {
      // Never publish an unfinished stroke after its call/share has ended.
      points = []; pointer = undefined
      this.bridge?.marksAction?.('draw', false)
      popup.removeEventListener('pagehide', gone); tools.removeEventListener('pagehide', gone)
      popup.removeEventListener('pointerup', release); popup.removeEventListener('pointercancel', release)
      stopDrawingState?.(); stopPainting()
    }
  }
  close(): void {
    const lease = this.#lease; this.#lease = undefined
    if (lease) this.bridge?.compositorMarksEnd?.(lease)
    this.#dispose?.(); this.#dispose = undefined
    const popup = this.#popup, tools = this.#tools
    this.#popup = this.#tools = undefined
    if (tools && !tools.closed) tools.close()
    if (popup && !popup.closed) popup.close()
  }
}
