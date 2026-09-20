/**
 * A tropical sea to sit behind a person on a call.
 *
 * ## Why this is drawn rather than looped
 *
 * A looping video would be prettier and it would also be a second decoder
 * running for the whole call, a few megabytes on the wire, and a thing whose
 * frame rate has to be reconciled with the camera's. This is a couple of
 * dozen canvas operations a frame at a capped resolution, it starts
 * instantly, it costs nothing to ship, and the whole of it can be tested
 * without a browser because the movement and the drawing are separate.
 *
 * ## The split, and why it matters for tests
 *
 * `ReefShoal` is *when*: it owns the clock, decides when a fish appears and
 * where each one has got to. It touches no canvas and takes its randomness
 * as an argument, so "a fish crosses occasionally rather than constantly" is
 * an assertion about numbers rather than something to squint at.
 * `ReefBackground` is *what it looks like*, and it is the only part that
 * needs a context.
 *
 * ## The backdrop is a layer, not the scene
 *
 * `setBackdrop` puts a still picture underneath everything - one of the
 * bundled sea photographs, or a generated one later. With none, the reef is
 * drawn in code, and the drawn one has to be good enough to ship on its own,
 * because a feature that depends on an asset arriving is a feature that is
 * broken until it does.
 *
 * ## Calm on purpose
 *
 * This sits behind somebody's face while they talk about work. Everything
 * here is slow: a fish takes fifteen seconds or so to cross, the light
 * shafts sway over tens of seconds, and most of the time there is no fish at
 * all. Motion in the corner of a video call is a thing the other person's
 * eye keeps going back to, and the version of this that was fun to watch was
 * the version that was impossible to be talked to in front of.
 */

import { coverRect, type BackgroundSource, type FrameSourceLike } from './video-effects.js'

// ---------------------------------------------------------------------------
// Injected drawing surface
//
// Same approach as video-effects.ts: name the subset of the 2D context that
// is actually used, so a real `CanvasRenderingContext2D` fits structurally
// and a test can pass a recorder.
// ---------------------------------------------------------------------------

export interface SceneGradient {
  addColorStop(offset: number, color: string): void
}

export interface SceneContext2D {
  /** `string | CanvasGradient | CanvasPattern` in the real thing; `unknown`
   *  here so a real context is assignable to this interface. */
  fillStyle: unknown
  strokeStyle: unknown
  filter: string
  globalAlpha: number
  globalCompositeOperation: string
  lineWidth: number
  lineCap: string
  imageSmoothingEnabled: boolean
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw?: boolean,
  ): void
  fill(): void
  stroke(): void
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): SceneGradient
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): SceneGradient
}

export interface SceneCanvas {
  width: number
  height: number
  getContext(contextId: '2d'): SceneContext2D | null
}

export interface SceneCanvasFactory {
  (width: number, height: number): SceneCanvas
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Longest step the scene clock will take in one go.
 *
 *  A tab that was hidden for four minutes comes back with a four-minute gap,
 *  and following it would fire every spawn that was due at once and teleport
 *  whatever was on screen off the far side. The scene simply did not happen
 *  while nobody was looking, which is also what it cost. */
export const MAX_STEP_MS = 100

/** At most this many fish at once. Three is already more than the calm
 *  version of this wants; it is a ceiling, not a target. */
export const MAX_FISH = 3

/** Gap between one fish appearing and the next being due. */
export const MIN_SPAWN_GAP_MS = 4_000
export const MAX_SPAWN_GAP_MS = 12_000

/** The first fish, so the scene is not empty for ten seconds when somebody
 *  turns it on and looks at it to see what it is. */
export const FIRST_SPAWN_MS = 900

/** How far past the edge a fish starts and is forgotten, as a fraction of
 *  the width, so it is never seen popping into existence. */
const EDGE_MARGIN = 0.18

export interface Fish {
  /** Centre, as fractions of the scene. `x` runs outside 0..1 at the ends. */
  x: number
  y: number
  /** Widths per second. */
  speed: number
  /** How wide it is drawn, as a fraction of the scene width. */
  size: number
  direction: 1 | -1
  bobAmplitude: number
  bobRate: number
  wagRate: number
  phase: number
  /**
   * Which fish this one is, as a number from 0 to 1.
   *
   * Not an index, because the shoal has no idea how many photographs turned
   * up: it decides *which of them* at spawn time and the drawing side turns
   * that into a subscript. Keeping it that way round means a sprite failing
   * to load changes what is drawn and never when.
   */
  variant: number
  /** Which drawn fish it would be, if no photograph is available. */
  palette: number
}

export interface ReefShoalOptions {
  random?: () => number
  maxFish?: number
  minGapMs?: number
  maxGapMs?: number
  firstSpawnMs?: number
}

/**
 * When a fish appears, and where every fish has got to.
 *
 * The clock is the scene's own, advanced by clamped steps, so it is not the
 * wall clock and does not run while the tab is hidden. Everything the drawing
 * code needs to be deterministic - phases, positions - hangs off it.
 */
export class ReefShoal {
  readonly #random: () => number
  readonly #maxFish: number
  readonly #minGap: number
  readonly #maxGap: number
  readonly #fish: Fish[] = []

