import {
  BLUR_ON_BY_DEFAULT,
  DEFAULT_BLUR_STRENGTH,
  VideoEffect,
  type EffectMode,
  type FrameAction,
  type VideoEffectState,
} from '../../src/video-effects.js'
import { createSegmenter } from './mediapipe-segmenter.js'

/**
 * The camera, with the effect wired into it.
 *
 * ## Why the canvas, not `MediaStreamTrackProcessor`
 *
 * `MediaStreamTrackProcessor` and `MediaStreamTrackGenerator` are the tidy
 * way to do this and they exist in Chrome and Edge and nowhere else. Safari
 * and Firefox have neither. So: a hidden `<video>` playing the camera, a
 * frame callback, a `<canvas>`, and `captureStream()` off the canvas. That
 * works in every browser this app claims to run in, which is the whole list
 * in the README's platform table.
 *
 * ## The published track never changes
 *
 * `start()` returns the *canvas* track, and every later change - blur on,
 * blur off, camera flip, a different device - swaps only what is feeding the
 * hidden video element. The track the mesh published stays the same object
 * for the life of the camera.
 *
 * That is not a tidiness point. Replacing a published track means
 * renegotiation, and renegotiation during a camera flip is exactly the
 * window where an unblurred frame gets out. Here there is no window: the
 * effect is told the source is changing before it changes, and from that
 * instant every frame it draws is blurred whole until the new camera has
 * produced a mask of its own.
 *
 * The cost is one texture blit per frame even with the effect off. That is
 * cheap, and it buys a toggle that never renegotiates.
 */

/** The canvas emits a frame whenever it is drawn to, and it is drawn to once
 *  per decoded camera frame, so this is a ceiling rather than a rate. */
const CAPTURE_FPS = 30

/**
 * How long the loop will go without a frame callback before drawing anyway.
 *
 * `requestAnimationFrame` stops in a background tab, and a background tab
 * that stops publishing video looks to everyone else like the person left.
 * This is the floor under that: about ten frames a second, enough to keep
 * the track alive.
 */
const WATCHDOG_INTERVAL_MS = 100

export interface BackgroundChoice {
  id: string
  label: string
  url: string
}

/** Abstract rather than photographic on purpose. A stock photograph of
 *  somebody's office is a picture of a real place, and the point of this
 *  feature is to stop publishing pictures of real places. */
export const BACKGROUNDS: BackgroundChoice[] = [
  { id: 'slate', label: 'Slate', url: 'backgrounds/slate.svg' },
  { id: 'ember', label: 'Ember', url: 'backgrounds/ember.svg' },
  { id: 'fen', label: 'Fen', url: 'backgrounds/fen.svg' },
]

export interface CameraPipelineOptions {
  onStateChange?: (state: VideoEffectState) => void
  /** The camera device went away: unplugged, or taken by something else.
   *  Reported on the *source* track rather than the published one, because
   *  the published one is a canvas and knows nothing about it. */
  onSourceEnded?: () => void
}

export interface CameraStats {
  /** Frames drawn per second, measured over the last second. */
  fps: number
  /** How many of the last second's frames took each route. `passthrough`
   *  above zero while the mode is not `off` is a bug, and the counter exists
   *  so it can be seen rather than argued about. */
  actions: Record<FrameAction, number>
  /** Mean milliseconds spent inside `renderFrame`, segmentation included. */
  frameCostMs: number
}

type FrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export class CameraPipeline {
  readonly #video: HTMLVideoElement
  readonly #canvas: HTMLCanvasElement
  readonly #effect: VideoEffect
  readonly #onStateChange?: (state: VideoEffectState) => void
  readonly #onSourceEnded?: () => void

  #stream: MediaStream | null = null
  #outputStream: MediaStream | null = null
  #running = false
  #rafHandle = 0
  #vfcHandle = 0
  #watchdog: ReturnType<typeof setInterval> | null = null
  #lastDrawAt = 0
  #deviceId: string | undefined
  #facingMode: 'user' | 'environment' = 'user'

  #counters: Record<FrameAction, number> = { passthrough: 0, 'blur-all': 0, composite: 0 }
  #window: Record<FrameAction, number> = { passthrough: 0, 'blur-all': 0, composite: 0 }
  #windowStartedAt = 0
  #fps = 0
  #costTotalMs = 0
  #costFrames = 0
  #frameCostMs = 0

  constructor(opts: CameraPipelineOptions = {}) {
    this.#onStateChange = opts.onStateChange
    this.#onSourceEnded = opts.onSourceEnded

    this.#video = document.createElement('video')
    this.#video.muted = true
    this.#video.playsInline = true
    this.#video.autoplay = true

    this.#canvas = document.createElement('canvas')
    this.#canvas.width = 640
    this.#canvas.height = 480

    this.#effect = new VideoEffect({
      output: this.#canvas,
      createCanvas: (width, height) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas
      },
      loadSegmenter: () =>
        createSegmenter({
          wasmPath: `${import.meta.env.BASE_URL}mediapipe`,
          modelPath: `${import.meta.env.BASE_URL}models/selfie_segmenter.tflite`,
        }),
      mode: BLUR_ON_BY_DEFAULT ? 'blur' : 'off',
      strength: DEFAULT_BLUR_STRENGTH,
      onStateChange: (state) => this.#onStateChange?.(state),
    })
  }

  get mode(): EffectMode {
    return this.#effect.mode
  }

  get strength(): number {
    return this.#effect.strength
  }

  get status(): VideoEffectState {
    return {
      status: this.#effect.status,
      mode: this.#effect.mode,
      strength: this.#effect.strength,
      error: this.#effect.lastError,
    }
  }

  get track(): MediaStreamTrack | undefined {
    return this.#outputStream?.getVideoTracks()[0]
  }

  /** Which camera is feeding the pipeline right now, so a caller cycling
   *  through devices knows where it is in the list. */
  get deviceId(): string | undefined {
    return this.#deviceId
  }

  /** The raw camera track, for reading its settings. Never published. */
  get sourceTrack(): MediaStreamTrack | undefined {
    return this.#stream?.getVideoTracks()[0]
  }

  get stats(): CameraStats {
    return { fps: this.#fps, actions: { ...this.#window }, frameCostMs: this.#frameCostMs }
  }

  /** Every route taken since the pipeline started, which is what a test
   *  asserts on: `passthrough` must be zero across a flip with blur on. */
  get totals(): Record<FrameAction, number> {
    return { ...this.#counters }
  }

  /** Start the camera and return the track to publish. Idempotent enough to
   *  call twice; the second call returns the same track. */
  async start(): Promise<MediaStreamTrack> {
    if (this.#outputStream) {
      const existing = this.#outputStream.getVideoTracks()[0]
      if (existing) return existing
    }
    await this.#openCamera({ facingMode: this.#facingMode })

    this.#outputStream = this.#canvas.captureStream(CAPTURE_FPS)
    const track = this.#outputStream.getVideoTracks()[0]
    if (!track) throw new Error('this browser will not capture a stream from a canvas')
    this.#running = true
    this.#windowStartedAt = performance.now()
    this.#schedule()
    this.#watchdog = setInterval(() => {
      if (!this.#running) return
      if (performance.now() - this.#lastDrawAt > WATCHDOG_INTERVAL_MS) this.#draw()
    }, WATCHDOG_INTERVAL_MS)
    return track
  }

  /**
   * Swap to a different camera without dropping the effect.
   *
   * The order matters and is the point of the whole class: the effect is
   * told first, so from this line onwards every frame it draws is blurred
   * whole, whatever the video element happens to be showing. Only then is
   * the old camera stopped and the new one opened.
   */
  async useCamera(opts: { deviceId?: string; facingMode?: 'user' | 'environment' }): Promise<void> {
    this.#effect.invalidateSource()
    if (opts.facingMode) this.#facingMode = opts.facingMode
    this.#deviceId = opts.deviceId
    const constraints: MediaTrackConstraints = opts.deviceId
      ? { deviceId: { exact: opts.deviceId } }
      : { facingMode: this.#facingMode }
    const previous = this.#stream
    try {
      await this.#openCamera(constraints)
    } finally {
      // Stopped after the new one is open, so a failure to open the new
      // camera leaves the old one running rather than leaving the room
      // looking at nothing.
      if (previous && previous !== this.#stream) for (const t of previous.getTracks()) t.stop()
    }
  }

  /** Flip between the front and back camera on a phone. */
  async flip(): Promise<void> {
    await this.useCamera({ facingMode: this.#facingMode === 'user' ? 'environment' : 'user' })
  }

  setMode(mode: EffectMode): void {
    this.#effect.setMode(mode)
  }

  setStrength(strength: number): void {
    this.#effect.setStrength(strength)
  }

  /** Load a bundled background. Failure leaves the previous one in place and
   *  the mode falls back to blurring, never to showing the room. */
  async setBackground(choice: BackgroundChoice | null): Promise<void> {
    if (!choice) {
      this.#effect.setBackground(null)
      return
    }
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error(`could not load the ${choice.label} background`))
      image.src = `${import.meta.env.BASE_URL}${choice.url}`
    })
    this.#effect.setBackground(image, { width: image.naturalWidth, height: image.naturalHeight })
  }

  stop(): void {
    this.#running = false
    if (this.#watchdog) clearInterval(this.#watchdog)
    this.#watchdog = null
    this.#cancelSchedule()
    this.#effect.close()
    for (const t of this.#stream?.getTracks() ?? []) t.stop()
    for (const t of this.#outputStream?.getTracks() ?? []) t.stop()
    this.#stream = null
    this.#outputStream = null
    this.#video.srcObject = null
  }

  /** Resolves once the segmenter has loaded or failed, for a UI that wants
   *  to wait before claiming anything. */
  ready(): Promise<void> {
    return this.#effect.ready()
  }

  // -- internals ------------------------------------------------------------

  async #openCamera(video: MediaTrackConstraints): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ video })
    this.#stream = stream
    this.#video.srcObject = stream
    const track = stream.getVideoTracks()[0]
    const settings = track?.getSettings()
    if (settings?.deviceId) this.#deviceId = settings.deviceId
    track?.addEventListener('ended', () => {
      // Only if it is still the live one: a flip ends the old track on
      // purpose and that is not the camera going away.
      if (this.#stream === stream) this.#onSourceEnded?.()
    })
    try {
      await this.#video.play()
    } catch {
      // Autoplay refusal on a muted, inline video is rare and not fatal: the
      // frame callback simply does not fire until the element is playing.
    }
  }

  #schedule(): void {
    if (!this.#running) return
    const host = this.#video as FrameCallbackHost
    if (host.requestVideoFrameCallback) {
      // Per decoded camera frame, which is the right clock: it neither
      // over-runs a 15fps webcam nor under-runs a 60fps one.
      this.#vfcHandle = host.requestVideoFrameCallback(() => {
        this.#draw()
        this.#schedule()
      })
      return
    }
    // Firefox until recently, and anything older. A repaint clock is close
    // enough and the watchdog covers a background tab.
    this.#rafHandle = requestAnimationFrame(() => {
      this.#draw()
      this.#schedule()
    })
  }

  #cancelSchedule(): void {
    const host = this.#video as FrameCallbackHost
    if (this.#vfcHandle && host.cancelVideoFrameCallback) host.cancelVideoFrameCallback(this.#vfcHandle)
    if (this.#rafHandle) cancelAnimationFrame(this.#rafHandle)
    this.#vfcHandle = 0
    this.#rafHandle = 0
  }

  #draw(): void {
    if (!this.#running) return
    const width = this.#video.videoWidth
    const height = this.#video.videoHeight
    if (width === 0 || height === 0) return

    const startedAt = performance.now()
    const action = this.#effect.renderFrame(this.#video, width, height, startedAt)
    const cost = performance.now() - startedAt

    this.#lastDrawAt = startedAt
    this.#counters[action] += 1
    this.#window[action] += 1
    this.#costTotalMs += cost
    this.#costFrames += 1

    const elapsed = startedAt - this.#windowStartedAt
    if (elapsed >= 1000) {
      const frames = this.#window.passthrough + this.#window['blur-all'] + this.#window.composite
      this.#fps = Math.round((frames / elapsed) * 1000)
      this.#frameCostMs = this.#costFrames ? this.#costTotalMs / this.#costFrames : 0
      this.#window = { passthrough: 0, 'blur-all': 0, composite: 0 }
      this.#costTotalMs = 0
      this.#costFrames = 0
      this.#windowStartedAt = startedAt
    }
  }
}
