import type { ScreenAnnotation, AnnotationPoint } from '../../src/signal.js'

export interface AreaRect { x: number; y: number; width: number; height: number }

/** The raw monitor track stays local. Only the canvas crop is published. */
export class DesktopShareArea {
  #popup?: Window
  #raw?: MediaStream
  #output?: MediaStreamTrack
  #dispose?: () => void
  #rect: AreaRect | null = null
  #cancelled = false
  #rejectStart?: (error: Error) => void

  constructor(private readonly opts: {
    overlay: (canvas: HTMLCanvasElement, id: () => string | undefined) => () => void
    draw: (annotation: ScreenAnnotation) => void
    ended: () => void
  }) {}

  async start(): Promise<MediaStream> {
    const bridge = window.kithmootDesktop
    if (!bridge) throw new Error('Sharing an area requires the desktop app.')
    this.#cancelled = false
    const popup = window.open('about:blank#kithmoot-share-area', '_blank', 'popup,width=900,height=600')
    if (!popup) throw new Error('The sharing frame could not be opened.')
    this.#popup = popup
    const doc = popup.document
    doc.title = 'Sharing area'
    const style = doc.createElement('style')
    style.textContent = `html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;color:white;font:13px sans-serif}body{box-sizing:border-box;border:6px solid #4ecbff}header{height:36px;display:flex;align-items:center;gap:8px;padding-right:24px;background:#101114;-webkit-app-region:drag}button{padding:4px 10px;-webkit-app-region:no-drag}header span{flex:1}canvas{position:absolute;left:6px;top:42px;width:calc(100% - 12px);height:calc(100% - 48px);touch-action:none}#resize{position:absolute;top:6px;right:6px;width:22px;height:36px;cursor:nwse-resize;background:#4ecbff}`
    doc.head.append(style)
    const bar = doc.createElement('header')
    const label = doc.createElement('span')
    label.textContent = 'Drag this bar to move the sharing area'
    const draw = doc.createElement('button')
    draw.textContent = 'Draw'
    draw.setAttribute('aria-pressed', 'false')
    const stop = doc.createElement('button')
    stop.textContent = 'Cancel'
    const start = doc.createElement('button')
    start.textContent = 'Start sharing'
    start.disabled = true
    stop.onclick = () => { this.stop(); this.opts.ended() }
    bar.append(label, start, draw, stop)
    const marks = doc.createElement('canvas')
    marks.setAttribute('aria-label', 'Draw on the sharing area')
    const resize = doc.createElement('div')
    resize.id = 'resize'
    resize.title = 'Drag to resize the sharing area'
    doc.body.replaceChildren(bar, marks, resize)
    let drawing = false
    let pointer: number | undefined
    let points: AnnotationPoint[] = []
    let sent = 0
    const flush = () => {
      if (points.length < 2 || !this.#output) return
      this.opts.draw({ op: 'stroke', shareId: this.#output.id, strokeId: crypto.randomUUID(), points: [...points] })
      points = [points.at(-1)!]
      sent = performance.now()
    }
    const point = (event: PointerEvent) => {
      const rect = marks.getBoundingClientRect()
      return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
    }
    draw.onclick = () => { flush(); points = []; drawing = !drawing; draw.setAttribute('aria-pressed', String(drawing)); bridge.shareAreaAction('passthrough', false) }
    doc.addEventListener('mousemove', event => {
      bridge.shareAreaAction('passthrough', !drawing && event.target === marks)
    })
    marks.onpointerdown = event => {
      if (!drawing || event.button !== 0) return
      pointer = event.pointerId; points = [point(event)]; sent = 0
      marks.setPointerCapture(pointer)
    }
    marks.onpointermove = event => {
      if (pointer !== event.pointerId) return
      points.push(point(event))
      if (performance.now() - sent >= 50 || points.length >= 128) flush()
    }
    marks.onpointerup = marks.onpointercancel = () => { flush(); points = []; pointer = undefined }
    let resizing: { x: number; y: number; width: number; height: number } | undefined
    resize.onpointerdown = event => {
      resizing = { x: event.screenX, y: event.screenY, width: popup.innerWidth, height: popup.innerHeight }
      resize.setPointerCapture(event.pointerId)
    }
    resize.onpointermove = event => {
      if (resizing) bridge.shareAreaAction('resize', { width: resizing.width + event.screenX - resizing.x, height: resizing.height + event.screenY - resizing.y })
    }
    resize.onpointerup = resize.onpointercancel = () => { resizing = undefined }
    const gone = () => { this.stop(); this.opts.ended() }
    popup.addEventListener('pagehide', gone)
    const unsubState = bridge.onShareAreaState(rect => { this.#rect = rect })
    const unsubMarks = this.opts.overlay(marks, () => this.#output?.id)
    let timer: ReturnType<typeof setInterval> | undefined
    let video: HTMLVideoElement | undefined
    this.#dispose = () => { popup.removeEventListener('pagehide', gone); unsubState(); unsubMarks(); if (timer) clearInterval(timer); if (video) { video.pause(); video.srcObject = null } }
    try {
      if (!await bridge.armShareArea()) throw new Error('The sharing frame is unavailable. Try again.')
      if (this.#cancelled) throw new Error('Sharing cancelled.')
      const raw = await new Promise<MediaStream>((resolve, reject) => {
        this.#rejectStart = reject
        start.disabled = false
        start.onclick = () => {
          start.disabled = true
          // Capture is requested by the focused frame's own user gesture.
          popup.navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints & { restrictOwnAudio: boolean } }).then(resolve, reject)
        }
      })
      this.#rejectStart = undefined
      start.remove()
      stop.textContent = 'Stop sharing'
      if (this.#cancelled) { raw.getTracks().forEach(track => track.stop()); throw new Error('Sharing cancelled.') }
      this.#raw = raw
      this.#rect = await bridge.shareAreaState()
      if (!this.#rect) throw new Error('Keep the whole sharing frame on one monitor.')
      video = document.createElement('video')
      video.muted = true; video.playsInline = true
      video.srcObject = new MediaStream(raw.getVideoTracks())
      await video.play()
      if (this.#cancelled) throw new Error('Sharing cancelled.')
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')!
      const paint = () => {
        if (popup.closed) { this.stop(); this.opts.ended(); return }
        const rect = this.#rect
        // Invalid bounds (including crossing monitors) produce black, never
        // the whole display or an unclamped drawImage fallback.
        label.textContent = rect ? 'Sharing inside this frame' : 'Keep the frame on its original monitor'
        if (!rect || !video!.videoWidth) { context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height); return }
        const width = Math.max(2, Math.round(rect.width * video!.videoWidth / 2) * 2)
        const height = Math.max(2, Math.round(rect.height * video!.videoHeight / 2) * 2)
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        context.drawImage(video!, rect.x * video!.videoWidth, rect.y * video!.videoHeight, rect.width * video!.videoWidth, rect.height * video!.videoHeight, 0, 0, width, height)
      }
      paint()
      this.#output = canvas.captureStream(30).getVideoTracks()[0]!
      raw.getVideoTracks()[0]!.addEventListener('ended', () => { this.stop(); this.opts.ended() })
      timer = setInterval(paint, 33)
      return new MediaStream([this.#output, ...raw.getAudioTracks()])
    } catch (error) { this.stop(); throw error }
  }

  stop(): void {
    this.#cancelled = true
    this.#rejectStart?.(new Error('Sharing cancelled.')); this.#rejectStart = undefined
    this.#dispose?.(); this.#dispose = undefined
    this.#raw?.getTracks().forEach(track => track.stop()); this.#raw = undefined
    this.#output?.stop(); this.#output = undefined
    this.#popup?.close(); this.#popup = undefined
    this.#rect = null
    window.kithmootDesktop?.shareAreaAction('close')
  }
}
