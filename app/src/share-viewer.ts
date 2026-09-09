import type { AnnotationPoint, ScreenAnnotation } from '../../src/signal.js'
import { ShareMarks, type LiveMark } from './share-marks.js'

/** Paint strokes in normalised coordinates onto a canvas of any size, each
 *  as strongly as its age allows - see `share-marks.ts`. */
function paintMarks(canvas: HTMLCanvasElement, marks: LiveMark[], pending?: AnnotationPoint[]): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const paintStroke = (points: AnnotationPoint[], alpha: number) => {
    if (points.length < 2 || alpha <= 0) return
    ctx.globalAlpha = alpha
    ctx.beginPath(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, canvas.width / 260)
    ctx.strokeStyle = '#ffd447'; ctx.shadowColor = 'rgb(0 0 0 / 75%)'; ctx.shadowBlur = ctx.lineWidth
    ctx.moveTo(points[0]!.x * canvas.width, points[0]!.y * canvas.height)
    for (const point of points.slice(1)) ctx.lineTo(point.x * canvas.width, point.y * canvas.height)
    ctx.stroke(); ctx.shadowBlur = 0
  }
  for (const mark of marks) paintStroke(mark.annotation.points ?? [], mark.alpha)
  if (pending) paintStroke(pending, 1)
  ctx.globalAlpha = 1
}

/** A second, muted view of a live track. Closing it never stops the call's track. */
export interface ShareSource { id: string; track: MediaStreamTrack; title: string }

export interface ShareViewerOptions {
  onAnnotation?: (annotation: ScreenAnnotation) => void
}

export class ShareViewer {
  readonly #opts: ShareViewerOptions
  #dialog?: HTMLDialogElement
  #popup?: Window
  #dispose?: () => void
  #source?: () => ShareSource | undefined
  #returnFocus?: HTMLElement
  /** Every mark on every share this page knows of, fading as they age.
   *  Shared by the expanded viewer and by every preview overlay. */
  readonly #marks = new ShareMarks()

