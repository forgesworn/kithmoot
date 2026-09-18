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
 * While an effect is meant to be on, an unmodified camera frame must never
 * reach the output canvas - not while the model is loading, not during a
 * camera flip, and not once the segmenter has degraded. `decideFrameAction`
 * is that rule written down, and it has only one way to say "passthrough":
 * the user turned the effect off. Nothing the person chose to hide is ever
 * sent because something broke: when the effect cannot be trusted - the
 * segmenter is degraded, missing, or its mask is absent or stale - a replace
 * mode covers the whole frame with the chosen backdrop and no person, and a
 * blur mode blurs the whole frame at maximum strength. Degraded is not for
 * ever either: the segmenter is retried with backoff for as long as the
 * mode stays on, and the failure is surfaced to the person outside the
 * folded effect controls, not only inside them.
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
/**
 * Where the cut falls, and therefore how much of the edge is kept.
 *
 * This was 0.5, the obvious answer, and 0.5 keeps every pixel the model is
 * merely half sure about - which at the hair line and along a shoulder is a
 * fringe of the real room, sharp, drawn on top of a beach. The cut is nudged
 * past the middle so the doubtful pixels go with the room rather than with
 * the person; `STENCIL_ERODE_PX` does the rest, and does the part that a
 * threshold cannot.
 */
export const DEFAULT_MASK_THRESHOLD = 0.55
/**
 * Width of the soft band, in confidence units.
 *
 * This was 0.4, which is very wide: it turned everything between 0.3 and 0.7
 * confidence into a ramp, and against a blurred copy of the same room that
 * reads as a pleasantly soft edge. Against a *replacement* it reads as a
 * halo, because the pixels being faded in are the real room and they no
 * longer match what is behind them. With temporal smoothing holding the
 * edge still (`MaskSmoother`) a narrower band is affordable, and narrower is
 * what replacement wants.
 */
export const DEFAULT_MASK_FEATHER = 0.26

/**
 * How much of a new frame's confidence to believe where it agrees with the
 * last frame.
 *
 * The segmenter is run from scratch on every frame and nothing carries over,
 * so a pixel on the boundary of a perfectly still shoulder flips between
 * 0.45 and 0.55 frame after frame. Blur hid that. Replacement does not: the
 * edge crawls. Damping the agreeing case to about a third means a still edge
 * settles over three or four frames instead of buzzing.
 */
export const MASK_ALPHA_CALM = 0.34

/** ...and how much to believe it where it disagrees. A pixel that went from
 *  "definitely room" to "definitely person" is movement, not noise, and
 *  movement must not be smeared, so it is followed outright. */
export const MASK_ALPHA_MOVING = 1

/** The confidence change at which a pixel counts as having moved rather than
 *  wobbled. Below it the weight ramps between the two above. */
export const MASK_MOTION_DELTA = 0.4

/**
 * Erosion radius, in mask pixels. Zero by default, and the reason is a
 * measurement rather than a preference.
 *
 * MediaPipe hands back a confidence mask at the *camera's* resolution, not
 * the model's, so a 640x480 camera means 307,200 floats and a 720p one means
 * 921,600. A separable minimum filter over that measured 3.3ms and 11.5ms a
 * frame respectively - more than the segmentation itself - for an edge that
 * `DEFAULT_MASK_THRESHOLD` moves by the same distance for free.
 *
 * `erode` stays here, tested and exported, because a segmenter that returns
 * a mask at its own 256x256 costs 0.8ms for the same work and could afford
 * it. Turning it on is a one-line option; it is off because of what it
 * costs today, not because it is wrong.
 */
export const MASK_ERODE_PX = 0

/**
 * How far the person's outline is pulled in, in output pixels, and the part
 * of this work that earns its keep.
 *
 * A threshold moves the cut in *confidence*, which only moves the edge as
 * far as the mask happens to ramp. What has to go is fixed in *pixels*: a
 * camera's own edge, after 4:2:0 chroma subsampling and whatever scaling
 * happened on the way, is a pixel or so of the person blended with the room
 * behind them. Keep it and it gets drawn on the beach, and against a busy
 * photograph it reads as a dotted line around the head.
 *
 * So this is a real morphological erosion - and it is done on the stencil
 * canvas, not in JavaScript. Four `destination-in` draws of the stencil over
 * itself, offset left, right, up and down, come out as exactly the separable
 * minimum filter `erode` computes, on whatever is accelerating the canvas,
 * for none of the 3.3ms a frame the same thing costs over a camera-sized
 * Float32Array.
 */
