import { describe, it, expect } from 'vitest'
import {
  FIRST_SPAWN_MS,
  MAX_FISH,
  MAX_STEP_MS,
  MIN_FRAME_GAP_MS,
  ReefBackground,
  ReefShoal,
  depthOf,
  drawFishSprite,
  sceneSize,
  spriteFor,
  type Fish,
  type FishSprite,
  type SceneCanvas,
  type SceneContext2D,
  type SceneGradient,
  type ReefBackgroundOptions,
} from './reef-scene.js'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A repeatable "random": a fixed cycle, so a spawn is a fact rather than a
 *  coin toss that occasionally makes the suite red. */
function cycle(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

class RecordingContext implements SceneContext2D {
  fillStyle: unknown = '#000'
  strokeStyle: unknown = '#000'
  filter = 'none'
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  lineWidth = 1
  lineCap = 'butt'
  imageSmoothingEnabled = true
  readonly calls: string[] = []
  #depth = 0

  #note(name: string): void {
    this.calls.push(name)
  }
  save(): void {
    this.#depth += 1
    this.#note('save')
  }
  restore(): void {
    this.#depth -= 1
    this.#note('restore')
  }
  get depth(): number {
    return this.#depth
  }
  translate(): void {
    this.#note('translate')
  }
  rotate(): void {
    this.#note('rotate')
  }
  scale(): void {
    this.#note('scale')
  }
  clearRect(): void {
    this.#note('clearRect')
  }
  fillRect(): void {
    this.#note('fillRect')
  }
  beginPath(): void {
    this.#note('beginPath')
  }
  closePath(): void {
    this.#note('closePath')
  }
  moveTo(): void {
    this.#note('moveTo')
  }
  lineTo(): void {
    this.#note('lineTo')
  }
  quadraticCurveTo(): void {
    this.#note('quadraticCurveTo')
  }
  arc(): void {
    this.#note('arc')
  }
  ellipse(): void {
    this.#note('ellipse')
  }
  fill(): void {
    this.#note('fill')
  }
  stroke(): void {
    this.#note('stroke')
  }
  readonly drawn: unknown[] = []
  drawImage(image: unknown): void {
    this.drawn.push(image)
    this.#note('drawImage')
  }
  createLinearGradient(): SceneGradient {
    this.#note('createLinearGradient')
    return { addColorStop: () => {} }
  }
  createRadialGradient(): SceneGradient {
    this.#note('createRadialGradient')
    return { addColorStop: () => {} }
  }
}

class RecordingCanvas implements SceneCanvas {
  readonly ctx = new RecordingContext()
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(_id: '2d'): SceneContext2D | null {
    return this.ctx
  }
}

function canvasFactory(): { create: (w: number, h: number) => SceneCanvas; made: RecordingCanvas[] } {
  const made: RecordingCanvas[] = []
  return {
    made,
    create(w, h) {
      const c = new RecordingCanvas(w, h)
      made.push(c)
      return c
    },
  }
}

// ---------------------------------------------------------------------------