  constructor(opts: ShareViewerOptions = {}) { this.#opts = opts }

  /** Apply a stroke received from another room device. */
  receive(annotation: ScreenAnnotation): void {
    this.#marks.remember(annotation)
  }

  /**
   * Paint the marks for a share over a preview of it, wherever that preview
   * is: the sharer's own tile above all, because a mark is drawn for the
   * person sharing and they never open a viewer on their own screen. The
   * canvas sits over the video's picture, letterboxing and all, and is
   * hidden while there is nothing to show. Returns a function that takes
   * the overlay away again.
   */
  overlay(video: HTMLVideoElement, shareId: () => string | undefined): () => void {
    const doc = video.ownerDocument
    const canvas = doc.createElement('canvas')
    canvas.className = 'shareMarks'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.hidden = true
    video.after(canvas)
    const paint = () => {
      const parent = video.parentElement
      if (!parent || !video.isConnected) { canvas.hidden = true; return }
      const id = shareId()
      const marks = id ? this.#marks.alive(id) : []
      canvas.dataset.strokes = String(marks.length)
      if (marks.length === 0) { canvas.hidden = true; return }
      if (doc.defaultView?.getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
      // The picture inside the element, under object-fit: contain.
      const box = video.getBoundingClientRect(), outer = parent.getBoundingClientRect()
      const frameWidth = video.videoWidth || 16, frameHeight = video.videoHeight || 9
      const scale = Math.min(box.width / frameWidth, box.height / frameHeight)
      const width = Math.max(1, Math.round(frameWidth * scale)), height = Math.max(1, Math.round(frameHeight * scale))
      canvas.style.left = `${box.left - outer.left + (box.width - width) / 2}px`
      canvas.style.top = `${box.top - outer.top + (box.height - height) / 2}px`
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      canvas.hidden = false
      paintMarks(canvas, marks)
    }
    const unsubscribe = this.#marks.subscribe(paint)
    const size = new ResizeObserver(paint); size.observe(video)
    video.addEventListener('loadedmetadata', paint)
    paint()
    return () => { unsubscribe(); size.disconnect(); video.removeEventListener('loadedmetadata', paint); canvas.remove() }
  }

  open(source: () => ShareSource | undefined, returnFocus?: HTMLElement): void {
    this.close()
    this.#source = source
    this.#returnFocus = returnFocus
    const dialog = document.createElement('dialog')
    dialog.className = 'shareViewer'
    dialog.setAttribute('aria-label', 'Screen-share viewer')
    document.body.append(dialog)
    this.#dialog = dialog
    dialog.addEventListener('close', () => { if (this.#dialog === dialog) this.close() })
    const content = document.createElement('div'); content.className = 'shareViewerContent'; dialog.append(content)
    this.#dispose = this.#mount(content, false)
    dialog.showModal()
  }

  close(): void {
    this.#dispose?.()
    this.#dispose = undefined
    const dialog = this.#dialog
    this.#dialog = undefined
    dialog?.remove()
    const popup = this.#popup
    this.#popup = undefined
    if (popup && !popup.closed) popup.close()
    this.#source = undefined
    if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true })
  }

  #popOut(notice: HTMLElement): void {
    const popup = window.open('', '', 'popup,width=1100,height=760,resizable=yes,scrollbars=no')
    if (!popup) { notice.textContent = 'The pop-out was blocked. Allow pop-ups for this site, or use fullscreen here.'; return }
    this.#dispose?.()
    const dialog = this.#dialog
    this.#dialog = undefined
    dialog?.remove()
    this.#popup = popup
    const doc = popup.document
    doc.title = 'KithMoot screen share'
    doc.documentElement.lang = document.documentElement.lang || 'en'
    for (const sheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = sheet.href; doc.head.append(link)
    }
    // Vite injects development CSS as style nodes; production uses the links above.
    for (const style of document.querySelectorAll('style[data-vite-dev-id]')) doc.head.append(style.cloneNode(true))
    doc.body.className = 'sharePopup'
    const host = doc.createElement('main'); host.className = 'shareViewer'; doc.body.append(host)
    this.#dispose = this.#mount(host, true)
  }

  #mount(host: HTMLElement, popped: boolean): () => void {
    const doc = host.ownerDocument
    const win = doc.defaultView!
    const bar = doc.createElement('div'); bar.className = 'shareViewerBar'
    const title = doc.createElement('h2'); title.textContent = 'Screen share'; bar.append(title)
    const controls = doc.createElement('div'); controls.className = 'shareViewerControls'; bar.append(controls)
    const viewport = doc.createElement('div'); viewport.className = 'shareViewport'; viewport.tabIndex = 0
    viewport.setAttribute('aria-label', 'Shared screen. Use plus and minus to zoom, arrow keys to pan, and zero to fit.')
    const stage = doc.createElement('div'); stage.className = 'shareStage'
    const video = doc.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true
    const canvas = doc.createElement('canvas'); canvas.className = 'shareAnnotations'; canvas.setAttribute('aria-hidden', 'true')
    stage.append(video, canvas); viewport.append(stage)
    const notice = doc.createElement('p'); notice.className = 'shareViewerNotice'; notice.setAttribute('role', 'status')
    host.append(bar, viewport, notice)
    let track: MediaStreamTrack | undefined
    let zoom = 1, x = 0, y = 0, width = 0, height = 0
    let dragging: { id: number; x: number; y: number } | undefined
    let drawing = false
    let stroke: AnnotationPoint[] | undefined
    const fingers = new Map<number, { x: number; y: number }>()
    let pinchDistance = 0
    const makeButton = (label: string, action: () => void) => {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label
      button.addEventListener('click', action); controls.append(button); return button
    }
    const out = makeButton('−', () => setZoom(zoom / 1.25)); out.setAttribute('aria-label', 'Zoom out')
    const amount = doc.createElement('output'); amount.setAttribute('aria-label', 'Zoom level'); controls.append(amount)
    const into = makeButton('+', () => setZoom(zoom * 1.25)); into.setAttribute('aria-label', 'Zoom in')
    const fit = makeButton('Fit to screen', () => { x = 0; y = 0; setZoom(1) })
    const draw = makeButton('Draw', () => {
      drawing = !drawing
      draw.setAttribute('aria-pressed', String(drawing))
      viewport.classList.toggle('drawing', drawing)
      notice.textContent = drawing ? 'Draw on the shared screen. The person sharing sees each line when you lift your finger, and it fades after a couple of seconds.' : 'Scroll or use + and − to zoom. Drag to move around.'
    })
    draw.setAttribute('aria-pressed', 'false')
    const clear = makeButton('Clear marks', () => {
      const shareId = this.#source?.()?.id
      if (!shareId) return
      const annotation: ScreenAnnotation = { op: 'clear', shareId, strokeId: '' }
      this.#marks.remember(annotation); this.#opts.onAnnotation?.(annotation)
    })
    const fullscreen = makeButton('Fullscreen', () => {
      const request = doc.fullscreenElement ? doc.exitFullscreen() : host.requestFullscreen?.()
      if (!request) { notice.textContent = 'Fullscreen is unavailable in this browser. The viewer still fills this window.'; return }
      void request.catch(() => { notice.textContent = 'Fullscreen could not open. You can still zoom or pop out the share.' })
    })
    if (!doc.fullscreenEnabled) fullscreen.hidden = true
    if (!popped) makeButton('Pop out', () => this.#popOut(notice))
    const close = makeButton('Close', () => this.close()); close.setAttribute('aria-label', 'Close screen-share viewer')
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape' && popped && !doc.fullscreenElement) { event.preventDefault(); this.close() }
    })
    const renderAnnotations = () => {
      const current = this.#source?.()
      const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
      const pixelWidth = Math.max(640, Math.min(1920, video.videoWidth || 1280))
      const pixelHeight = Math.round(pixelWidth / ratio)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight }
      const marks = current ? this.#marks.alive(current.id) : []
      paintMarks(canvas, marks, stroke)
      canvas.dataset.strokes = String(marks.length)
      clear.disabled = !current
    }
    const paint = () => {
      const vw = viewport.clientWidth, vh = viewport.clientHeight
      const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
      width = Math.min(vw, vh * ratio); height = width / ratio
      const limitX = Math.max(0, (width * zoom - vw) / 2), limitY = Math.max(0, (height * zoom - vh) / 2)
      x = Math.max(-limitX, Math.min(limitX, x)); y = Math.max(-limitY, Math.min(limitY, y))
      stage.style.width = `${width}px`; stage.style.height = `${height}px`
      stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
      viewport.dataset.zoom = String(zoom)
      viewport.classList.toggle('zoomed', zoom > 1)
      amount.textContent = `${Math.round(zoom * 100)}%`
      fullscreen.textContent = doc.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'
      out.disabled = zoom <= 1 || !track; into.disabled = zoom >= 8 || !track; fit.disabled = !track
      draw.disabled = !track
      renderAnnotations()
    }
    const setZoom = (value: number) => { zoom = Math.max(1, Math.min(8, value)); paint() }
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      if (drawing && track) {
        const rect = stage.getBoundingClientRect()
        stroke = [{ x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }]
        dragging = { id: event.pointerId, x: 0, y: 0 }
        viewport.setPointerCapture(event.pointerId); event.preventDefault(); viewport.focus(); renderAnnotations(); return
      }
      fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()]
        pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y); dragging = undefined
      } else if (zoom > 1) dragging = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y }
      viewport.setPointerCapture(event.pointerId); event.preventDefault(); viewport.focus()
    })
    viewport.addEventListener('pointermove', event => {
      if (drawing && stroke && dragging?.id === event.pointerId) {
        const rect = stage.getBoundingClientRect()
        const point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
        const last = stroke.at(-1)!
        if (stroke.length < 128 && Math.hypot(point.x - last.x, point.y - last.y) > 0.002) stroke.push(point)
        renderAnnotations(); return
      }
      if (fingers.has(event.pointerId)) fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()]
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        if (pinchDistance > 0 && distance > 0) setZoom(zoom * distance / pinchDistance)
        pinchDistance = distance; return
      }
      if (!dragging || event.pointerId !== dragging.id) return
      x = event.clientX - dragging.x; y = event.clientY - dragging.y; paint()
    })
    const stopDragging = (event: PointerEvent) => {
      if (drawing && stroke && dragging?.id === event.pointerId) {
        const points = stroke; stroke = undefined
        const shareId = this.#source?.()?.id
        if (shareId && points.length > 1) {
          const annotation: ScreenAnnotation = { op: 'stroke', shareId, strokeId: crypto.randomUUID(), points }
          this.#marks.remember(annotation); this.#opts.onAnnotation?.(annotation)
        }
        renderAnnotations()
      }
      fingers.delete(event.pointerId); dragging = undefined; pinchDistance = 0
    }
    viewport.addEventListener('pointerup', stopDragging); viewport.addEventListener('pointercancel', stopDragging)
    viewport.addEventListener('wheel', event => { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)) }, { passive: false })
    viewport.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') setZoom(zoom * 1.25)
      else if (event.key === '-') setZoom(zoom / 1.25)
      else if (event.key === '0') { x = 0; y = 0; setZoom(1) }
      else if (event.key === 'ArrowLeft') { x += 50; paint() }
      else if (event.key === 'ArrowRight') { x -= 50; paint() }
      else if (event.key === 'ArrowUp') { y += 50; paint() }
      else if (event.key === 'ArrowDown') { y -= 50; paint() }
      else return
      event.preventDefault()
    })
    const refresh = () => {
      if (popped && win.closed) { this.close(); return }
      const current = this.#source?.()
      const next = current?.track.readyState === 'live' ? current.track : undefined
      if (next !== track) {
        track = next
        video.srcObject = next ? new MediaStream([next]) : null
        notice.textContent = next ? 'Scroll or use + and − to zoom. Drag to move around. Fit to screen resets the view.' : 'Screen sharing has stopped or is reconnecting.'
        if (next) void video.play().catch(() => { notice.textContent = 'Press the shared screen to start its video.' })
      }
      if (!next && !notice.textContent) notice.textContent = 'Screen sharing has stopped or is reconnecting.'
      if (current) title.textContent = current.title
      paint()
    }
    video.addEventListener('loadedmetadata', paint)
    doc.addEventListener('fullscreenchange', paint)
    viewport.addEventListener('click', () => { if (track) void video.play().catch(() => {}) })
    const size = new ResizeObserver(paint); size.observe(viewport)
    const pageGone = () => { if (popped && this.#popup === win) this.close() }
    if (popped) win.addEventListener('pagehide', pageGone)
    const timer = window.setInterval(refresh, 250)
    const unsubscribe = this.#marks.subscribe(renderAnnotations)
    refresh()
    return () => { unsubscribe(); win.removeEventListener('pagehide', pageGone); window.clearInterval(timer); size.disconnect(); doc.removeEventListener('fullscreenchange', paint); video.pause(); video.srcObject = null }
  }
}
