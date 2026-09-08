import type { AnnotationPoint, ScreenAnnotation } from '../../src/signal.js'

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
  #repaint?: () => void
  readonly #annotations = new Map<string, ScreenAnnotation[]>()

  constructor(opts: ShareViewerOptions = {}) { this.#opts = opts }

  /** Apply a stroke received from another room device. */
  receive(annotation: ScreenAnnotation): void {
    this.#remember(annotation)
    this.#repaint?.()
  }

  #remember(annotation: ScreenAnnotation): void {
    if (annotation.op === 'clear') {
      this.#annotations.delete(annotation.shareId)
      return
    }
    const strokes = this.#annotations.get(annotation.shareId) ?? []
    if (strokes.some(stroke => stroke.strokeId === annotation.strokeId)) return
    strokes.push(annotation)
    while (strokes.length > 100) strokes.shift()
    this.#annotations.set(annotation.shareId, strokes)
    while (this.#annotations.size > 16) {
      const oldest = this.#annotations.keys().next().value
      if (oldest === undefined) break
      this.#annotations.delete(oldest)
    }
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
    this.#repaint = undefined
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
      notice.textContent = drawing ? 'Draw on the shared screen. The other person will see each line when you lift your finger.' : 'Scroll or use + and − to zoom. Drag to move around.'
    })
    draw.setAttribute('aria-pressed', 'false')
    const clear = makeButton('Clear marks', () => {
      const shareId = this.#source?.()?.id
      if (!shareId) return
      const annotation: ScreenAnnotation = { op: 'clear', shareId, strokeId: '' }
      this.#remember(annotation); this.#opts.onAnnotation?.(annotation); renderAnnotations()
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
      const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height)
      const strokes = current ? this.#annotations.get(current.id) ?? [] : []
      const paintStroke = (points: AnnotationPoint[]) => {
        if (points.length < 2) return
        ctx.beginPath(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(4, canvas.width / 260)
        ctx.strokeStyle = '#ffd447'; ctx.shadowColor = 'rgb(0 0 0 / 75%)'; ctx.shadowBlur = ctx.lineWidth
        ctx.moveTo(points[0]!.x * canvas.width, points[0]!.y * canvas.height)
        for (const point of points.slice(1)) ctx.lineTo(point.x * canvas.width, point.y * canvas.height)
        ctx.stroke(); ctx.shadowBlur = 0
      }
      for (const saved of strokes) paintStroke(saved.points ?? [])
      if (stroke) paintStroke(stroke)
      canvas.dataset.strokes = String(strokes.length)
      clear.disabled = !current || strokes.length === 0
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
          this.#remember(annotation); this.#opts.onAnnotation?.(annotation)
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
    this.#repaint = renderAnnotations
    refresh()
    return () => { if (this.#repaint === renderAnnotations) this.#repaint = undefined; win.removeEventListener('pagehide', pageGone); window.clearInterval(timer); size.disconnect(); doc.removeEventListener('fullscreenchange', paint); video.pause(); video.srcObject = null }
  }
}