export const STENCIL_ERODE_PX = 1.5

/**
 * How old a mask is allowed to be, in the timestamps `renderFrame` is
 * called with, before it stops counting as "ready".
 *
 * The segmenter is allowed to say "nothing new" for a frame or two and the
 * previous mask is still a good guess - a person does not teleport. Past
 * this it is a guess about where somebody used to be, and showing it is how
 * a moved person leaves a hole the room shows through. 500ms is fifteen
 * frames at 30fps: generous enough that a normal skipped frame never trips
 * it, short enough that nobody notices the fallback as anything but a
 * slightly longer blur.
 */
export const MASK_MAX_AGE_MS = 500

/**
 * Backoff schedule for retrying the segmenter once it has degraded, in
 * milliseconds. The last entry repeats for every attempt after it.
 *
 * Degraded used to be permanent, which turned one bad GPU context into a
 * published room for the rest of the call. Retrying is safe precisely
 * because degraded already fails closed: every attempt happens while the
 * frame is being covered or blurred, so a retry that fails again costs
 * nothing the viewer can see.
 */
export const SEGMENTER_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]

/**
 * Consecutive successfully-segmented frames before the backoff level is
 * allowed to reset to the top of `SEGMENTER_RETRY_DELAYS_MS`.
 *
 * A segmenter that loads fine but whose `segment()` always throws - a lost
 * GPU context, say - looks like a *success* to the loader every time: load,
 * five throws, degrade, retry, load, five throws, degrade... Resetting the
 * backoff on load rather than on sustained use turns that into a 2-second
 * loop forever, which is thirty pointless loads a minute for a segmenter
 * that was never going to work. Thirty consecutive good frames is a second
 * at 30fps: enough to call it actually recovered rather than about to throw
 * again.
 */
export const SEGMENTER_BACKOFF_RESET_STREAK = 30

/**
 * Hole filling for the temporally-smoothed mask.
 *
 * selfie_segmenter hands back 0.4-0.7 over a flat, plain torso - genuinely
 * unsure, not wrong - and `DEFAULT_MASK_THRESHOLD` (0.55) puts some of that
 * on the room side of the cut. Lowering the threshold was tried and
 * rejected: it reopens the hair-line fringe it was raised to close. Instead,
 * any patch of below-cut confidence that is not reachable from the frame
 * edge through other below-cut pixels cannot be room - the room is not
 * enclosed by the person - so it is raised to person confidence instead of
 * drawn as a window onto the background.
 */
export const HOLE_FILL_CUT = DEFAULT_MASK_THRESHOLD
/** What an enclosed low-confidence pixel is raised to. Below the erosion and
 *  feather bands, so the outline they draw is untouched. */
export const HOLE_FILL_CONFIDENCE = 0.9
/** An enclosed region larger than this fraction of the frame is left alone:
 *  a person framing a doorway with their arms is a real hole, not a torso. */
export const HOLE_FILL_MAX_FRACTION = 0.12

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
 *   the effect is off - the person chose to show the room.
 * - `blur-all`: blur the entire frame, person included, at maximum strength.
 *   The right answer in blur mode whenever an effect is wanted but cannot be
 *   trusted: while the model loads, across a camera swap, once degraded, or
 *   once the mask has gone stale.
 * - `cover`: paint the chosen backdrop over the whole frame with no person
 *   cut into it. The `blur-all` equivalent for replace mode: showing the
 *   real backdrop is possible without a mask, showing the person is not.
 * - `composite`: the real thing.
 */
export type FrameAction = 'passthrough' | 'blur-all' | 'cover' | 'composite'