describe('ReefShoal timing', () => {
  /** Frame by frame, at 30fps, from zero to `untilMs`. The clock is clamped
   *  per step on purpose, so nothing here may jump. */
  function run(shoal: ReefShoal, untilMs: number, fromMs = 0): void {
    for (let t = fromMs; t <= untilMs; t += 33) shoal.advance(t)
  }

  it('has no fish at all until the first one is due', () => {
    const shoal = new ReefShoal({ random: cycle([0.5]) })
    run(shoal, FIRST_SPAWN_MS - 50)
    expect(shoal.fish).toHaveLength(0)
    run(shoal, FIRST_SPAWN_MS + 100, FIRST_SPAWN_MS - 17)
    expect(shoal.fish).toHaveLength(1)
  })

  it('lets one go occasionally rather than constantly', () => {
    const shoal = new ReefShoal({ random: cycle([0.3, 0.7, 0.1, 0.9, 0.5]) })
    // Five minutes at 30fps.
    for (let t = 0; t <= 300_000; t += 33) shoal.advance(t)
    // Between four and twelve seconds apart, so five minutes is somewhere
    // between twenty-five and seventy-five - never a stream of them.
    expect(shoal.spawned).toBeGreaterThan(20)
    expect(shoal.spawned).toBeLessThan(80)
  })

  it('never has more than the ceiling on screen at once', () => {
    // Randomness pinned so every gap is the shortest one allowed, which is
    // the worst case the ceiling exists for.
    const shoal = new ReefShoal({ random: cycle([0]) })
    let most = 0
    for (let t = 0; t <= 120_000; t += 33) {
      shoal.advance(t)
      most = Math.max(most, shoal.fish.length)
    }
    expect(most).toBe(MAX_FISH)
  })

  it('carries a fish all the way across and then forgets it', () => {
    const shoal = new ReefShoal({ random: cycle([0.5]), maxFish: 1, minGapMs: 1e9, maxGapMs: 1e9 })
    run(shoal, FIRST_SPAWN_MS + 100)
    const [fish] = shoal.fish
    expect(fish).toBeDefined()
    const startedAt = fish!.x
    const direction = fish!.direction
    run(shoal, 6_000, FIRST_SPAWN_MS + 133)
    const travelled = (shoal.fish[0]!.x - startedAt) * direction
    expect(travelled).toBeGreaterThan(0)
    // Still on screen after five seconds: crossing is a slow business.
    expect(shoal.fish[0]!.x).toBeGreaterThan(0)
    expect(shoal.fish[0]!.x).toBeLessThan(1.2)
    // Fifteen seconds or more to cross, so it is still going at five.
    run(shoal, 60_000, 6_033)
    expect(shoal.fish).toHaveLength(0)
  })

  it('does not teleport or spawn a burst after a long gap', () => {
    const shoal = new ReefShoal({ random: cycle([0.5]) })
    run(shoal, FIRST_SPAWN_MS + 100)
    const before = shoal.fish[0]!.x
    const spawnedBefore = shoal.spawned
    // Four minutes of hidden tab, arriving as one step.
    shoal.advance(FIRST_SPAWN_MS + 100 + 240_000)
    expect(shoal.spawned).toBe(spawnedBefore)
    const moved = Math.abs(shoal.fish[0]!.x - before)
    // At most one clamped step's worth of travel.
    expect(moved).toBeLessThanOrEqual((MAX_STEP_MS / 1000) * 0.07 + 1e-9)
  })

  it('ignores a clock that goes backwards', () => {
    const shoal = new ReefShoal({ random: cycle([0.5]) })
    shoal.advance(10_000)
    shoal.advance(9_000)
    expect(shoal.elapsedMs).toBe(0)
  })

  it('puts fish in the water, not in the sky or the sand', () => {
    const shoal = new ReefShoal({ random: cycle([0.02, 0.98, 0.41, 0.63, 0.17]) })
    for (let t = 0; t <= 200_000; t += 33) shoal.advance(t)
    for (const fish of shoal.fish) {
      expect(fish.y).toBeGreaterThanOrEqual(0.2)
      expect(fish.y).toBeLessThanOrEqual(0.78)
    }
  })
})

describe('sceneSize', () => {
  it('caps the width and keeps the aspect, so the cover fit is exact', () => {
    const size = sceneSize(1280, 720)
    expect(size.width).toBe(640)
    expect(size.height).toBe(360)
  })

  it('never upscales a small frame', () => {
    expect(sceneSize(320, 240)).toEqual({ width: 320, height: 240 })
  })
})