  #lastAt: number | null = null
  #elapsed = 0
  #nextSpawnAt: number
  #spawned = 0

  constructor(opts: ReefShoalOptions = {}) {
    this.#random = opts.random ?? Math.random
    this.#maxFish = Math.max(1, opts.maxFish ?? MAX_FISH)
    this.#minGap = Math.max(0, opts.minGapMs ?? MIN_SPAWN_GAP_MS)
    this.#maxGap = Math.max(this.#minGap, opts.maxGapMs ?? MAX_SPAWN_GAP_MS)
    this.#nextSpawnAt = Math.max(0, opts.firstSpawnMs ?? FIRST_SPAWN_MS)
  }

  /** The scene's own elapsed time in milliseconds. Drawing phases come off
   *  this rather than off the wall clock, so a still frame is reproducible. */
  get elapsedMs(): number {
    return this.#elapsed
  }

  get fish(): readonly Fish[] {
    return this.#fish
  }

  /** How many have been let go since the start. Counted so a test can say
   *  "in five minutes, between this many and that many", which is the whole
   *  of what "occasionally" means. */
  get spawned(): number {
    return this.#spawned
  }

  /** Move everything on to wall-clock time `nowMs`. The first call only sets
   *  the clock; there is no elapsed time to apply yet. */
  advance(nowMs: number): void {
    if (this.#lastAt === null) {
      this.#lastAt = nowMs
      return
    }
    let dt = nowMs - this.#lastAt
    this.#lastAt = nowMs
    if (!(dt > 0)) return
    if (dt > MAX_STEP_MS) dt = MAX_STEP_MS
    this.#elapsed += dt

    const seconds = dt / 1000
    for (let i = this.#fish.length - 1; i >= 0; i -= 1) {
      const fish = this.#fish[i]!
      fish.x += fish.direction * fish.speed * seconds
      if (fish.x < -EDGE_MARGIN || fish.x > 1 + EDGE_MARGIN) this.#fish.splice(i, 1)
    }

    while (this.#elapsed >= this.#nextSpawnAt) {
      if (this.#fish.length < this.#maxFish) this.#fish.push(this.#spawn())
      this.#nextSpawnAt = this.#elapsed + this.#minGap + this.#random() * (this.#maxGap - this.#minGap)
    }
  }

  #spawn(): Fish {
    const r = this.#random
    const direction: 1 | -1 = r() < 0.5 ? 1 : -1
    this.#spawned += 1
    return {
      x: direction === 1 ? -EDGE_MARGIN : 1 + EDGE_MARGIN,
      // Never across the very top or the very bottom: the top is where the
      // light comes from and the bottom is the sand, and both look wrong
      // with a fish in them.
      y: 0.2 + r() * 0.58,
      // Fifteen to thirty seconds to cross. Slower than that reads as a
      // screensaver that has stuck.
      speed: 0.034 + r() * 0.033,
      // Small. A reef fish in open water is a long way off, and the first
      // version of this drew them at a seventh of the frame, which reads as
      // an aquarium pet with its nose against the lens rather than as
      // something swimming past behind you.
      size: 0.045 + r() * 0.042,
      direction,
      bobAmplitude: 0.004 + r() * 0.009,
      bobRate: 0.6 + r() * 0.7,
      wagRate: 3.2 + r() * 2.2,
      phase: r() * Math.PI * 2,
      variant: r(),
      palette: Math.floor(r() * FISH_PALETTE.length) % FISH_PALETTE.length,
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface FishColours {
  body: string
  belly: string
  fin: string
  stripe: string
}

/** Reef fish, roughly. Bright enough to read at a sixth of the frame width
 *  and all the way down against blue. */
export const FISH_PALETTE: readonly FishColours[] = [
  { body: '#ff8a3d', belly: '#ffd2a8', fin: '#e8641f', stripe: '#fff4e8' },
  { body: '#ffd23f', belly: '#fff0a8', fin: '#f0a80f', stripe: '#3a2a10' },
  { body: '#49b7ff', belly: '#bfe6ff', fin: '#ffd23f', stripe: '#0b5e90' },
  { body: '#ff5fa2', belly: '#ffc4dc', fin: '#c92f72', stripe: '#fff0f6' },
  { body: '#6fe3b0', belly: '#c9f6e2', fin: '#2aa579', stripe: '#0d4d3a' },
]

/** Largest the scene is ever drawn at.
 *
 *  It is going behind a person, at camera resolution, and then the whole
 *  frame is encoded at whatever bitrate the call is running. Drawing it at
 *  1280 wide would cost four times as much for detail that the encoder is
 *  about to throw away. */
export const SCENE_MAX_WIDTH = 640

/** The scene is not redrawn more often than this. A 60fps camera does not
 *  need sixty reef frames a second, and the ceiling is what keeps the cost
 *  per *camera* frame honest on a fast one. */
export const MIN_FRAME_GAP_MS = 28

/** Scene size for an output of `width x height`, capped and aspect-true so
 *  the cover-fit in the compositor is an exact fit. */
export function sceneSize(
  width: number,
  height: number,
  maxWidth = SCENE_MAX_WIDTH,
): { width: number; height: number } {
  const w = Math.max(16, Math.min(Math.round(width), maxWidth))
  const scale = w / Math.max(1, width)
  const h = Math.max(16, Math.round(Math.max(1, height) * scale))
  return { width: w, height: h }
}

/**
 * The reef, drawn once into its own canvas and then blitted every frame.
 *
 * Gradients and coral are the expensive part and none of it moves, so it is
 * paid for at startup and on a resize and never again. This is also the
 * layer a photograph replaces.
 */
export function drawReefBackdrop(ctx: SceneContext2D, width: number, height: number): void {
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  const water = ctx.createLinearGradient(0, 0, 0, height)
  water.addColorStop(0, '#5fe3f0')
  water.addColorStop(0.28, '#19b0da')
  water.addColorStop(0.62, '#0d6fae')
  water.addColorStop(1, '#0a4a7d')
  ctx.fillStyle = water
  ctx.fillRect(0, 0, width, height)

  // The sun, somewhere up and to one side, as a soft bloom rather than a
  // disc: a disc behind somebody's head looks like a lens flare.
  const sun = ctx.createRadialGradient(
    width * 0.72,
    -height * 0.12,
    0,
    width * 0.72,
    -height * 0.12,
    height * 0.95,
  )
  sun.addColorStop(0, 'rgba(255,255,255,0.55)')
  sun.addColorStop(0.45, 'rgba(190,245,255,0.18)')
  sun.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = sun
  ctx.fillRect(0, 0, width, height)

  // Distant water, hazed out, so the floor does not start abruptly.
  const haze = ctx.createLinearGradient(0, height * 0.55, 0, height)
  haze.addColorStop(0, 'rgba(10,74,125,0)')
  haze.addColorStop(1, 'rgba(6,52,92,0.55)')
  ctx.fillStyle = haze
  ctx.fillRect(0, height * 0.55, width, height * 0.45)

  // Sand.
  const sandTop = height * 0.8
  const sand = ctx.createLinearGradient(0, sandTop, 0, height)
  sand.addColorStop(0, 'rgba(226,209,160,0.35)')
  sand.addColorStop(0.35, 'rgba(232,216,171,0.85)')
  sand.addColorStop(1, '#ead9b2')
  ctx.fillStyle = sand
  ctx.beginPath()
  ctx.moveTo(0, sandTop + height * 0.05)
  ctx.quadraticCurveTo(width * 0.3, sandTop - height * 0.03, width * 0.62, sandTop + height * 0.02)
  ctx.quadraticCurveTo(width * 0.85, sandTop + height * 0.06, width, sandTop - height * 0.01)
  ctx.lineTo(width, height)
  ctx.lineTo(0, height)
  ctx.closePath()
  ctx.fill()

  // Coral, as silhouettes rather than as coral: at this size and this far
  // behind a face, detail is noise, and noise is the thing the encoder
  // spends bits on instead of the person's mouth.
  const corals: Array<[number, number, number, string]> = [
    [0.08, 0.86, 0.1, 'rgba(23,86,120,0.55)'],
    [0.2, 0.9, 0.07, 'rgba(120,64,120,0.45)'],
    [0.78, 0.88, 0.11, 'rgba(23,86,120,0.5)'],
    [0.92, 0.92, 0.08, 'rgba(150,84,64,0.4)'],
    [0.46, 0.93, 0.06, 'rgba(23,86,120,0.4)'],
  ]
  for (const [cx, cy, r, colour] of corals) {
    ctx.fillStyle = colour
    const x = cx * width
    const y = cy * height
    const size = r * width
    ctx.beginPath()
    ctx.ellipse(x, y, size, size * 0.72, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(x - size * 0.5, y + size * 0.2, size * 0.55, size * 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(x + size * 0.55, y + size * 0.25, size * 0.5, size * 0.45, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // A vignette, because a bright corner beside a face pulls the eye there.
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.45,
    Math.min(width, height) * 0.25,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.78,
  )
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(3,32,58,0.42)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, width, height)
}

/** One light shaft, pre-rendered so the per-frame cost is a `drawImage`. */
function drawShaftSprite(ctx: SceneContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height)
  const down = ctx.createLinearGradient(0, 0, 0, height)
  down.addColorStop(0, 'rgba(255,255,255,0.32)')
  down.addColorStop(0.55, 'rgba(214,248,255,0.12)')
  down.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.fillStyle = down
  ctx.fillRect(0, 0, width, height)
  // Feathered sideways, so the edges are not two hard lines.
  const across = ctx.createLinearGradient(0, 0, width, 0)
  across.addColorStop(0, 'rgba(255,255,255,0)')
  across.addColorStop(0.5, 'rgba(255,255,255,1)')
  across.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = across
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
}

const SHAFTS = [
  { at: 0.18, sway: 0.05, rate: 0.055, phase: 0, alpha: 0.75 },
  { at: 0.46, sway: 0.04, rate: 0.041, phase: 2.1, alpha: 0.55 },
  { at: 0.78, sway: 0.06, rate: 0.033, phase: 4.3, alpha: 0.65 },
]

/** Sixteen motes of whatever it is that drifts about in warm water. No state:
 *  each one's position is a function of its index and the scene clock, so a
 *  still frame and a moving one are drawn by the same code. */
function drawMotes(ctx: SceneContext2D, width: number, height: number, t: number): void {
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  for (let i = 0; i < 16; i += 1) {
    const seed = i * 0.6180339887
    const base = seed % 1
    const rise = ((base + t * (0.008 + (i % 5) * 0.0022)) % 1)
    const y = (1 - rise) * height
    const x = (((seed * 7.3) % 1) + Math.sin(t * 0.35 + i) * 0.012) * width
    const r = (i % 3 === 0 ? 1.6 : 1) * (width / 640) * 1.4
    ctx.globalAlpha = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(t * 0.8 + i))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/**
 * A photograph of a fish, cut out, facing left.
 *
 * Facing left is a contract with the files rather than a preference: every
 * sprite points the same way so "which way is it swimming" is one mirror
 * rather than two sets of artwork.
 */
export interface FishSprite {
  image: FrameSourceLike
  width: number
  height: number
}

/** Which of the loaded sprites this fish is. Deterministic, so the same
 *  fish is the same fish for as long as it is on screen. */
export function spriteFor(fish: Fish, sprites: readonly FishSprite[]): FishSprite | null {
  if (sprites.length === 0) return null
  const index = Math.floor(fish.variant * sprites.length)
  return sprites[index < 0 ? 0 : index >= sprites.length ? sprites.length - 1 : index]!
}

/**
 * Depth, as the two things that actually read as distance.
 *
 * A fish further away is smaller, paler against the water between you and
 * it, and softer. Size is already decided; this turns it into the other
 * two. The blur is a fraction of a pixel on a thirty-pixel sprite and only
 * on the small ones, which is the difference between selling depth and
 * paying for a filter on every fish in the scene.
 */
export function depthOf(size: number): { alpha: number; blurPx: number } {
  const near = Math.min(1, Math.max(0, (size - 0.045) / 0.042))
  return {
    alpha: 0.72 + near * 0.28,
    blurPx: near < 0.45 ? 0.6 : 0,
  }
}

/**
 * One photographed fish.
 *
 * Drawn about its own centre: the direction is a mirror, and the gentle
 * nose-up-as-it-rises tilt has to be negated on the mirrored side or the
 * fish swimming right would nose down as it climbed.
 */
export function drawFishSprite(
  ctx: SceneContext2D,
  fish: Fish,
  sprite: FishSprite,
  width: number,
  height: number,
  t: number,
): void {
  const w = fish.size * width
  const h = sprite.width > 0 ? (w * sprite.height) / sprite.width : w
  const x = fish.x * width
  const y = (fish.y + Math.sin(t * fish.bobRate + fish.phase) * fish.bobAmplitude) * height
  const tilt = Math.cos(t * fish.bobRate + fish.phase) * 0.1
  const depth = depthOf(fish.size)

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = depth.alpha
  if (depth.blurPx > 0) ctx.filter = `blur(${depth.blurPx}px)`
  ctx.translate(x, y)
  // The sprites face left, so the mirror is for the ones swimming right.
  if (fish.direction === 1) ctx.scale(-1, 1)
  ctx.rotate(fish.direction === 1 ? -tilt : tilt)
  ctx.drawImage(sprite.image, -w / 2, -h / 2, w, h)
  ctx.restore()
  ctx.filter = 'none'
  ctx.globalAlpha = 1
}

/** One fish drawn in code: the fallback for when no photograph loaded.
 *  Drawn around its own centre so the direction is a `scale(-1, 1)` and not
 *  a second set of coordinates. */
export function drawFish(
  ctx: SceneContext2D,
  fish: Fish,
  width: number,
  height: number,
  t: number,
): void {
  const colours = FISH_PALETTE[fish.palette] ?? FISH_PALETTE[0]!
  const length = fish.size * width
  const body = length * 0.5
  const tall = length * 0.3
  const x = fish.x * width
  const y = (fish.y + Math.sin(t * fish.bobRate + fish.phase) * fish.bobAmplitude) * height
  const wag = Math.sin(t * fish.wagRate + fish.phase)

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 0.94
  ctx.translate(x, y)
  ctx.scale(fish.direction, 1)
  // A slight nose-up as it rises and nose-down as it falls, which is most of
  // what makes it read as swimming rather than sliding.
  ctx.rotate(Math.cos(t * fish.bobRate + fish.phase) * 0.12)

  // Tail.
  ctx.fillStyle = colours.fin
  ctx.beginPath()
  ctx.moveTo(-body * 0.82, 0)
  ctx.lineTo(-body * 1.5 + wag * body * 0.12, -tall * (0.8 + wag * 0.1))
  ctx.quadraticCurveTo(-body * 1.12, 0, -body * 1.5 + wag * body * 0.12, tall * (0.8 - wag * 0.1))
  ctx.closePath()
  ctx.fill()

  // Dorsal fin.
  ctx.beginPath()
  ctx.moveTo(-body * 0.3, -tall * 0.75)
  ctx.quadraticCurveTo(0, -tall * 1.5 - wag * tall * 0.12, body * 0.35, -tall * 0.55)
  ctx.closePath()
  ctx.fill()

  // Body.
  ctx.fillStyle = colours.body
  ctx.beginPath()
  ctx.ellipse(0, 0, body, tall, 0, 0, Math.PI * 2)
  ctx.fill()

  // Belly.
  ctx.fillStyle = colours.belly
  ctx.beginPath()
  ctx.ellipse(body * 0.1, tall * 0.34, body * 0.62, tall * 0.4, 0, 0, Math.PI * 2)
  ctx.fill()

  // A stripe, so it is a reef fish and not a lozenge.
  ctx.fillStyle = colours.stripe
  ctx.globalAlpha = 0.75
  ctx.beginPath()
  ctx.ellipse(-body * 0.12, 0, body * 0.12, tall * 0.92, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 0.94

  // Eye.
  ctx.fillStyle = '#10222e'
  ctx.beginPath()
  ctx.arc(body * 0.55, -tall * 0.18, Math.max(1, tall * 0.13), 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// The background source
// ---------------------------------------------------------------------------

export interface ReefBackgroundOptions {
  createCanvas: SceneCanvasFactory
  /** Wall clock in milliseconds. The compositor passes the frame's own
   *  timestamp, so this is only used when nothing does. */
  now?: () => number
  random?: () => number
  /** True while the person has asked for less movement. Checked per frame,
   *  because it can be changed while a call is running. */
  reducedMotion?: () => boolean
  /** True while nobody can see the output. Checked per frame. */
  hidden?: () => boolean
  maxWidth?: number
  minFrameGapMs?: number
  shoal?: ReefShoal
}

/**
 * The reef, as something the compositor can ask for a frame.
 *
 * Three canvases: the backdrop (drawn once), one light-shaft sprite (drawn
 * once), and the scene itself (drawn per frame). A frame is one blit of the
 * backdrop, three blits of the shaft, sixteen dots and at most three fish.
 */
export class ReefBackground implements BackgroundSource {
  readonly #createCanvas: SceneCanvasFactory
  readonly #now: () => number
  readonly #reducedMotion: () => boolean
  readonly #hidden: () => boolean
  readonly #maxWidth: number
  readonly #gap: number
  readonly #shoal: ReefShoal

  #scene: SceneCanvas | null = null
  #sceneCtx: SceneContext2D | null = null
  #backdrop: SceneCanvas | null = null
  #shaft: SceneCanvas | null = null
  #size: { width: number; height: number } | null = null

  #image: FrameSourceLike | null = null
  #imageSize: { width: number; height: number } | null = null
  #sprites: readonly FishSprite[] = []
  #backdropDirty = true
  #painted = false
  #stillPainted = false
  #lastPaintAt = Number.NEGATIVE_INFINITY
  #closed = false

  constructor(opts: ReefBackgroundOptions) {
    this.#createCanvas = opts.createCanvas
    this.#now = opts.now ?? (() => Date.now())
    this.#reducedMotion = opts.reducedMotion ?? (() => false)
    this.#hidden = opts.hidden ?? (() => false)
    this.#maxWidth = Math.max(16, opts.maxWidth ?? SCENE_MAX_WIDTH)
    this.#gap = Math.max(0, opts.minFrameGapMs ?? MIN_FRAME_GAP_MS)
    this.#shoal = opts.shoal ?? new ReefShoal({ random: opts.random })
  }

  /**
   * Put a still picture under the fish, or take it away again.
   *
   * This is the seam the generated reef photograph arrives through. Nothing
   * else in the scene changes: the shafts, the motes and the fish are drawn
   * over whatever is here, so a photograph gets the movement for free and the
   * drawn reef keeps working when there is no photograph.
   */
  setBackdrop(image: FrameSourceLike | null, size?: { width: number; height: number } | null): void {
    this.#image = image
    this.#imageSize = size ?? null
    this.#backdropDirty = true
    this.#stillPainted = false
  }

  /**
   * The photographs to swim past, loaded once by whoever can load them.
   *
   * May be called late and may be called with fewer than expected: a sprite
   * that did not arrive is simply not one of the fish, and with none at all
   * the scene falls back to the fish drawn in code. Nothing here waits for
   * them, so switching the fish on never delays a frame.
   */
  setFishSprites(sprites: readonly FishSprite[]): void {
    this.#sprites = sprites
    this.#stillPainted = false
  }

  size(): { width: number; height: number } | null {
    return this.#size
  }

  frame(nowMs: number, width: number, height: number): FrameSourceLike | null {
    if (this.#closed) return null
    const wanted = sceneSize(width, height, this.#maxWidth)
    if (!this.#resize(wanted)) return null
    const scene = this.#scene
    const ctx = this.#sceneCtx
    if (!scene || !ctx) return null

    const at = Number.isFinite(nowMs) ? nowMs : this.#now()

    if (this.#reducedMotion()) {
      // One frame, drawn at the scene's time zero and then left alone. The
      // shoal is deliberately not advanced, so there are no fish: a fish
      // frozen mid-water is stranger than an empty sea.
      if (!this.#stillPainted) {
        this.#paint(ctx, 0, [])
        this.#stillPainted = true
        this.#painted = true
      }
      return scene
    }
    this.#stillPainted = false

    // Nobody is looking. Hand back the last frame and spend nothing; the
    // compositor still gets something to draw, so the track keeps running.
    if (this.#hidden() && this.#painted) return scene

    if (this.#painted && at - this.#lastPaintAt < this.#gap) return scene

    this.#shoal.advance(at)
    this.#paint(ctx, this.#shoal.elapsedMs / 1000, this.#shoal.fish)
    this.#lastPaintAt = at
    this.#painted = true
    return scene
  }

  close(): void {
    this.#closed = true
    this.#scene = null
    this.#sceneCtx = null
    this.#backdrop = null
    this.#shaft = null
    this.#image = null
  }

  // -- internals ------------------------------------------------------------

  #resize(wanted: { width: number; height: number }): boolean {
    if (this.#scene && this.#size && this.#size.width === wanted.width && this.#size.height === wanted.height) {
      return true
    }
    const scene = this.#createCanvas(wanted.width, wanted.height)
    scene.width = wanted.width
    scene.height = wanted.height
    const ctx = scene.getContext('2d')
    if (!ctx) return false
    this.#scene = scene
    this.#sceneCtx = ctx
    this.#size = wanted
    this.#backdrop = null
    this.#shaft = null
    this.#backdropDirty = true
    this.#painted = false
    this.#stillPainted = false
    return true
  }

  #ensureBackdrop(width: number, height: number): SceneCanvas | null {
    if (this.#backdrop && !this.#backdropDirty) return this.#backdrop
    const canvas = this.#backdrop ?? this.#createCanvas(width, height)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    if (this.#image) {
      // Cover-fitted here rather than at composite time, so a 1280-wide
      // photograph is resampled once instead of on every frame.
      ctx.imageSmoothingEnabled = true
      const natural = this.#imageSize
      const rect = natural
        ? coverRect(natural.width, natural.height, width, height)
        : { dx: 0, dy: 0, dw: width, dh: height }
      ctx.drawImage(this.#image, rect.dx, rect.dy, rect.dw, rect.dh)
    } else {
      drawReefBackdrop(ctx, width, height)
    }
    this.#backdrop = canvas
    this.#backdropDirty = false
    return canvas
  }

  #ensureShaft(width: number, height: number): SceneCanvas | null {
    if (this.#shaft) return this.#shaft
    // Wider and taller than it needs to be, because it is drawn rotated.
    const w = Math.max(8, Math.round(width * 0.22))
    const h = Math.max(8, Math.round(height * 1.7))
    const canvas = this.#createCanvas(w, h)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    drawShaftSprite(ctx, w, h)
    this.#shaft = canvas
    return canvas
  }

  #paint(ctx: SceneContext2D, t: number, fish: readonly Fish[]): void {
    const size = this.#size!
    const { width, height } = size

    const backdrop = this.#ensureBackdrop(width, height)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    if (backdrop) {
      ctx.drawImage(backdrop, 0, 0, width, height)
    } else {
      ctx.fillStyle = '#0d6fae'
      ctx.fillRect(0, 0, width, height)
    }

    const shaft = this.#ensureShaft(width, height)
    if (shaft) {
      ctx.globalCompositeOperation = 'lighter'
      for (const s of SHAFTS) {
        const x = (s.at + Math.sin(t * s.rate * Math.PI * 2 + s.phase) * s.sway) * width
        ctx.save()
        ctx.globalAlpha = s.alpha * (0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * s.rate * 3 + s.phase)))
        ctx.translate(x, -height * 0.32)
        ctx.rotate(0.2 + Math.sin(t * s.rate * Math.PI + s.phase) * 0.03)
        ctx.drawImage(shaft, -shaft.width / 2, 0, shaft.width, shaft.height)
        ctx.restore()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    drawMotes(ctx, width, height, t)
    for (const one of fish) {
      const sprite = spriteFor(one, this.#sprites)
      if (sprite) drawFishSprite(ctx, one, sprite, width, height, t)
      else drawFish(ctx, one, width, height, t)
    }
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'source-over'
  }
}