export interface FrameState {
  mode: EffectMode
  /** The segmenter failed hard and the user has been told. */
  degraded: boolean
  /** A mask belonging to the *current* source is available and fresh - see
   *  `MASK_MAX_AGE_MS`. A present but stale mask counts as not ready: it
   *  describes where somebody used to be. */
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

export interface MaskSmootherOptions {
  /** Weight on the new frame where it agrees with the last one. */
  calmAlpha?: number
  /** Weight on the new frame where it disagrees with it completely. */
  movingAlpha?: number
  /** Confidence change at which `movingAlpha` is reached. */
  motionDelta?: number
  /** Mask pixels to pull the person's edge in by. 0 leaves it alone. */
  erode?: number
  /** `false` turns off hole filling, which is only ever wanted by a test
   *  measuring what it costs on its own. */
  holeFill?: false
  /** Confidence below which a pixel is "maybe room" for hole filling. */
  holeFillCut?: number
  /** What an enclosed low-confidence pixel is raised to. */
  holeFillConfidence?: number
  /** Largest enclosed region, as a fraction of the frame, that is filled. */
  holeFillMaxFraction?: number
}

/**
 * Carries the mask from one frame to the next.
 *
 * Two things happen here and they are separate ideas that happen to want the
 * same buffer:
 *
 * 1. **An exponential moving average with a motion-aware weight.** A plain
 *    EMA either buzzes (weight too high) or leaves a ghost trailing an arm
 *    (weight too low), and picking between those is picking which artefact
 *    to ship. Making the weight depend on how much *this* pixel changed
 *    dodges the choice: a still pixel is averaged hard, a pixel the person
 *    just moved into is taken as it comes.
 *
 * 2. **A small erosion.** The model over-claims at the hair line, so the
 *    edge is pulled in by a pixel before it is feathered.
 *
 * Buffers are allocated once per mask size and reused, because this runs on
 * the same thread as everything else the page is doing.
 */
export class MaskSmoother {
  #width = 0
  #height = 0
  #state: Float32Array | null = null
  #scratch: Float32Array | null = null
  #out: Float32Array | null = null
  #holeVisited: Uint8Array | null = null
  #holeStack: Int32Array | null = null

  readonly #calm: number
  readonly #moving: number
  readonly #delta: number
  readonly #erode: number
  readonly #holeFill: boolean
  readonly #holeFillCut: number
  readonly #holeFillConfidence: number
  readonly #holeFillMaxFraction: number

  constructor(opts: MaskSmootherOptions = {}) {
    this.#calm = clamp01(opts.calmAlpha ?? MASK_ALPHA_CALM)
    this.#moving = clamp01(opts.movingAlpha ?? MASK_ALPHA_MOVING)
    this.#delta = Math.max(1e-3, opts.motionDelta ?? MASK_MOTION_DELTA)
    this.#erode = Math.max(0, Math.round(opts.erode ?? MASK_ERODE_PX))
    this.#holeFill = opts.holeFill !== false
    this.#holeFillCut = opts.holeFillCut ?? HOLE_FILL_CUT
    this.#holeFillConfidence = opts.holeFillConfidence ?? HOLE_FILL_CONFIDENCE
    this.#holeFillMaxFraction = opts.holeFillMaxFraction ?? HOLE_FILL_MAX_FRACTION
  }

  /**
   * Forget everything.
   *
   * Called wherever `invalidateSource` is: a mask averaged across a camera
   * swap describes a person who is in neither picture.
   */
  reset(): void {
    this.#state = null
  }