describe('ReefBackground', () => {
  /** Everything but the canvas factory, with the randomness pinned. */
  const opts = (
    extra: Omit<Partial<ReefBackgroundOptions>, 'createCanvas'> = {},
  ): Omit<Partial<ReefBackgroundOptions>, 'createCanvas'> => ({ random: cycle([0.5]), ...extra })

  it('draws at the scene size and reports it for cover-fitting', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    const frame = reef.frame(0, 1280, 720)
    expect(frame).toBe(factory.made[0])
    expect(reef.size()).toEqual({ width: 640, height: 360 })
    expect(factory.made[0]!.width).toBe(640)
  })

  it('changes between frames', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    reef.frame(0, 640, 360)
    const first = factory.made[0]!.ctx.calls.length
    reef.frame(5_000, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBeGreaterThan(first)
  })

  it('does not redraw faster than the frame ceiling', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    reef.frame(0, 640, 360)
    const after = factory.made[0]!.ctx.calls.length
    reef.frame(MIN_FRAME_GAP_MS / 2, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBe(after)
    reef.frame(MIN_FRAME_GAP_MS + 1, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBeGreaterThan(after)
  })

  it('spends nothing while the tab is hidden, and still hands back a frame', () => {
    const factory = canvasFactory()
    let hidden = false
    const reef = new ReefBackground({
      createCanvas: factory.create,
      hidden: () => hidden,
      ...opts(),
    })
    reef.frame(0, 640, 360)
    const painted = factory.made[0]!.ctx.calls.length
    hidden = true
    for (let t = 1_000; t <= 20_000; t += 1_000) {
      expect(reef.frame(t, 640, 360)).toBe(factory.made[0])
    }
    expect(factory.made[0]!.ctx.calls.length).toBe(painted)
    hidden = false
    reef.frame(21_000, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBeGreaterThan(painted)
  })

  it('falls back to one still frame when less movement is asked for', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({
      createCanvas: factory.create,
      reducedMotion: () => true,
      ...opts(),
    })
    reef.frame(0, 640, 360)
    const painted = factory.made[0]!.ctx.calls.length
    for (let t = 1_000; t <= 60_000; t += 1_000) reef.frame(t, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBe(painted)
  })

  it('starts moving again when the setting is turned off mid-call', () => {
    const factory = canvasFactory()
    let still = true
    const reef = new ReefBackground({
      createCanvas: factory.create,
      reducedMotion: () => still,
      ...opts(),
    })
    reef.frame(0, 640, 360)
    const painted = factory.made[0]!.ctx.calls.length
    still = false
    reef.frame(1_000, 640, 360)
    expect(factory.made[0]!.ctx.calls.length).toBeGreaterThan(painted)
  })

  it('leaves the context balanced, so the compositor is handed a clean one', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    for (let t = 0; t <= 30_000; t += 100) reef.frame(t, 640, 360)
    const ctx = factory.made[0]!.ctx
    expect(ctx.depth).toBe(0)
    expect(ctx.globalAlpha).toBe(1)
    expect(ctx.globalCompositeOperation).toBe('source-over')
  })

  it('draws a supplied still underneath rather than the drawn reef', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    const photo = { photo: true }
    reef.setBackdrop(photo, { width: 1280, height: 720 })
    reef.frame(0, 640, 360)
    const backdrop = factory.made.find((c) => c !== factory.made[0] && c.width === 640)
    expect(backdrop).toBeDefined()
    // The photo, and none of the gradients the drawn reef is made of.
    expect(backdrop!.ctx.calls).toContain('drawImage')
    expect(backdrop!.ctx.calls).not.toContain('createRadialGradient')
  })

  it('draws the reef in code when there is no still', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    reef.frame(0, 640, 360)
    const backdrop = factory.made.find((c) => c !== factory.made[0] && c.width === 640)
    expect(backdrop!.ctx.calls).toContain('createRadialGradient')
  })

  it('redraws the backdrop only when it changes', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    reef.frame(0, 640, 360)
    const backdrop = factory.made.find((c) => c !== factory.made[0] && c.width === 640)!
    const painted = backdrop.ctx.calls.length
    for (let t = 100; t <= 10_000; t += 100) reef.frame(t, 640, 360)
    expect(backdrop.ctx.calls.length).toBe(painted)
    reef.setBackdrop({ photo: true }, { width: 8, height: 8 })
    reef.frame(10_100, 640, 360)
    expect(backdrop.ctx.calls.length).toBeGreaterThan(painted)
  })

  it('gives nothing back once closed, so the compositor blurs instead', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    reef.frame(0, 640, 360)
    reef.close()
    expect(reef.frame(1_000, 640, 360)).toBeNull()
  })

  it('draws the photographs once they arrive, and draws nothing of them before', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    const sprites = [0, 1, 2].map((i) => ({ image: { fish: i }, width: 256, height: 170 }))
    // Long enough that the shoal certainly has something in it.
    for (let t = 0; t <= 6_000; t += 33) reef.frame(t, 640, 360)
    const scene = factory.made[0]!
    expect(scene.ctx.drawn.some((d) => sprites.some((s) => s.image === d))).toBe(false)

    reef.setFishSprites(sprites)
    scene.ctx.drawn.length = 0
    for (let t = 6_033; t <= 7_000; t += 33) reef.frame(t, 640, 360)
    expect(scene.ctx.drawn.some((d) => sprites.some((s) => s.image === d))).toBe(true)
  })

  it('falls back to the fish drawn in code when no photograph loaded', () => {
    const factory = canvasFactory()
    const reef = new ReefBackground({ createCanvas: factory.create, ...opts() })
    for (let t = 0; t <= 6_000; t += 33) reef.frame(t, 640, 360)
    // An ellipse is a body and an eye; the backdrop's corals are on their
    // own canvas, so one here is a fish.
    expect(factory.made[0]!.ctx.calls).toContain('ellipse')
  })
})

