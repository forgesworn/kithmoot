import type { ScreenAnnotation, AnnotationPoint } from '../../src/signal.js'
import { minimumSelection, moveSelection, resizeSelection, videoBox, WHOLE_PICTURE } from './share-area-geometry.js'

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
    return bridge.shareAreaMode === 'preview' ? this.#startPreview(bridge, popup) : this.#startFrame(bridge, popup)
  }

  async #startFrame(bridge: NonNullable<Window['kithmootDesktop']>, popup: Window): Promise<MediaStream> {
    const doc = popup.document
    doc.title = 'Sharing area'
    const style = doc.createElement('style')
    style.textContent = `
      html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;color:white;font:13px sans-serif}
      body{box-sizing:border-box;border:8px solid #4ecbff}
      header{height:44px;display:flex;align-items:center;gap:8px;padding:0 24px;background:#101114;-webkit-app-region:drag}
      button{padding:8px 12px;white-space:nowrap;-webkit-app-region:no-drag}
      header span{flex:1;min-width:70px;font-weight:bold;cursor:move}
      canvas{position:absolute;left:8px;top:52px;width:calc(100% - 16px);height:calc(100% - 92px);touch-action:none}
      footer{position:absolute;left:8px;right:8px;bottom:8px;height:32px;display:flex;align-items:center;justify-content:center;background:#101114;font-size:12px;padding:0 24px;white-space:nowrap;overflow:hidden}
      .resize{position:absolute;width:28px;height:28px;padding:0;border:0;background:#4ecbff;color:#101114;font-size:20px;touch-action:none}
      .nw{top:0;left:0;cursor:nwse-resize}.ne{top:0;right:0;cursor:nesw-resize}
      .sw{bottom:0;left:0;cursor:nesw-resize}.se{bottom:0;right:0;cursor:nwse-resize}
    `
    doc.head.append(style)
    const bar = doc.createElement('header')
    const label = doc.createElement('span')
    label.textContent = '⠿ Move'
    label.title = 'Drag this bar to move the sharing area'
    label.tabIndex = 0
    label.setAttribute('aria-label', 'Move sharing area with arrow keys')
    label.onkeydown = event => {
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
      if (!delta) return
      event.preventDefault()
      bridge.shareAreaAction('bounds', { x: popup.screenX + delta[0]!, y: popup.screenY + delta[1]!, width: popup.outerWidth, height: popup.outerHeight })
    }
    const draw = doc.createElement('button')
    draw.textContent = 'Draw'
    draw.setAttribute('aria-pressed', 'false')
    const owner = doc.createElement('button')
    owner.textContent = 'KithMoot'
    owner.title = 'Bring the KithMoot call window to the front'
    owner.setAttribute('aria-label', 'Show KithMoot')
    owner.onclick = () => bridge.shareAreaAction('owner')
    const stop = doc.createElement('button')
    stop.textContent = 'Cancel'
    const start = doc.createElement('button')
    start.textContent = 'Start sharing'
    start.disabled = true
    stop.onclick = () => { this.stop(); this.opts.ended() }
    bar.append(label, start, draw, owner, stop)
    const marks = doc.createElement('canvas')
    marks.setAttribute('aria-label', 'Draw on the sharing area')
    const status = doc.createElement('footer')
    status.textContent = 'Drag the bar to move · Drag a corner to resize'
    const handles = ['nw', 'ne', 'sw', 'se'].map(corner => {
      const handle = doc.createElement('button')
      handle.className = `resize ${corner}`
      handle.textContent = corner === 'nw' || corner === 'se' ? '⤢' : '⤡'
      const name = { nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' }[corner]
      handle.setAttribute('aria-label', `Resize sharing area from ${name}`)
      handle.title = `Drag to resize from ${name}; arrow keys also resize`
      return handle
    })
    doc.body.replaceChildren(bar, marks, status, ...handles)
    let drawing = false
    const pen = this.#pen(marks, () => drawing)
    draw.onclick = () => { pen.end(); drawing = !drawing; draw.setAttribute('aria-pressed', String(drawing)); bridge.shareAreaAction('passthrough', false) }
    doc.addEventListener('mousemove', event => {
      bridge.shareAreaAction('passthrough', !drawing && !resizing && event.target === marks)
    })
    let resizing: { screenX: number; screenY: number; x: number; y: number; width: number; height: number } | undefined
    const resizeFrom = (corner: string, bounds: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
      const west = corner.includes('w'), north = corner.includes('n')
      const width = Math.max(460, Math.min(8000, bounds.width + (west ? -dx : dx)))
      const height = Math.max(200, Math.min(8000, bounds.height + (north ? -dy : dy)))
      bridge.shareAreaAction('bounds', { x: bounds.x + (west ? bounds.width - width : 0), y: bounds.y + (north ? bounds.height - height : 0), width, height })
    }
    for (const handle of handles) {
      const corner = handle.classList[1]!
      handle.onpointerdown = event => {
        if (event.button !== 0) return
        bridge.shareAreaAction('passthrough', false)
        resizing = { screenX: event.screenX, screenY: event.screenY, x: popup.screenX, y: popup.screenY, width: popup.outerWidth, height: popup.outerHeight }
        handle.setPointerCapture(event.pointerId)
      }
      handle.onpointermove = event => {
        if (resizing && handle.hasPointerCapture(event.pointerId)) resizeFrom(corner, resizing, event.screenX - resizing.screenX, event.screenY - resizing.screenY)
      }
      handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = () => { resizing = undefined }
      handle.onkeydown = event => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
        if (!delta) return
        event.preventDefault()
        resizeFrom(corner, { x: popup.screenX, y: popup.screenY, width: popup.outerWidth, height: popup.outerHeight }, delta[0]!, delta[1]!)
      }
    }
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
          popup.navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints & { restrictOwnAudio: boolean } }).then(stream => {
            // Cancelling rejects the waiting promise immediately. A chooser
            // can still return afterwards, so dispose its tracks here before
            // resolving a promise whose caller may already have left.
            if (this.#cancelled || this.#popup !== popup || popup.closed) {
              stream.getTracks().forEach(track => track.stop())
              reject(new Error('Sharing cancelled.'))
              return
            }
            resolve(stream)
          }, reject)
        }
      })
      this.#rejectStart = undefined
      start.remove()
      stop.textContent = 'Stop sharing'
      if (this.#cancelled) { raw.getTracks().forEach(track => track.stop()); throw new Error('Sharing cancelled.') }
      this.#raw = raw
      this.#rect = await bridge.shareAreaState()
      if (!this.#rect) throw new Error('Keep the whole sharing frame on one monitor.')
      const crop = await this.#crop(popup, raw, () => this.#rect, rect => {
        status.textContent = rect ? 'Sharing inside this frame · Drag corners to resize' : 'Keep the frame on its original monitor'
      })
      video = crop.video; timer = crop.timer
      raw.getVideoTracks()[0]!.addEventListener('ended', () => { this.stop(); this.opts.ended() })
      return crop.stream
    } catch (error) { this.stop(); throw error }
  }

  /**
   * Wayland: the portal chooses the monitor and the person draws the
   * rectangle on a preview of it. Nothing is placed on the real screen.
   */
  async #startPreview(bridge: NonNullable<Window['kithmootDesktop']>, popup: Window): Promise<MediaStream> {
    const doc = popup.document
    doc.title = 'Share an area'
    const style = doc.createElement('style')
    style.textContent = `
      html,body{margin:0;width:100%;height:100%;background:#101114;color:white;font:13px sans-serif;overflow:hidden}
      body{display:flex;flex-direction:column}
      header{height:44px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px}
      header span{flex:1;min-width:70px;font-weight:bold}
      button{padding:8px 12px;white-space:nowrap}
      main{position:relative;flex:1;overflow:hidden;background:#000}
      main p{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;margin:0;color:#aaa}
      video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
      .selection{position:absolute;outline:3px solid #4ecbff;box-shadow:0 0 0 100vmax rgba(0,0,0,.55);cursor:move;touch-action:none}
      .selection:focus-visible{outline-color:white}
      .selection[hidden]{display:none}
      .selection.drawing{cursor:crosshair}
      .selection canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
      .selection.drawing .resize{display:none}
      .resize{position:absolute;width:28px;height:28px;padding:0;border:0;background:#4ecbff;color:#101114;font-size:20px;touch-action:none}
      .nw{top:0;left:0;cursor:nwse-resize}.ne{top:0;right:0;cursor:nesw-resize}
      .sw{bottom:0;left:0;cursor:nesw-resize}.se{bottom:0;right:0;cursor:nwse-resize}
      footer{height:32px;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;padding:0 12px;white-space:nowrap;overflow:hidden}
    `
    doc.head.append(style)
    const bar = doc.createElement('header')
    const label = doc.createElement('span')
    label.textContent = 'Share an area'
    const choose = doc.createElement('button')
    choose.textContent = 'Choose a screen'
    choose.disabled = true
    const share = doc.createElement('button')
    share.textContent = 'Share this area'
    share.disabled = true
    const draw = doc.createElement('button')
    draw.textContent = 'Draw'
    draw.setAttribute('aria-pressed', 'false')
    draw.disabled = true
    const owner = doc.createElement('button')
    owner.textContent = 'KithMoot'
    owner.title = 'Bring the KithMoot call window to the front'
    owner.setAttribute('aria-label', 'Show KithMoot')
    owner.onclick = () => bridge.shareAreaAction('owner')
    const stop = doc.createElement('button')
    stop.textContent = 'Cancel'
    stop.onclick = () => { this.stop(); this.opts.ended() }
    bar.append(label, choose, share, draw, owner, stop)
    const stage = doc.createElement('main')
    const empty = doc.createElement('p')
    empty.textContent = 'Choose a screen, then drag a box around what to share.'
    const preview = doc.createElement('video')
    preview.muted = true; preview.playsInline = true
    const selection = doc.createElement('div')
    selection.className = 'selection'
    selection.hidden = true
    selection.tabIndex = 0
    selection.setAttribute('aria-label', 'Shared area; arrow keys move it')
    const marks = doc.createElement('canvas')
    marks.setAttribute('aria-label', 'Draw on the shared area')
    const handles = (['nw', 'ne', 'sw', 'se'] as const).map(corner => {
      const handle = doc.createElement('button')
      handle.className = `resize ${corner}`
      handle.textContent = corner === 'nw' || corner === 'se' ? '⤢' : '⤡'
      const name = { nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' }[corner]
      handle.setAttribute('aria-label', `Resize shared area from ${name}`)
      handle.title = `Drag to resize from ${name}; arrow keys also resize`
      return { corner, handle }
    })
    selection.append(marks, ...handles.map(({ handle }) => handle))
    stage.append(empty, preview, selection)
    const status = doc.createElement('footer')
    status.textContent = 'Only the area inside the blue box is shared'
    doc.body.replaceChildren(bar, stage, status)

    this.#rect = { ...WHOLE_PICTURE }
    const picture = () => videoBox(stage.clientWidth, stage.clientHeight, preview.videoWidth, preview.videoHeight)
    const layout = () => {
      const box = picture()
      selection.hidden = !box
      if (!box || !this.#rect) return
      Object.assign(selection.style, {
        left: `${box.left + this.#rect.x * box.width}px`, top: `${box.top + this.#rect.y * box.height}px`,
        width: `${this.#rect.width * box.width}px`, height: `${this.#rect.height * box.height}px`,
      })
    }
    const select = (next: AreaRect) => { this.#rect = next; layout() }
    const minimum = () => minimumSelection(preview.videoWidth, preview.videoHeight)
    const layoutObserver = new ResizeObserver(layout)
    layoutObserver.observe(stage)
    preview.addEventListener('resize', layout)
    preview.addEventListener('loadedmetadata', layout)

    let drawing = false
    const pen = this.#pen(marks, () => drawing)
    draw.onclick = () => {
      pen.end(); drawing = !drawing
      draw.setAttribute('aria-pressed', String(drawing))
      selection.classList.toggle('drawing', drawing)
    }
    // Moving and resizing work in fractions of the picture, from where the
    // drag began, so the selection tracks the pointer exactly.
    let drag: { pointer: number; x: number; y: number; from: AreaRect; corner?: 'nw' | 'ne' | 'sw' | 'se' } | undefined
    const dragTo = (event: PointerEvent) => {
      const box = picture()
      if (!drag || drag.pointer !== event.pointerId || !box) return
      const dx = (event.clientX - drag.x) / box.width, dy = (event.clientY - drag.y) / box.height
      select(drag.corner ? resizeSelection(drag.from, drag.corner, dx, dy, minimum()) : moveSelection(drag.from, dx, dy))
    }
    const begin = (event: PointerEvent, element: HTMLElement, corner?: 'nw' | 'ne' | 'sw' | 'se') => {
      if (event.button !== 0 || !this.#rect) return
      event.preventDefault(); event.stopPropagation()
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: this.#rect, corner }
      element.setPointerCapture(event.pointerId)
    }
    const end = () => { drag = undefined }
    selection.onpointerdown = event => { if (!drawing) begin(event, selection) }
    selection.onpointermove = dragTo
    selection.onpointerup = selection.onpointercancel = end
    const step = (event: KeyboardEvent) => {
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
      const box = picture()
      if (!delta || !box || !this.#rect) return undefined
      event.preventDefault(); event.stopPropagation()
      return [delta[0]! / box.width, delta[1]! / box.height] as const
    }
    selection.onkeydown = event => { const d = step(event); if (d) select(moveSelection(this.#rect!, d[0], d[1])) }
    for (const { corner, handle } of handles) {
      handle.onpointerdown = event => begin(event, handle, corner)
      handle.onpointermove = dragTo
      handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = end
      handle.onkeydown = event => { const d = step(event); if (d) select(resizeSelection(this.#rect!, corner, d[0], d[1], minimum())) }
    }

    const gone = () => { this.stop(); this.opts.ended() }
    popup.addEventListener('pagehide', gone)
    const unsubMarks = this.opts.overlay(marks, () => this.#output?.id)
    let timer: ReturnType<typeof setInterval> | undefined
    let video: HTMLVideoElement | undefined
    this.#dispose = () => {
      popup.removeEventListener('pagehide', gone); layoutObserver.disconnect(); unsubMarks()
      if (timer) clearInterval(timer)
      if (video) { video.pause(); video.srcObject = null }
      preview.pause(); preview.srcObject = null
    }
    try {
      const raw = await new Promise<MediaStream>((resolve, reject) => {
        this.#rejectStart = reject
        const arm = async () => {
          if (!await bridge.armShareArea()) return reject(new Error('The sharing window is unavailable. Try again.'))
          if (this.#cancelled) return reject(new Error('Sharing cancelled.'))
          choose.disabled = false
        }
        choose.onclick = () => {
          choose.disabled = true
          // The portal is raised by this window's own user gesture.
          popup.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(stream => {
            if (this.#cancelled || this.#popup !== popup || popup.closed) {
              stream.getTracks().forEach(track => track.stop())
              reject(new Error('Sharing cancelled.'))
              return
            }
            resolve(stream)
          }, () => {
            // Dismissing the portal is not the end: arm again for another try.
            status.textContent = 'No screen was chosen'
            arm().catch(reject)
          })
        }
        arm().catch(reject)
      })
      this.#rejectStart = undefined
      if (this.#cancelled) { raw.getTracks().forEach(track => track.stop()); throw new Error('Sharing cancelled.') }
      this.#raw = raw
      // A monitor unplugged or a portal session revoked ends the track.
      raw.getVideoTracks()[0]!.addEventListener('ended', gone)
      choose.remove()
      empty.remove()
      preview.srcObject = new MediaStream(raw.getVideoTracks())
      await preview.play()
      layout()
      status.textContent = 'Drag the box or its corners · Only the area inside it is shared'
      await new Promise<void>((resolve, reject) => {
        this.#rejectStart = reject
        share.disabled = false
        share.onclick = () => resolve()
      })
      this.#rejectStart = undefined
      share.remove()
      draw.disabled = false
      stop.textContent = 'Stop sharing'
      const crop = await this.#crop(popup, raw, () => this.#rect, () => {})
      video = crop.video; timer = crop.timer
      status.textContent = 'Sharing the area inside the blue box · Move it at any time'
      return crop.stream
    } catch (error) { this.stop(); throw error }
  }

  /** Strokes on the marks canvas, normalised to what is shared. */
  #pen(marks: HTMLCanvasElement, drawing: () => boolean): { end: () => void } {
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
    marks.onpointerdown = event => {
      if (!drawing() || event.button !== 0) return
      event.stopPropagation()
      pointer = event.pointerId; points = [point(event)]; sent = 0
      marks.setPointerCapture(pointer)
    }
    marks.onpointermove = event => {
      if (pointer !== event.pointerId) return
      points.push(point(event))
      if (performance.now() - sent >= 50 || points.length >= 128) flush()
    }
    marks.onpointerup = marks.onpointercancel = () => { flush(); points = []; pointer = undefined }
    return { end: () => { flush(); points = [] } }
  }

  /** Publish a canvas crop of the raw monitor track, which itself stays local. */
  async #crop(popup: Window, raw: MediaStream, rect: () => AreaRect | null, painted: (rect: AreaRect | null) => void) {
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true
    video.srcObject = new MediaStream(raw.getVideoTracks())
    await video.play()
    if (this.#cancelled) throw new Error('Sharing cancelled.')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')!
    const paint = () => {
      if (popup.closed) { this.stop(); this.opts.ended(); return }
      const area = rect()
      // Invalid bounds (including crossing monitors) produce black, never
      // the whole display or an unclamped drawImage fallback.
      painted(area)
      if (!area || !video.videoWidth) { context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height); return }
      const width = Math.max(2, Math.round(area.width * video.videoWidth / 2) * 2)
      const height = Math.max(2, Math.round(area.height * video.videoHeight / 2) * 2)
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      context.drawImage(video, area.x * video.videoWidth, area.y * video.videoHeight, area.width * video.videoWidth, area.height * video.videoHeight, 0, 0, width, height)
    }
    paint()
    this.#output = canvas.captureStream(30).getVideoTracks()[0]!
    const timer = setInterval(paint, 33)
    return { video, timer, stream: new MediaStream([this.#output, ...raw.getAudioTracks()]) }
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
