/**
 * Background blur and replacement for the outgoing camera track.
 *
 * ## Why this exists
 *
 * On 25 August 2026 a set of real-device screenshots published the owner's
 * living room, because the camera was on and the room was behind him. A tool
 * whose pitch is "no operator can see you" should not also require you to
 * tidy up first. This module is the part of that answer which can be tested
 * without a browser.
 *
 * ## Where it sits in the pipeline
 *
 * This is a **capture-stage** transform: camera frame in, composited frame
 * out, before anything is encoded. It is not `media-crypto.ts`, which
 * transforms *encoded* frames on their way to a forwarder. The two are
 * independent and compose in that order: blur, then encode, then encrypt.
 * Nothing here touches an `RTCRtpSender`.
 *
 * ## What it does not do
 *
 * Segmentation is a guess. It is worst at the hair line, at held objects, in
 * low light and under fast movement, and every one of those failures shows
 * up as a piece of the real room being published for a frame or two. This is
 * a way to make a room *less* legible, not a guarantee that it is invisible,
 * and the UI says so in those words.
 *
 * ## The one rule
 *
 * While an effect is meant to be on and the segmenter is working, an
 * unmodified camera frame must never reach the output canvas - not while the
 * model is loading, and above all not during a camera flip, which is the
 * moment the naive implementation leaks. `decideFrameAction` is that rule
 * written down, and it has only one way to say "passthrough": the user
 * turned the effect off, or it broke and they were told.
 */

// ---------------------------------------------------------------------------
// Injected surfaces
//
// The same trick `peer.ts` plays with `PeerFactory`: name the small subset of
// the platform that is actually touched, so a real `OffscreenCanvas` fits
// structurally with no adapter and a test can hand over an object that only
// records what it was asked to draw.
// ---------------------------------------------------------------------------

/** Anything a 2D context will accept as an image. Deliberately `unknown`:
 *  this module never inspects a frame, it only passes it to `drawImage`. */
export type FrameSourceLike = unknown

export interface ImageDataLike {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

export interface Context2DLike {
  filter: string
  globalCompositeOperation: string
  imageSmoothingEnabled: boolean
  imageSmoothingQuality?: string
  clearRect(x: number, y: number, w: number, h: number): void
  drawImage(image: FrameSourceLike, dx: number, dy: number, dw: number, dh: number): void
  putImageData(image: ImageDataLike, dx: number, dy: number): void
  createImageData(width: number, height: number): ImageDataLike
}

export interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Context2DLike | null
}

export interface CanvasFactory {
  (width: number, height: number): CanvasLike
}

/**
 * One frame's worth of "how sure are we that this pixel is the person".
 *
 * Row-major, `width * height` entries, each 0 to 1. MediaPipe's confidence
 * mask is exactly this shape once `getAsFloat32Array()` has been called on
 * it, which is why this is the interface rather than something richer.
 */