describe('fish sprites', () => {
  const fish = (variant: number, size = 0.06, direction: 1 | -1 = -1): Fish => ({
    x: 0.5,
    y: 0.4,
    speed: 0.05,
    size,
    direction,
    bobAmplitude: 0.005,
    bobRate: 1,
    wagRate: 4,
    phase: 0,
    variant,
    palette: 0,
  })

  const sprites: FishSprite[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    image: { fish: i },
    width: 256,
    height: 170,
  }))

  it('picks one, the same one, every frame', () => {
    const one = fish(0.42)
    expect(spriteFor(one, sprites)).toBe(sprites[2])
    expect(spriteFor(one, sprites)).toBe(sprites[2])
  })

  it('covers the whole set and never runs off the end', () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => spriteFor(fish(i / 60), sprites)),
    )
    expect(seen.size).toBe(sprites.length)
    expect(spriteFor(fish(1), sprites)).toBe(sprites[sprites.length - 1])
  })

  it('has nothing to pick from when nothing loaded', () => {
    expect(spriteFor(fish(0.5), [])).toBeNull()
  })

  it('mirrors the ones swimming right, since the photographs face left', () => {
    const canvas = new RecordingCanvas(640, 360)
    drawFishSprite(canvas.ctx, fish(0.1, 0.06, 1), sprites[0]!, 640, 360, 0)
    expect(canvas.ctx.calls).toContain('scale')
    const left = new RecordingCanvas(640, 360)
    drawFishSprite(left.ctx, fish(0.1, 0.06, -1), sprites[0]!, 640, 360, 0)
    expect(left.ctx.calls).not.toContain('scale')
  })

  it('leaves the context clean for whatever is drawn next', () => {
    const canvas = new RecordingCanvas(640, 360)
    drawFishSprite(canvas.ctx, fish(0.1, 0.045), sprites[0]!, 640, 360, 0)
    expect(canvas.ctx.filter).toBe('none')
    expect(canvas.ctx.globalAlpha).toBe(1)
  })

  it('fades and softens the distant ones, and leaves the near ones alone', () => {
    const far = depthOf(0.045)
    const near = depthOf(0.087)
    expect(far.alpha).toBeLessThan(near.alpha)
    expect(near.alpha).toBe(1)
    expect(far.blurPx).toBeGreaterThan(0)
    // Nothing is paid for on the fish that would not benefit.
    expect(near.blurPx).toBe(0)
  })
})