  /** The smoothed mask for this frame. The returned buffer is reused, so it
   *  is only valid until the next call. */
  push(mask: SegmentationMask): SegmentationMask {
    const { width, height } = mask
    const pixels = width * height
    const data = mask.data

    if (!this.#state || this.#width !== width || this.#height !== height) {
      this.#width = width
      this.#height = height
      this.#state = new Float32Array(pixels)
      this.#scratch = new Float32Array(pixels)
      this.#out = new Float32Array(pixels)
      this.#holeVisited = new Uint8Array(pixels)
      this.#holeStack = new Int32Array(pixels)
      // The first frame of a new source has nothing to average against, and
      // inventing a history for it would mean fading the person in.
      this.#state.set(data.subarray(0, pixels))
    } else {
      // Written out longhand and with no allocation, because this runs over
      // every pixel of every frame on the same thread as the rest of the
      // page. `data[i]!` rather than `data[i] ?? 0`: the nullish check is
      // real code and a typed array read in range cannot be undefined.
      const state = this.#state
      const calm = this.#calm
      const span = this.#moving - calm
      const inverseDelta = 1 / this.#delta
      for (let i = 0; i < pixels; i += 1) {
        const previous = state[i]!
        const current = data[i]!
        const step = current - previous
        const change = step < 0 ? -step : step
        const t = change * inverseDelta
        state[i] = previous + step * (t >= 1 ? this.#moving : calm + span * t)
      }
    }

    if (this.#holeFill) {
      fillMaskHoles(
        this.#state,
        width,
        height,
        this.#holeVisited!,
        this.#holeStack!,
        this.#holeFillCut,
        this.#holeFillConfidence,
        this.#holeFillMaxFraction,
      )
    }

    if (this.#erode === 0) {
      return { width, height, data: this.#state }
    }
    erode(this.#state, this.#scratch!, this.#out!, width, height, this.#erode)
    return { width, height, data: this.#out! }
  }
}

/**
 * Raise any below-cut region of `state` that is not reachable from the
 * frame edge through other below-cut pixels to `fillConfidence`, in place.
 *
 * Two flood fills, both 4-connected, both over buffers the caller owns and
 * reuses frame to frame so this allocates nothing:
 *
 * 1. From every border pixel, through every below-cut pixel reachable from
 *    it. Whatever this reaches is real room: there is a path to the edge of
 *    the picture made entirely of pixels that look like background.
 * 2. Whatever below-cut pixel phase 1 did not reach is enclosed by
 *    above-cut (person) pixels on every side, so it cannot be room - unless
 *    the enclosed patch is implausibly big, in which case it is left alone
 *    rather than guessed at.
 *
 * `stack` doubles as a plain array-backed queue in phase 2 by walking a
 * separate read head over the same buffer, so one allocation-free buffer
 * does both a DFS and a set of BFS's.
 */
export function fillMaskHoles(
  state: Float32Array,
  width: number,
  height: number,
  visited: Uint8Array,
  stack: Int32Array,
  cut: number,
  fillConfidence: number,
  maxFraction: number,
): void {
  const pixels = width * height
  if (pixels === 0) return
  visited.fill(0)

  let sp = 0
  const pushIfLow = (i: number): void => {
    if (!visited[i] && state[i]! < cut) {
      visited[i] = 1
      stack[sp] = i
      sp += 1
    }
  }

  // Phase 1: seed from the whole border, then flood through it.
  for (let x = 0; x < width; x += 1) {
    pushIfLow(x)
    if (height > 1) pushIfLow((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    pushIfLow(y * width)
    if (width > 1) pushIfLow(y * width + width - 1)
  }
  while (sp > 0) {
    sp -= 1
    const i = stack[sp]!
    const x = i % width
    const y = (i / width) | 0
    if (x > 0) pushIfLow(i - 1)
    if (x < width - 1) pushIfLow(i + 1)
    if (y > 0) pushIfLow(i - width)
    if (y < height - 1) pushIfLow(i + width)
  }

  const cap = Math.floor(pixels * maxFraction)

  // Phase 2: sweep every pixel; anything below cut and still unvisited is
  // the start of an enclosed island. Collect it with the same buffer, used
  // this time as a queue (a moving read head over a growing write tail),
  // then fill it if it is not implausibly large.
  for (let start = 0; start < pixels; start += 1) {
    if (visited[start] || state[start]! >= cut) continue
    let tail = 0
    stack[tail] = start
    tail += 1
    visited[start] = 1
    let head = 0
    while (head < tail) {
      const i = stack[head]!
      head += 1
      const x = i % width
      const y = (i / width) | 0
      if (x > 0) {
        const n = i - 1
        if (!visited[n] && state[n]! < cut) {
          visited[n] = 1
          stack[tail] = n
          tail += 1
        }
      }
      if (x < width - 1) {
        const n = i + 1
        if (!visited[n] && state[n]! < cut) {
          visited[n] = 1
          stack[tail] = n
          tail += 1
        }
      }
      if (y > 0) {
        const n = i - width
        if (!visited[n] && state[n]! < cut) {
          visited[n] = 1
          stack[tail] = n
          tail += 1
        }
      }
      if (y < height - 1) {
        const n = i + width
        if (!visited[n] && state[n]! < cut) {
          visited[n] = 1
          stack[tail] = n
          tail += 1
        }
      }
    }
    if (tail <= cap) {
      for (let k = 0; k < tail; k += 1) {
        const idx = stack[k]!
        if (state[idx]! < fillConfidence) state[idx] = fillConfidence
      }
    }
  }
}

function clamp01(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Separable minimum filter: the person's edge, pulled in by `radius`.
 *
 * Separable because a square window of minima is the minimum of the row
 * minima, so an `r`-radius erosion costs `2 * (2r + 1)` comparisons a pixel
 * rather than `(2r + 1)^2`. At r=1 on a 256x256 mask that is the difference
 * between something worth writing and something worth not doing.
 *
 * Out-of-bounds neighbours are skipped rather than treated as background,
 * which would eat a pixel off every edge of the frame and cut a person
 * standing at the side of it in half.
 *
 * Both passes walk rows, never columns. The obvious way to write the
 * vertical one - for each pixel, look at the pixels above and below - strides
 * the array by a whole row per step and misses the cache on almost every
 * read. On a mask the size of the camera frame that cost more than the whole
 * of the rest of the effect put together: measured here, 6.3ms a frame
 * against 1.0ms for the same arithmetic done row by row.
 */
export function erode(
  src: Float32Array,
  scratch: Float32Array,
  out: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius === 1) {
    // The case that actually ships, with the window carried along the row
    // instead of re-read: three reads a pixel become one.
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      let left = src[row]!
      let middle = left
      for (let x = 0; x < width; x += 1) {
        const right = x + 1 < width ? src[row + x + 1]! : middle
        let min = middle
        if (left < min) min = left
        if (right < min) min = right
        scratch[row + x] = min
        left = middle
        middle = right
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      for (let x = 0; x < width; x += 1) {
        const from = x - radius < 0 ? 0 : x - radius
        const to = x + radius >= width ? width - 1 : x + radius
        let min = src[row + from]!
        for (let i = from + 1; i <= to; i += 1) {
          const v = src[row + i]!
          if (v < min) min = v
        }
        scratch[row + x] = min
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    const from = y - radius < 0 ? 0 : y - radius
    const to = y + radius >= height ? height - 1 : y + radius
    // Seed the output row from the first contributing row, then take the
    // minimum against each of the others a row at a time.
    out.set(scratch.subarray(from * width, from * width + width), row)
    for (let i = from + 1; i <= to; i += 1) {
      const other = i * width
      for (let x = 0; x < width; x += 1) {
        const a = out[row + x]!
        const b = scratch[other + x]!
        out[row + x] = a < b ? a : b
      }
    }
  }
}

/**
 * The rule, written down.
 *
 * There is exactly one route to `passthrough` and it is a thing the user
 * chose: the effect is off. Everything else that cannot be trusted - broken,
 * missing, or working from a mask too old to believe - falls closed onto
 * whatever the current mode can show without the camera: the backdrop alone
 * in replace mode, a maximum-strength blur otherwise. Nothing the person
 * asked to hide is ever sent because something broke.
 */
export function decideFrameAction(state: FrameState): FrameAction {
  if (state.mode === 'off') return 'passthrough'
  const trustworthy = !state.degraded && state.maskReady
  if (trustworthy) return 'composite'
  return state.mode === 'replace' ? 'cover' : 'blur-all'
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
// Backgrounds
// ---------------------------------------------------------------------------

/**
 * Whatever is behind the person in `replace` mode.
 *
 * A still picture is the degenerate case - `frame` hands back the same image
 * every time - and that is deliberate: once the background is a thing that
 * is *asked* for a frame rather than a thing that is *held*, an animated
 * scene is not a special case in the compositor, and the compositor stays
 * the one place that decides whether the camera is safe to show.
 *
 * Returning `null` is allowed and means "nothing to draw": the compositor
 * falls back to blurring the real frame, never to showing it.
 */
export interface BackgroundSource {
  /** The image to composite behind the person, at this moment, for an output
   *  of this size. Called once per composited frame and must be cheap. */
  frame(nowMs: number, width: number, height: number): FrameSourceLike | null
  /** Natural size of what `frame` returns, for cover-fitting, or `null` when
   *  it is already the size that was asked for. */
  size(): { width: number; height: number } | null
  close?(): void
}

/** A still picture, as a `BackgroundSource`. */
export function stillBackground(
  image: FrameSourceLike,
  size?: { width: number; height: number } | null,
): BackgroundSource {
  const natural = size ?? null
  return { frame: () => image, size: () => natural }
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
  /** Temporal mask smoothing. `false` turns it off, which is only ever
   *  wanted by a test that is measuring what it costs. */
  maskSmoothing?: MaskSmootherOptions | false
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
  #lastMaskAt: number | null = null
  #failures = 0
  readonly #smoother: MaskSmoother | null

  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #retryIndex = 0
  /** Consecutive frames segmented without throwing since the last time the
   *  backoff level was reset - see `SEGMENTER_BACKOFF_RESET_STREAK`. */
  #successStreak = 0

  #source: BackgroundSource | null = null

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
    this.#smoother =
      opts.maskSmoothing === false ? null : new MaskSmoother(opts.maskSmoothing ?? {})
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

  /**
   * Size of the mask last used, or null if there has not been one.
   *
   * Published rather than kept private because everything per-pixel in here
   * is priced by it, and it is not the number anybody expects: MediaPipe
   * returns the confidence mask at the *camera's* resolution, not the
   * model's 256x256. Guessing that wrong is how a 0.8ms idea turns into a
   * 3.3ms one.
   */
  get maskSize(): { width: number; height: number } | null {
    const mask = this.#lastMask
    return mask ? { width: mask.width, height: mask.height } : null
  }

  /** Resolves when the current load attempt has settled, whichever way. Not
   *  a success signal: check `status` for that. */
  ready(): Promise<void> {
    return this.#loadPromise ?? Promise.resolve()
  }

  /**
   * A mode change is also the one deliberate way out of degraded: turning
   * the effect off and on again is exactly what the failure notice tells
   * somebody to do, so it must actually work rather than leaving the
   * segmenter stuck on whatever backoff attempt it was on. Any transition
   * away from a degraded state - to off, or straight to a different mode
   * while still on - forgets the failure and, if the new mode wants a
   * segmenter, starts loading one immediately rather than waiting for the
   * next scheduled retry.
   */
  setMode(mode: EffectMode): void {
    if (this.#mode === mode) return
    this.#mode = mode
    this.#cancelRetry()
    if (this.#status === 'degraded') {
      this.#failures = 0
      this.#loadPromise = null
      this.#setStatus('idle')
    }
    if (mode !== 'off') this.#ensureSegmenter()
    this.#emit()
  }

  setStrength(strength: number): void {
    this.#strength = clampStrength(strength)
    this.#emit()
  }

  /** A still replacement background, plus its natural size if the caller
   *  knows it, so it can be cover-fitted rather than stretched. */
  setBackground(image: FrameSourceLike | null, size?: { width: number; height: number }): void {
    this.setBackgroundSource(image ? stillBackground(image, size ?? null) : null)
  }

  /**
   * A replacement background that redraws itself.
   *
   * Replaces whatever was there, still or animated, and closes it: the
   * previous one may be holding a canvas, and there is no point keeping the
   * reef alive behind a photograph of a bookshelf.
   */
  setBackgroundSource(source: BackgroundSource | null): void {
    const previous = this.#source
    this.#source = source
    if (previous && previous !== source) previous.close?.()
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
    this.#lastMaskAt = null
    this.#failures = 0
    // A mask averaged across a swap is an average of two different rooms.
    this.#smoother?.reset()
  }

  /** Draw one frame. Returns what it decided to do, which is what the tests
   *  and the metrics both read. Never throws. */
  renderFrame(
    source: FrameSourceLike,
    width: number,
    height: number,
    timestampMs: number,
  ): FrameAction {
    if (this.#closed) return 'passthrough'

    // A zero-size frame is a canvas or track that is not ready yet, not a
    // decision about what to show. Painting it was only ever safe because
    // it happened to be a no-op; painting the same `drawImage` call with
    // the effect *on* would be the exact leak this module exists to close
    // the moment a real frame follows an invalid one into the same call.
    // Nothing is painted here unless the person chose to show the camera.
    if (width <= 0 || height <= 0) {
      if (this.#mode === 'off') {
        this.#paintPassthrough(source, width, height)
        return 'passthrough'
      }
      return 'blur-all'
    }

    if (this.#output.width !== width) this.#output.width = width
    if (this.#output.height !== height) this.#output.height = height

    if (this.#mode === 'off') {
      this.#paintPassthrough(source, width, height)
      return 'passthrough'
    }

    if (this.#status === 'degraded' || !this.#segmenter) {
      return this.#paintUntrusted(source, width, height, timestampMs)
    }

    try {
      const mask = this.#segmenter.segment(source, timestampMs)
      this.#failures = 0
      // Only sustained use earns back the short retry delay - see
      // `SEGMENTER_BACKOFF_RESET_STREAK`.
      this.#successStreak += 1
      if (this.#successStreak >= SEGMENTER_BACKOFF_RESET_STREAK) {
        this.#retryIndex = 0
      }
      if (mask) {
        this.#lastMask = this.#smoother ? this.#smoother.push(mask) : mask
        this.#maskValid = true
        this.#lastMaskAt = timestampMs
      }
    } catch (err) {
      this.#failures += 1
      this.#successStreak = 0
      this.#error = errorMessage(err)
      if (this.#failures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
        // The segmenter itself is what is broken, not just this frame, so it
        // is dropped rather than asked again - `#scheduleRetry` is what asks
        // again, on its own schedule, not the render loop.
        this.#segmenter.close()
        this.#segmenter = null
        this.#setStatus('degraded')
        this.#scheduleRetry()
      }
      return this.#paintUntrusted(source, width, height, timestampMs)
    }

    const fresh =
      this.#maskValid &&
      this.#lastMask !== null &&
      this.#lastMaskAt !== null &&
      timestampMs - this.#lastMaskAt <= MASK_MAX_AGE_MS

    const action = decideFrameAction({
      mode: this.#mode,
      degraded: false,
      maskReady: fresh,
    })

    if (action === 'composite') {
      try {
        this.#paintComposite(source, this.#lastMask!, width, height, timestampMs)
        return 'composite'
      } catch (err) {
        // A compositing failure is a canvas problem, not a segmentation one,
        // and the safe answer is still the fail-closed one, not a raw frame.
        this.#error = errorMessage(err)
        return this.#paintUntrusted(source, width, height, timestampMs)
      }
    }

    return this.#paintUntrusted(source, width, height, timestampMs)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#cancelRetry()
    this.#segmenter?.close()
    this.#segmenter = null
    this.#source?.close?.()
    this.#source = null
    this.#lastMask = null
    this.#maskValid = false
    this.#lastMaskAt = null
    this.#smoother?.reset()
  }

  // -- internals ------------------------------------------------------------

  /** What to paint when the effect is on but cannot be trusted: no fresh
   *  mask, no segmenter, or degraded. Never the camera frame. */
  #paintUntrusted(
    source: FrameSourceLike,
    width: number,
    height: number,
    nowMs: number,
  ): FrameAction {
    if (this.#mode === 'replace') {
      return this.#paintCover(source, width, height, nowMs)
    }
    this.#paintBlurAll(source, width, height, true)
    return 'blur-all'
  }

  /**
   * Degraded is retried, not permanent, for as long as the mode stays on.
   * Backoff rather than every frame: a broken segmenter retried at 30fps is
   * thirty failed loads a second for nothing, and the frame is already
   * failing closed while it waits, so there is no rush.
   */
  #scheduleRetry(): void {
    if (this.#closed || this.#mode === 'off' || this.#retryTimer) return
    const delays = SEGMENTER_RETRY_DELAYS_MS
    const delay = delays[Math.min(this.#retryIndex, delays.length - 1)]!
    this.#retryIndex += 1
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      if (this.#closed || this.#mode === 'off') return
      this.#failures = 0
      this.#loadSegmenterNow()
    }, delay)
  }

  #cancelRetry(): void {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    this.#retryIndex = 0
  }

  #ensureSegmenter(): void {
    if (this.#closed || this.#segmenter || this.#loadPromise || this.#status === 'degraded') return
    this.#loadSegmenterNow()
  }

  #loadSegmenterNow(): void {
    this.#setStatus('loading')
    this.#loadPromise = this.#loadSegmenter()
      .then((segmenter) => {
        if (this.#closed) {
          segmenter.close()
          return
        }
        this.#segmenter = segmenter
        this.#failures = 0
        this.#successStreak = 0
        // The timer that led here, if any, has already fired and cleared
        // itself; this only matters for the case where loading was kicked
        // off some other way. The backoff *level* is deliberately left
        // alone - a segmenter that loads but immediately throws again
        // should not get the same short delay every time. It resets only
        // after `SEGMENTER_BACKOFF_RESET_STREAK` frames of real use, in
        // `renderFrame`.
        if (this.#retryTimer) {
          clearTimeout(this.#retryTimer)
          this.#retryTimer = null
        }
        this.#setStatus('ready')
      })
      .catch((err: unknown) => {
        if (this.#closed) return
        this.#error = errorMessage(err)
        this.#setStatus('degraded')
        this.#scheduleRetry()
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

  /** `forceMax`: ignore the user's chosen strength and blur as hard as
   *  possible. Only ever passed when the effect cannot be trusted - a weak
   *  blur the person picked for a good mask is not a safe blur for no mask
   *  at all. */
  #paintBlurAll(source: FrameSourceLike, width: number, height: number, forceMax = false): void {
    const ctx = this.#outCtx
    const radius = blurRadiusPx(forceMax ? 1 : this.#strength, width)
    const pad = radius * OVERDRAW_RADII
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = `blur(${radius}px)`
    ctx.drawImage(source, -pad, -pad, width + pad * 2, height + pad * 2)
    ctx.filter = 'none'
  }

  /**
   * `cover`: the backdrop alone, no person cut into it. Replace mode's
   * answer to "the effect cannot be trusted" - there is no mask to composite
   * with, but there is still a backdrop, and painting it over the whole
   * frame is strictly safer than showing any of the room behind it.
   */
  #paintCover(source: FrameSourceLike, width: number, height: number, nowMs: number): FrameAction {
    let replacement: FrameSourceLike | null = null
    let replacementSize: { width: number; height: number } | null = null
    if (this.#source) {
      try {
        replacement = this.#source.frame(nowMs, width, height)
        replacementSize = replacement ? this.#source.size() : null
      } catch (err) {
        this.#error = errorMessage(err)
        replacement = null
      }
    }

    if (!replacement) {
      // No backdrop loaded yet either: the camera is still not an option,
      // so a maximum-strength blur is the fallback, same as blur mode.
      this.#paintBlurAll(source, width, height, true)
      return 'blur-all'
    }

    const ctx = this.#outCtx
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    const rect = replacementSize
      ? coverRect(replacementSize.width, replacementSize.height, width, height)
      : { dx: 0, dy: 0, dw: width, dh: height }
    ctx.drawImage(replacement, rect.dx, rect.dy, rect.dw, rect.dh)
    return 'cover'
  }

  #paintComposite(
    source: FrameSourceLike,
    mask: SegmentationMask,
    width: number,
    height: number,
    nowMs: number,
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
    this.#erodeStencil(stencil.canvas, stencil.ctx, mask.width, mask.height)

    // Scaling a low-resolution stencil up with smoothing on is what softens
    // the mask edge for free; the feather in `maskToAlpha` handles the rest.
    person.ctx.imageSmoothingEnabled = true
    person.ctx.globalCompositeOperation = 'destination-in'
    person.ctx.drawImage(stencil.canvas, 0, 0, width, height)
    person.ctx.globalCompositeOperation = 'source-over'

    // 2. The background. A source that throws or hands back nothing is not
    //    allowed to take the frame down with it: it falls through to blur,
    //    like every other thing that can go wrong in here.
    let replacement: FrameSourceLike | null = null
    let replacementSize: { width: number; height: number } | null = null
    if (this.#mode === 'replace' && this.#source) {
      try {
        replacement = this.#source.frame(nowMs, width, height)
        replacementSize = replacement ? this.#source.size() : null
      } catch (err) {
        this.#error = errorMessage(err)
        replacement = null
      }
    }

    const ctx = this.#outCtx
    ctx.globalCompositeOperation = 'source-over'
    if (replacement) {
      ctx.filter = 'none'
      const rect = replacementSize
        ? coverRect(replacementSize.width, replacementSize.height, width, height)
        : { dx: 0, dy: 0, dw: width, dh: height }
      ctx.drawImage(replacement, rect.dx, rect.dy, rect.dw, rect.dh)
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

  /**
   * Pull the stencil's outline in, on the canvas rather than in a loop.
   *
   * Four draws of the stencil over itself with `destination-in`, which keeps
   * the smaller of the two alphas at every pixel. Left then right is a
   * three-tap minimum across; up then down is the same down the column; the
   * two together are the separable erosion, arrived at by the same algebra
   * and paid for by whatever is drawing the canvas.
   *
   * Drawing a canvas onto itself is defined behaviour - the source is
   * snapshotted before the draw - and it is the whole trick here.
   */
  #erodeStencil(canvas: CanvasLike, ctx: Context2DLike, width: number, height: number): void {
    const px = STENCIL_ERODE_PX
    if (!(px > 0)) return
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(canvas, -px, 0, width, height)
    ctx.drawImage(canvas, px, 0, width, height)
    ctx.drawImage(canvas, 0, -px, width, height)
    ctx.drawImage(canvas, 0, px, width, height)
    ctx.globalCompositeOperation = 'source-over'
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