export interface SegmentationMask {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

export interface Segmenter {
  /** The mask for this frame, or `null` if the segmenter has nothing new to
   *  say about it. Returning `null` is normal and is not a failure. */
  segment(source: FrameSourceLike, timestampMs: number): SegmentationMask | null
  close(): void
}

export interface SegmenterFactory {
  (): Promise<Segmenter>
}

// ---------------------------------------------------------------------------
// Constants a product decision hangs on
// ---------------------------------------------------------------------------

/**
 * Whether the camera starts blurred.
 *
 * **This is the product decision, and it is one line so it stays one line.**
 * The failure mode of blur-on is a slightly soft background and some CPU.
 * The failure mode of blur-off is the incident that prompted the feature.
 * Those are not the same size, so it defaults on and the control to turn it
 * off sits directly under the camera toggle.
 */
export const BLUR_ON_BY_DEFAULT = true

export const DEFAULT_BLUR_STRENGTH = 0.6

/** Blur radius at strength 0 and 1, as a fraction of the frame width, so a
 *  480p and a 1080p frame end up looking equally blurred rather than the
 *  larger one looking merely soft. */
export const MIN_BLUR_RADIUS_FRACTION = 0.008
export const MAX_BLUR_RADIUS_FRACTION = 0.035

/**
 * Consecutive throwing frames before the effect gives up and says so.
 *
 * A single throw is usually a lost GPU context or a resize landing mid-frame
 * and the next frame is fine, so degrading on the first one would turn a
 * hiccup into a published room. Five frames is under a fifth of a second at
 * 30fps, and every one of them is blurred rather than passed through.
 */
export const MAX_CONSECUTIVE_SEGMENT_FAILURES = 5

/** Default cut between background and person, and the width of the soft
 *  band either side of it. A hard cut looks like a badly done cut-out; this
 *  is the cheapest thing that does not. */
const DEFAULT_MASK_THRESHOLD = 0.5
const DEFAULT_MASK_FEATHER = 0.4

/**
 * How far past each edge the blurred background is drawn.
 *
 * A blur samples pixels that are not there at the frame edge and returns
 * transparent for them, which paints a translucent frame around the picture.
 * Overdrawing by twice the radius pushes that artefact off-canvas. Costs a
 * slightly larger draw and nothing else.
 */
const OVERDRAW_RADII = 2

export type EffectMode = 'off' | 'blur' | 'replace'
export type EffectStatus = 'idle' | 'loading' | 'ready' | 'degraded'

/**
 * What to do with one frame.
 *
 * - `passthrough`: paint the camera frame as it is. Only ever correct when
 *   the effect is off or has failed loudly.
 * - `blur-all`: blur the entire frame, person included. Ugly, honest, and
 *   the right answer whenever an effect is wanted but no mask is available:
 *   while the model loads, and across a camera swap.
 * - `composite`: the real thing.
 */
export type FrameAction = 'passthrough' | 'blur-all' | 'composite'

export interface FrameState {
  mode: EffectMode
  /** The segmenter failed hard and the user has been told. */
  degraded: boolean
  /** A mask belonging to the *current* source is available. */
  maskReady: boolean
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strength as a 0-to-1 number, with anything unusable replaced by the
 *  default rather than propagated into a radius of `NaN` (which silently
 *  disables the blur, which publishes the room). */
export function clampStrength(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_BLUR_STRENGTH
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Blur radius in pixels for a strength and a frame width. Never zero: the
 *  weakest blur a user can select is still a blur, because a strength slider
 *  that reaches "off" without saying so is a way to publish a room by
 *  accident. */
export function blurRadiusPx(strength: number, frameWidth: number): number {
  const s = clampStrength(strength)
  const fraction = MIN_BLUR_RADIUS_FRACTION + s * (MAX_BLUR_RADIUS_FRACTION - MIN_BLUR_RADIUS_FRACTION)
  return Math.max(2, Math.round(fraction * Math.max(1, frameWidth)))
}

export interface MaskAlphaOptions {
  threshold?: number
  feather?: number
}

/** Hermite smoothstep, so the mask edge ramps rather than steps. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Turn a confidence mask into RGBA where the alpha channel is the person.
 *
 * White with a varying alpha, so the result is both a `destination-in`
 * stencil and a legible picture if anyone ever needs to look at it.
 */
export function maskToAlpha(
  mask: SegmentationMask,
  out: Uint8ClampedArray,
  opts: MaskAlphaOptions = {},
): void {
  const pixels = mask.width * mask.height
  if (out.length !== pixels * 4) {
    throw new Error(`mask alpha buffer size ${out.length} does not match ${pixels} pixels`)
  }
  const threshold = opts.threshold ?? DEFAULT_MASK_THRESHOLD
  const feather = opts.feather ?? DEFAULT_MASK_FEATHER
  const low = threshold - feather / 2
  const high = threshold + feather / 2
  for (let i = 0; i < pixels; i += 1) {
    const alpha = smoothstep(low, high, mask.data[i] ?? 0)
    const o = i * 4
    out[o] = 255
    out[o + 1] = 255
    out[o + 2] = 255
    out[o + 3] = Math.round(alpha * 255)
  }
}

/**
 * The rule, written down.
 *
 * There are exactly two routes to `passthrough` and both of them are things
 * the user knows about. Everything else blurs.
 */
export function decideFrameAction(state: FrameState): FrameAction {
  if (state.mode === 'off') return 'passthrough'
  if (state.degraded) return 'passthrough'
  if (!state.maskReady) return 'blur-all'
  return 'composite'
}

export interface CoverRect {
  dx: number
  dy: number
  dw: number
  dh: number
}

/** Where to draw a `srcW x srcH` image so it fills `dstW x dstH` without
 *  distorting it, cropping the overhang. The CSS `object-fit: cover` rule,
 *  because a bundled background stretched to a phone's aspect ratio looks
 *  like a mistake. */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): CoverRect {
  if (srcW <= 0 || srcH <= 0) return { dx: 0, dy: 0, dw: dstW, dh: dstH }
  const scale = Math.max(dstW / srcW, dstH / srcH)
  const dw = srcW * scale
  const dh = srcH * scale
  return { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface VideoEffectState {
  status: EffectStatus
  mode: EffectMode
  strength: number
  error?: string
}

export interface VideoEffectOptions {
  /** The canvas whose stream is published. Owned by the caller, because the
   *  caller is what calls `captureStream()` on it. */
  output: CanvasLike
  /** Scratch canvases: the person cut-out and the mask stencil. */
  createCanvas: CanvasFactory
  /** Called at most once, on first use, never at construction time unless an
   *  effect is already on. Roughly three megabytes of WASM sits behind this,
   *  and nobody should pay for it to enable a feature they will not use. */
  loadSegmenter: SegmenterFactory
  mode?: EffectMode
  strength?: number
  onStateChange?: (state: VideoEffectState) => void
}

export class VideoEffect {
  readonly #output: CanvasLike
  readonly #outCtx: Context2DLike
  readonly #createCanvas: CanvasFactory
  readonly #loadSegmenter: SegmenterFactory
  readonly #onStateChange?: (state: VideoEffectState) => void

  #mode: EffectMode
  #strength: number
  #status: EffectStatus = 'idle'
  #error: string | undefined
  #segmenter: Segmenter | null = null
  #loadPromise: Promise<void> | null = null
  #closed = false

  #lastMask: SegmentationMask | null = null
  #maskValid = false
  #failures = 0

  #background: FrameSourceLike | null = null
  #backgroundSize: { width: number; height: number } | null = null

  #personCanvas: CanvasLike | null = null
  #personCtx: Context2DLike | null = null
  #maskCanvas: CanvasLike | null = null
  #maskCtx: Context2DLike | null = null
  #maskImage: ImageDataLike | null = null

  constructor(opts: VideoEffectOptions) {
    this.#output = opts.output
    const ctx = opts.output.getContext('2d')
    if (!ctx) throw new Error('the output canvas has no 2D context')
    this.#outCtx = ctx
    this.#createCanvas = opts.createCanvas
    this.#loadSegmenter = opts.loadSegmenter
    this.#onStateChange = opts.onStateChange
    this.#mode = opts.mode ?? (BLUR_ON_BY_DEFAULT ? 'blur' : 'off')
    this.#strength = clampStrength(opts.strength ?? DEFAULT_BLUR_STRENGTH)
    if (this.#mode !== 'off') this.#ensureSegmenter()
  }

  get mode(): EffectMode {
    return this.#mode
  }

  get strength(): number {
    return this.#strength
  }

  get status(): EffectStatus {
    return this.#status
  }

  get lastError(): string | undefined {
    return this.#error
  }

  /** Resolves when the current load attempt has settled, whichever way. Not
   *  a success signal: check `status` for that. */
  ready(): Promise<void> {
    return this.#loadPromise ?? Promise.resolve()
  }

  setMode(mode: EffectMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    if (mode !== 'off') this.#ensureSegmenter()
    this.#emit()
  }

  setStrength(strength: number): void {
    this.#strength = clampStrength(strength)
    this.#emit()
  }

  /** The replacement background, plus its natural size if the caller knows
   *  it, so it can be cover-fitted rather than stretched. */
  setBackground(image: FrameSourceLike | null, size?: { width: number; height: number }): void {
    this.#background = image
    this.#backgroundSize = size ?? null
  }

  /**
   * The camera behind this effect is about to change, or just has.
   *
   * Throws away the mask, which belonged to the old camera and describes a
   * person who is no longer where it says. Until the new camera produces
   * one, every frame is blurred whole. Getting this wrong is the single
   * biggest way to leak: a few hundred milliseconds of unblurred frames
   * during a flip defeats the entire feature.
   */
  invalidateSource(): void {
    this.#lastMask = null
    this.#maskValid = false
    this.#failures = 0
  }

  /** Draw one frame. Returns what it decided to do, which is what the tests
   *  and the metrics both read. Never throws. */
  renderFrame(
    source: FrameSourceLike,
    width: number,
    height: number,
    timestampMs: number,
  ): FrameAction {
    if (this.#closed || width <= 0 || height <= 0) {
      if (!this.#closed) this.#paintPassthrough(source, width, height)
      return 'passthrough'
    }

    if (this.#output.width !== width) this.#output.width = width
    if (this.#output.height !== height) this.#output.height = height

    if (this.#mode === 'off' || this.#status === 'degraded') {
      this.#paintPassthrough(source, width, height)
      return 'passthrough'
    }

    if (!this.#segmenter) {
      this.#paintBlurAll(source, width, height)
      return 'blur-all'
    }

    try {
      const mask = this.#segmenter.segment(source, timestampMs)
      this.#failures = 0
      if (mask) {
        this.#lastMask = mask
        this.#maskValid = true
      }
    } catch (err) {
      this.#failures += 1
      this.#error = errorMessage(err)
      if (this.#failures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
        this.#setStatus('degraded')
        this.#paintPassthrough(source, width, height)
        return 'passthrough'
      }
      this.#paintBlurAll(source, width, height)
      return 'blur-all'
    }

    const action = decideFrameAction({
      mode: this.#mode,
      degraded: false,
      maskReady: this.#maskValid && this.#lastMask !== null,
    })

    if (action === 'composite') {
      try {
        this.#paintComposite(source, this.#lastMask!, width, height)
        return 'composite'
      } catch (err) {
        // A compositing failure is a canvas problem, not a segmentation one,
        // and the safe answer is still a blurred frame rather than a raw one.
        this.#error = errorMessage(err)
        this.#paintBlurAll(source, width, height)
        return 'blur-all'
      }
    }

    this.#paintBlurAll(source, width, height)
    return 'blur-all'
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#segmenter?.close()
    this.#segmenter = null
    this.#lastMask = null
    this.#maskValid = false
  }

  // -- internals ------------------------------------------------------------

  #ensureSegmenter(): void {
    if (this.#closed || this.#segmenter || this.#loadPromise || this.#status === 'degraded') return
    this.#setStatus('loading')
    this.#loadPromise = this.#loadSegmenter()
      .then((segmenter) => {
        if (this.#closed) {
          segmenter.close()
          return
        }
        this.#segmenter = segmenter
        this.#failures = 0
        this.#setStatus('ready')
      })
      .catch((err: unknown) => {
        this.#error = errorMessage(err)
        this.#setStatus('degraded')
      })
  }

  #setStatus(status: EffectStatus): void {
    this.#status = status
    this.#emit()
  }

  #emit(): void {
    this.#onStateChange?.({
      status: this.#status,
      mode: this.#mode,
      strength: this.#strength,
      error: this.#error,
    })
  }

  #paintPassthrough(source: FrameSourceLike, width: number, height: number): void {
    const ctx = this.#outCtx
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(source, 0, 0, width, height)
  }

  #paintBlurAll(source: FrameSourceLike, width: number, height: number): void {
    const ctx = this.#outCtx
    const radius = blurRadiusPx(this.#strength, width)
    const pad = radius * OVERDRAW_RADII
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(source, -pad, -pad, width + pad * 2, height + pad * 2)
    ctx.filter = 'none'
  }

  #paintComposite(
    source: FrameSourceLike,
    mask: SegmentationMask,
    width: number,
    height: number,
  ): void {
    const person = this.#ensurePerson(width, height)
    const stencil = this.#ensureMask(mask.width, mask.height)

    // 1. The person, cut out of the frame by the mask's alpha.
    person.ctx.filter = 'none'
    person.ctx.globalCompositeOperation = 'source-over'
    person.ctx.clearRect(0, 0, width, height)
    person.ctx.drawImage(source, 0, 0, width, height)

    maskToAlpha(mask, stencil.image.data)
    stencil.ctx.putImageData(stencil.image, 0, 0)

    // Scaling a low-resolution stencil up with smoothing on is what softens
    // the mask edge for free; the feather in `maskToAlpha` handles the rest.
    person.ctx.imageSmoothingEnabled = true
    person.ctx.globalCompositeOperation = 'destination-in'
    person.ctx.drawImage(stencil.canvas, 0, 0, width, height)
    person.ctx.globalCompositeOperation = 'source-over'

    // 2. The background.
    const ctx = this.#outCtx
    ctx.globalCompositeOperation = 'source-over'
    if (this.#mode === 'replace' && this.#background) {
      ctx.filter = 'none'
      const size = this.#backgroundSize
      const rect = size
        ? coverRect(size.width, size.height, width, height)
        : { dx: 0, dy: 0, dw: width, dh: height }
      ctx.drawImage(this.#background, rect.dx, rect.dy, rect.dw, rect.dh)
    } else {
      // Also the fallback when replace is on but no background has loaded:
      // blurred is the safe thing to show, never the room.
      const radius = blurRadiusPx(this.#strength, width)
      const pad = radius * OVERDRAW_RADII
      ctx.filter = `blur(${radius}px)`
      ctx.drawImage(source, -pad, -pad, width + pad * 2, height + pad * 2)
      ctx.filter = 'none'
    }

    // 3. The person over the top.
    ctx.drawImage(person.canvas, 0, 0, width, height)
  }

  #ensurePerson(width: number, height: number): { canvas: CanvasLike; ctx: Context2DLike } {
    if (!this.#personCanvas || !this.#personCtx) {
      this.#personCanvas = this.#createCanvas(width, height)
      const ctx = this.#personCanvas.getContext('2d')
      if (!ctx) throw new Error('the person canvas has no 2D context')
      this.#personCtx = ctx
    }
    if (this.#personCanvas.width !== width) this.#personCanvas.width = width
    if (this.#personCanvas.height !== height) this.#personCanvas.height = height
    return { canvas: this.#personCanvas, ctx: this.#personCtx }
  }

  #ensureMask(
    width: number,
    height: number,
  ): { canvas: CanvasLike; ctx: Context2DLike; image: ImageDataLike } {
    const changed =
      !this.#maskCanvas || this.#maskCanvas.width !== width || this.#maskCanvas.height !== height
    if (!this.#maskCanvas || !this.#maskCtx || changed) {
      if (!this.#maskCanvas) {
        this.#maskCanvas = this.#createCanvas(width, height)
      } else {
        this.#maskCanvas.width = width
        this.#maskCanvas.height = height
      }
      const ctx = this.#maskCanvas.getContext('2d')
      if (!ctx) throw new Error('the mask canvas has no 2D context')
      this.#maskCtx = ctx
      this.#maskImage = ctx.createImageData(width, height)
    }
    return { canvas: this.#maskCanvas, ctx: this.#maskCtx, image: this.#maskImage! }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
