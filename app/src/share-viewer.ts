/** A second, muted view of a live track. Closing it never stops the call's track. */
export interface ShareSource { track: MediaStreamTrack; title: string }

export class ShareViewer {
  #dialog?: HTMLDialogElement
  #popup?: Window
  #dispose?: () => void
  #source?: () => ShareSource | undefined
  #returnFocus?: HTMLElement

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
    const video = doc.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true
    viewport.append(video)
    const notice = doc.createElement('p'); notice.className = 'shareViewerNotice'; notice.setAttribute('role', 'status')
    host.append(bar, viewport, notice)
    let track: MediaStreamTrack | undefined
    let zoom = 1, x = 0, y = 0, width = 0, height = 0
    let dragging: { id: number; x: number; y: number } | undefined
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
    const paint = () => {
      const vw = viewport.clientWidth, vh = viewport.clientHeight
      const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
      width = Math.min(vw, vh * ratio); height = width / ratio
      const limitX = Math.max(0, (width * zoom - vw) / 2), limitY = Math.max(0, (height * zoom - vh) / 2)
      x = Math.max(-limitX, Math.min(limitX, x)); y = Math.max(-limitY, Math.min(limitY, y))
      video.style.width = `${width}px`; video.style.height = `${height}px`
      video.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
      viewport.dataset.zoom = String(zoom)
      viewport.classList.toggle('zoomed', zoom > 1)
      amount.textContent = `${Math.round(zoom * 100)}%`
      fullscreen.textContent = doc.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'
      out.disabled = zoom <= 1 || !track; into.disabled = zoom >= 8 || !track; fit.disabled = !track
    }
    const setZoom = (value: number) => { zoom = Math.max(1, Math.min(8, value)); paint() }
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      fingers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (fingers.size === 2) {
        const [a, b] = [...fingers.values()]
        pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y); dragging = undefined
      } else if (zoom > 1) dragging = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y }
      viewport.setPointerCapture(event.pointerId); event.preventDefault(); viewport.focus()
    })
    viewport.addEventListener('pointermove', event => {
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
    const stopDragging = (event: PointerEvent) => { fingers.delete(event.pointerId); dragging = undefined; pinchDistance = 0 }
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
    refresh()
    return () => { win.removeEventListener('pagehide', pageGone); window.clearInterval(timer); size.disconnect(); doc.removeEventListener('fullscreenchange', paint); video.pause(); video.srcObject = null }
  }
}
