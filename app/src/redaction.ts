import { EMPTY_STATE, FrameJump, HIDDEN_PLAN, JUMP_SAMPLE, RedactionTrail, coverCopy, cropPlan, planRedaction, refuseShare, type Rect, type RedactionPlan, type RedactionState } from './redaction-geometry.js'
import { coverFill } from './share-cover.js'

type Bridge = NonNullable<Window['kithmootDesktop']>
const BOX_URL = 'about:blank#kithmoot-redaction-box-'
/** How long a share waits for its first picture before starting without one. */
export const FIRST_PICTURE_MS = 3000
export const WAITING_COPY = 'Your share has no picture yet. If none comes, bring what you are sharing to the front.'

/** A share's watch for a picture that jumps: see `FrameJump`. */
export interface JumpWatch {
  /** Whether this frame jumped, or one did within the hold. */
  check(video: HTMLVideoElement, now: number): boolean
  reset(): void
}

/**
 * Samples the raw frame into a canvas the size of a thumbnail that never
 * leaves this page, and asks `FrameJump`. A frame that cannot be read is
 * treated as one that jumped: the cover goes on, never off, when in doubt.
 */
export function watchForJumps(): JumpWatch {
  const canvas = document.createElement('canvas')
  canvas.width = JUMP_SAMPLE.width; canvas.height = JUMP_SAMPLE.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const jump = new FrameJump()
  return {
    check(video, now) {
      if (!context) return true
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        const sample = new Uint8Array(canvas.width * canvas.height)
        for (let i = 0; i < sample.length; i++) sample[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000
        return jump.next(sample, now)
      } catch {
        return true
      }
    },
    reset() { jump.reset() },
  }
}

/** The cover over every rectangle the plan names, or over everything. */
export function paintPlan(context: CanvasRenderingContext2D, plan: RedactionPlan, width: number, height: number): void {
  if (plan.mode === 'pass') return
  context.fillStyle = coverFill(context)
  if (plan.mode === 'cover') context.fillRect(0, 0, width, height)
  else for (const rect of plan.rects) context.fillRect(rect.x, rect.y, rect.width, rect.height)
}

/**
 * Redaction boxes in the desktop app: see-through windows on the real
 * screen, each drawn here and placed by the main process, whose areas are
 * covered in every outgoing screen or area share (`redact` below and
 * `DesktopShareArea`). The same canvas hides a whole share on purpose.
 * Nothing here exists in a browser tab.
 */
export class DesktopRedaction {
  #state: RedactionState = EMPTY_STATE
  #popups = new Map<string, { popup: Window; render: () => void }>()
  #listeners = new Set<() => void>()
  #paints = new Set<() => void>()
  #hidden = false
  #count = 0

  constructor(private readonly bridge: Bridge | undefined) {
    if (!this.supported) return
    bridge!.onRedactionState!(state => this.#set(state))
    void this.refresh()
  }

  get supported(): boolean { return Boolean(this.bridge?.supportsRedaction && this.bridge.redactionState) }
  get state(): RedactionState { return this.#state }
  get count(): number { return this.#state.boxes.length }
  anyOn(): boolean { return this.#state.boxes.some(box => box.on) }
  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  /** A share hidden on purpose: every picture going out is wholly covered until it is shown again. */
  get hidden(): boolean { return this.#hidden }
  setHidden(hidden: boolean): void {
    if (this.#hidden === hidden) return
    this.#hidden = hidden
    // Painted now, not at the next tick: nothing more of the picture goes
    // out once hiding is asked for, and nothing at all before the plan says so.
    for (const paint of this.#paints) paint()
    for (const listener of this.#listeners) listener()
  }
  /** A share's paint loop, run the moment the share is hidden or shown. */
  onPaint(paint: () => void): () => void { this.#paints.add(paint); return () => this.#paints.delete(paint) }

  #set(state: RedactionState | null): void {
    this.#state = state ?? EMPTY_STATE
    for (const [id, { popup, render }] of this.#popups) {
      if (popup.closed || !this.#state.boxes.some(box => box.id === id)) { if (popup.closed) this.#popups.delete(id); continue }
      render()
    }
    for (const listener of this.#listeners) listener()
  }

  async refresh(): Promise<RedactionState> {
    if (this.supported) this.#set(await this.bridge!.redactionState!())
    return this.#state
  }

  /** Forget the last share's source before a new one is chosen. */
  async begin(): Promise<void> {
    if (this.supported) this.#set(await this.bridge!.redactionBegin!())
  }

  setAll(on: boolean): void { this.bridge?.redactionAction?.(null, 'all', on) }
  closeAll(): void {
    this.bridge?.redactionAction?.(null, 'close-all')
    for (const { popup } of this.#popups.values()) popup.close()
    this.#popups.clear()
  }

  /** Opens a new box; the main process places it near the cursor's display centre. */
  add(): void {
    if (!this.supported) return
    const id = `${Date.now().toString(36)}-${(this.#count++).toString(36)}`
    const popup = window.open(`${BOX_URL}${id}`, '_blank', 'popup,width=360,height=220')
    if (!popup) throw new Error('The redaction box could not be opened.')
    this.#popups.set(id, { popup, render: this.#build(popup, id) })
    popup.addEventListener('pagehide', () => this.#popups.delete(id))
  }

  #build(popup: Window, id: string): () => void {
    const bridge = this.bridge!
    const act = (action: string, value?: unknown) => bridge.redactionAction!(id, action, value)
    const doc = popup.document
    doc.title = 'Hidden from share'
    const style = doc.createElement('style')
    // A dashed yellow and black edge reads on any background; the middle is
    // left clear so the person sharing still sees what is underneath.
    style.textContent = `
      html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden;font:12px sans-serif;color:#fff}
      body{box-sizing:border-box;border:3px dashed #ffd21f;outline:1px solid #000;outline-offset:-4px;box-shadow:inset 0 0 0 1px #000}
      body.off{border-color:#9aa0a6;border-style:dotted}
      header{position:absolute;left:0;right:0;top:0;height:30px;display:flex;align-items:center;gap:6px;padding:0 18px;box-sizing:border-box;background:#111c;cursor:move;touch-action:none}
      body.off header{background:#1118}
      header span{flex:1;min-width:28px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:bold}
      header span:focus-visible{outline:2px solid #ffd21f}
      button{padding:3px 8px;font:inherit;white-space:nowrap;cursor:default}
      .grip{position:absolute;width:18px;height:18px;padding:0;border:0;background:#ffd21f;touch-action:none}
      body.off .grip{background:#9aa0a6}
      .nw{top:0;left:0;cursor:nwse-resize}.ne{top:0;right:0;cursor:nesw-resize}
      .sw{bottom:0;left:0;cursor:nesw-resize}.se{bottom:0;right:0;cursor:nwse-resize}
    `
    doc.head.append(style)
    const bar = doc.createElement('header')
    const label = doc.createElement('span')
    label.tabIndex = 0
    label.title = 'Drag to move; arrow keys also move'
    const toggle = doc.createElement('button')
    const close = doc.createElement('button')
    close.textContent = '✕'
    close.setAttribute('aria-label', 'Remove this box')
    close.title = 'Remove this box'
    toggle.onclick = () => act('toggle')
    close.onclick = () => act('close')
    bar.append(label, toggle, close)
    const step = (event: KeyboardEvent) => {
      const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
      if (delta) event.preventDefault()
      return delta
    }
    label.onkeydown = event => { const d = step(event); if (d) act('nudge', { dx: d[0], dy: d[1] }) }
    // Moving and resizing follow the real cursor in the main process; the
    // page only says when a drag starts, continues and ends.
    const drag = (element: HTMLElement, start: () => void) => {
      element.onpointerdown = event => {
        if (event.button !== 0 || (element === bar && (event.target as Element).closest('button'))) return
        event.preventDefault()
        start()
        element.setPointerCapture(event.pointerId)
      }
      element.onpointermove = event => { if (element.hasPointerCapture(event.pointerId)) act('drag') }
      element.onpointerup = element.onpointercancel = element.onlostpointercapture = () => act('drag-end')
    }
    drag(bar, () => act('move-start'))
    const grips = (['nw', 'ne', 'sw', 'se'] as const).map(corner => {
      const grip = doc.createElement('button')
      grip.className = `grip ${corner}`
      const name = { nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' }[corner]
      grip.setAttribute('aria-label', `Resize box from ${name}`)
      grip.title = `Drag to resize from ${name}; arrow keys also resize`
      drag(grip, () => act('resize-start', corner))
      grip.onkeydown = event => { const d = step(event); if (d) act('nudge', { dx: d[0], dy: d[1], corner }) }
      return grip
    })
    doc.body.replaceChildren(bar, ...grips)
    const render = () => {
      const on = this.#state.boxes.find(box => box.id === id)?.on ?? true
      doc.body.classList.toggle('off', !on)
      label.textContent = on ? '⠿ Hidden from share' : '⠿ Shown'
      label.setAttribute('aria-label', on ? 'Hidden from share. Arrow keys move this box' : 'Shown in share. Arrow keys move this box')
      toggle.textContent = on ? 'Show' : 'Hide'
      toggle.title = on ? 'Let people see this part of the screen' : 'Black out this part of the screen again'
      toggle.setAttribute('aria-pressed', String(on))
    }
    render()
    return render
  }

  /**
   * A whole-screen or window share, routed through a canvas that covers
   * every active box, or all of it while hidden, before the picture is
   * published. The raw capture never leaves
   * this page: only the canvas track goes to the call, always, so a box can
   * appear mid-share without swapping tracks and no raw frame slips out.
   */
  async redact(raw: MediaStream, report: (note: string | undefined) => void): Promise<MediaStream> {
    const source = raw.getVideoTracks()[0]
    if (!source) return raw
    const surface = source.getSettings().displaySurface
    const refusal = refuseShare(await this.refresh(), surface)
    if (refusal) throw new Error(refusal)
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true
    video.srcObject = new MediaStream([source])
    // A window that sends no picture (one that has gone, or sits where macOS
    // does not draw it) never starts playing, and waiting on it left the
    // share neither started nor refused. Start without a picture instead:
    // the canvas stays covered until one arrives.
    const playing = video.play()
    playing.catch(() => {})
    const began = await Promise.race([playing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), FIRST_PICTURE_MS))])
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, video.videoWidth || 2); canvas.height = Math.max(2, video.videoHeight || 2)
    const context = canvas.getContext('2d')!
    const trail = new RedactionTrail()
    const jumps = watchForJumps()
    let note: string | undefined
    if (!began) { note = WAITING_COPY; report(note) }
    const paint = () => {
      const width = video.videoWidth, height = video.videoHeight
      // The trail is kept up even while hidden, so a box that moved in the
      // meantime is still held when the share is shown again.
      const held = trail.next(this.#state.boxes, performance.now())
      // A desktop sliding in under a box is caught here, from the frame
      // itself, before any of it is drawn. See `FrameJump`.
      const moving = held.length > 0 && width > 0 && height > 0 && jumps.check(video, performance.now())
      if (held.length === 0) jumps.reset()
      // The plan comes first: when it covers everything the raw frame is never drawn.
      const plan: RedactionPlan = this.#hidden ? HIDDEN_PLAN
        : !(width && height) ? { mode: 'cover', reason: 'geometry' }
        : moving ? { mode: 'cover', reason: 'moving' }
        : planRedaction(this.#state, { width, height }, held, surface)
      if (width && height && (canvas.width !== width || canvas.height !== height)) { canvas.width = width; canvas.height = height }
      if (plan.mode !== 'cover') context.drawImage(video, 0, 0, canvas.width, canvas.height)
      paintPlan(context, plan, canvas.width, canvas.height)
      const next = plan.mode === 'cover' && (video.videoWidth || plan.reason === 'hidden') ? coverCopy(plan.reason) : !began && !video.videoWidth ? WAITING_COPY : undefined
      if (next !== note) { note = next; report(note) }
    }
    paint()
    const unpaint = this.onPaint(paint)
    const output = canvas.captureStream(30).getVideoTracks()[0]!
    const timer = setInterval(paint, 33)
    let stopped = false
    const stopOutput = output.stop.bind(output)
    const finish = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      unpaint()
      video.pause(); video.srcObject = null
      source.stop()
      stopOutput()
      if (note) report(undefined)
    }
    output.stop = finish
    // The capture ending on its own (a monitor unplugged, the OS revoking
    // it) ends the share the call sees, the same as the raw track would.
    source.addEventListener('ended', () => { if (!stopped) { finish(); output.dispatchEvent(new Event('ended')) } })
    return new MediaStream([output, ...raw.getAudioTracks()])
  }

  /**
   * One frame of an area share: the plan for the monitor under the frame,
   * carried into the crop. `crop` is in fractions of the frame.
   */
  areaPlan(trail: RedactionTrail, frame: { width: number; height: number }, crop: Rect, output: { width: number; height: number },
    moving?: { video: HTMLVideoElement; jumps: JumpWatch }): RedactionPlan {
    const held = trail.next(this.#state.boxes, performance.now())
    // Sampled even while hidden, so the comparison is current when shown again.
    const jumped = held.length > 0 && moving !== undefined && moving.jumps.check(moving.video, performance.now())
    if (held.length === 0) moving?.jumps.reset()
    if (this.#hidden) return HIDDEN_PLAN
    if (jumped) return { mode: 'cover', reason: 'moving' }
    const plan = planRedaction(this.#state, frame, held)
    return cropPlan(plan, { x: crop.x * frame.width, y: crop.y * frame.height, width: crop.width * frame.width, height: crop.height * frame.height }, output)
  }
}
