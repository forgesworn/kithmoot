import { describe, it, expect, vi } from 'vitest'
import {
  BLUR_ON_BY_DEFAULT,
  DEFAULT_BLUR_STRENGTH,
  DEFAULT_MASK_THRESHOLD,
  MAX_BLUR_RADIUS_FRACTION,
  MIN_BLUR_RADIUS_FRACTION,
  MASK_MAX_AGE_MS,
  MAX_CONSECUTIVE_SEGMENT_FAILURES,
  SEGMENTER_RETRY_DELAYS_MS,
  SEGMENTER_BACKOFF_RESET_STREAK,
  HOLE_FILL_CONFIDENCE,
  MaskSmoother,
  STENCIL_ERODE_PX,
  VideoEffect,
  blurRadiusPx,
  clampStrength,
  coverRect,
  decideFrameAction,
  fillMaskHoles,
  maskToAlpha,
  type CanvasLike,
  type Context2DLike,
  type EffectMode,
  type FrameAction,
  type ImageDataLike,
  type SegmentationMask,
  type Segmenter,
} from './video-effects.js'

// ---------------------------------------------------------------------------
// Doubles
//
// The whole point of the interface split is that none of this needs WASM, a
// GPU or a browser: a canvas is a list of the operations someone asked for,
// and a segmenter is a function returning an array of numbers.
// ---------------------------------------------------------------------------

interface RecordedOp {
  op: 'drawImage' | 'clearRect' | 'putImageData' | 'fillRect'
  image?: unknown
  filter: string
  gco: string
  args: number[]
}

class FakeContext implements Context2DLike {
  filter = 'none'
  globalCompositeOperation = 'source-over'
  imageSmoothingEnabled = true
  imageSmoothingQuality = 'low'
  fillStyle = '#000'
  readonly ops: RecordedOp[] = []

  constructor(readonly owner: FakeCanvas) {}

  #record(op: RecordedOp['op'], args: number[], image?: unknown): void {
    this.ops.push({ op, image, filter: this.filter, gco: this.globalCompositeOperation, args })
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.#record('clearRect', [x, y, w, h])
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.#record('fillRect', [x, y, w, h])
  }

  drawImage(image: unknown, ...args: number[]): void {
    this.#record('drawImage', args, image)
  }

  putImageData(image: unknown, dx: number, dy: number): void {
    this.#record('putImageData', [dx, dy], image)
  }

  createImageData(w: number, h: number): ImageDataLike {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  }
}

class FakeCanvas implements CanvasLike {
  readonly ctx: FakeContext
  constructor(
    public width: number,
    public height: number,
    readonly label: string,
  ) {
    this.ctx = new FakeContext(this)
  }
  getContext(_id: '2d'): Context2DLike | null {
    return this.ctx
  }
}

function fakeCanvasFactory(): { create: (w: number, h: number) => CanvasLike; made: FakeCanvas[] } {
  const made: FakeCanvas[] = []
  return {
    made,
    create(w, h) {
      const c = new FakeCanvas(w, h, `scratch${made.length}`)
      made.push(c)
      return c
    },
  }
}

/** A mask that says "everything is foreground", which is enough to prove the
 *  compositing path ran without asserting anything about segmentation. */
function fullMask(w = 8, h = 8, value = 1): SegmentationMask {
  return { width: w, height: h, data: new Float32Array(w * h).fill(value) }
}

class FakeSegmenter implements Segmenter {
  mask: SegmentationMask | null = fullMask()
  throws: Error | null = null
  closed = false
  calls = 0
  segment(): SegmentationMask | null {
    this.calls += 1
    if (this.throws) throw this.throws
    return this.mask
  }
  close(): void {
    this.closed = true
  }
}

const SOURCE = { source: true }

function newEffect(
  opts: {
    segmenter?: Segmenter | null
    loadError?: Error
    mode?: EffectMode
  } = {},
): {
  effect: VideoEffect
  out: FakeCanvas
  factory: ReturnType<typeof fakeCanvasFactory>
  seg: FakeSegmenter | null
  loadCalls: () => number
} {
  const out = new FakeCanvas(320, 240, 'out')
  const factory = fakeCanvasFactory()
  const seg = opts.segmenter === null ? null : ((opts.segmenter as FakeSegmenter) ?? new FakeSegmenter())
  let loadCalls = 0
  const effect = new VideoEffect({
    output: out,
    createCanvas: factory.create,
    loadSegmenter: async () => {
      loadCalls += 1
      if (opts.loadError) throw opts.loadError
      if (!seg) throw new Error('no segmenter')
      return seg
    },
    mode: opts.mode,
  })
  return { effect, out, factory, seg, loadCalls: () => loadCalls }
}

/** Frames the effect painted straight from the camera with no filter: the
 *  thing that must never happen while an effect is meant to be on. */
function rawSourcePaints(ctx: FakeContext): RecordedOp[] {
  return ctx.ops.filter(
    (o) => o.op === 'drawImage' && o.image === SOURCE && o.filter === 'none' && o.gco === 'source-over',
  )
}

// ---------------------------------------------------------------------------

describe('strength bounds', () => {
  it('clamps below, above and either side of the range', () => {
    expect(clampStrength(0)).toBe(0)
    expect(clampStrength(1)).toBe(1)
    expect(clampStrength(0.5)).toBe(0.5)
    expect(clampStrength(-3)).toBe(0)
    expect(clampStrength(9)).toBe(1)
  })

  it('falls back to the default for anything that is not a number', () => {
    expect(clampStrength(Number.NaN)).toBe(DEFAULT_BLUR_STRENGTH)
    expect(clampStrength(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampStrength(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(clampStrength(undefined as unknown as number)).toBe(DEFAULT_BLUR_STRENGTH)
  })

  it('never yields a radius of zero, so the weakest blur is still a blur', () => {
    expect(blurRadiusPx(0, 640)).toBeGreaterThanOrEqual(2)
    expect(blurRadiusPx(-5, 640)).toBeGreaterThanOrEqual(2)
  })

  it('scales the radius with the frame width so it looks the same at any size', () => {
    const small = blurRadiusPx(1, 640)
    const large = blurRadiusPx(1, 1280)
    expect(large).toBeGreaterThan(small)
    expect(small / 640).toBeCloseTo(MAX_BLUR_RADIUS_FRACTION, 2)
    expect(blurRadiusPx(0, 640) / 640).toBeCloseTo(MIN_BLUR_RADIUS_FRACTION, 2)
  })

  it('is monotonic in strength', () => {
    let previous = -1
    for (let s = 0; s <= 1; s += 0.1) {
      const r = blurRadiusPx(s, 1280)
      expect(r).toBeGreaterThanOrEqual(previous)
      previous = r
    }
  })
})

describe('mask to alpha', () => {
  it('turns confidence into an alpha channel, opaque where the person is', () => {
    const mask: SegmentationMask = { width: 2, height: 1, data: new Float32Array([0, 1]) }
    const out = new Uint8ClampedArray(2 * 1 * 4)
    maskToAlpha(mask, out)
    expect(out[3]).toBe(0)
    expect(out[7]).toBe(255)
  })

  it('feathers the edge rather than cutting a hard outline', () => {
    const mask: SegmentationMask = {
      width: 5,
      height: 1,
      data: new Float32Array([0.2, 0.4, 0.5, 0.6, 0.8]),
    }
    const out = new Uint8ClampedArray(5 * 4)
    maskToAlpha(mask, out, { threshold: 0.5, feather: 0.5 })
    const alphas = [out[3], out[7], out[11], out[15], out[19]]
    expect(alphas[0]).toBe(0)
    expect(alphas[2]).toBeGreaterThan(100)
    expect(alphas[2]).toBeLessThan(160)
    expect(alphas[4]).toBe(255)
    for (let i = 1; i < alphas.length; i += 1) {
      expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!)
    }
  })

  it('writes white so the mask is also legible as a picture', () => {
    const out = new Uint8ClampedArray(4)
    maskToAlpha({ width: 1, height: 1, data: new Float32Array([1]) }, out)
    expect([out[0], out[1], out[2]]).toEqual([255, 255, 255])
  })

  it('rejects an output buffer that is the wrong size', () => {
    expect(() => maskToAlpha(fullMask(4, 4), new Uint8ClampedArray(8))).toThrow(/size/i)
  })
})

describe('decideFrameAction', () => {
  it('passes the camera through untouched only when the effect is off - never because something broke', () => {
    const modes: EffectMode[] = ['off', 'blur', 'replace']
    const flags = [true, false]
    for (const mode of modes) {
      for (const degraded of flags) {
        for (const maskReady of flags) {
          const action = decideFrameAction({ mode, degraded, maskReady })
          if (action === 'passthrough') {
            expect(mode).toBe('off')
          }
        }
      }
    }
  })

  it('blurs the whole frame in blur mode whenever the mask cannot be trusted', () => {
    expect(decideFrameAction({ mode: 'blur', degraded: false, maskReady: false })).toBe('blur-all')
    expect(decideFrameAction({ mode: 'blur', degraded: true, maskReady: false })).toBe('blur-all')
    // Degraded outranks a leftover maskReady flag: a broken segmenter is not
    // trusted just because the last mask it produced still looks recent.
    expect(decideFrameAction({ mode: 'blur', degraded: true, maskReady: true })).toBe('blur-all')
  })

  it('covers with the backdrop alone in replace mode whenever the mask cannot be trusted', () => {
    expect(decideFrameAction({ mode: 'replace', degraded: false, maskReady: false })).toBe('cover')
    expect(decideFrameAction({ mode: 'replace', degraded: true, maskReady: false })).toBe('cover')
    expect(decideFrameAction({ mode: 'replace', degraded: true, maskReady: true })).toBe('cover')
  })

  it('composites once a mask is ready and nothing is degraded', () => {
    expect(decideFrameAction({ mode: 'blur', degraded: false, maskReady: true })).toBe('composite')
    expect(decideFrameAction({ mode: 'replace', degraded: false, maskReady: true })).toBe('composite')
  })
})

describe('VideoEffect defaults', () => {
  it('starts blurred, because the failure mode of the other default is a published room', () => {
    expect(BLUR_ON_BY_DEFAULT).toBe(true)
    const { effect } = newEffect()
    expect(effect.mode).toBe('blur')
    expect(effect.strength).toBe(DEFAULT_BLUR_STRENGTH)
  })

  it('does not load the segmenter until an effect is actually wanted', async () => {
    const { effect, loadCalls } = newEffect({ mode: 'off' })
    expect(loadCalls()).toBe(0)
    effect.setMode('blur')
    expect(loadCalls()).toBe(1)
    effect.setMode('replace')
    expect(loadCalls()).toBe(1)
  })
})

describe('VideoEffect with an invalid frame size', () => {
  it('paints nothing at all while the effect is on, rather than a passthrough no-op', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    const action = effect.renderFrame(SOURCE, 0, 0, 0)
    expect(action).not.toBe('passthrough')
    expect(out.ctx.ops).toHaveLength(0)
  })

  it('still passes the frame through when the effect is off, size or not', () => {
    const { effect, out } = newEffect({ mode: 'off' })
    expect(effect.renderFrame(SOURCE, 0, 0, 0)).toBe('passthrough')
    expect(rawSourcePaints(out.ctx)).toHaveLength(1)
  })
})

describe('VideoEffect rendering', () => {
  it('composites the person over a blurred copy of the frame', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    const action = effect.renderFrame(SOURCE, 320, 240, 0)
    expect(action).toBe('composite')

    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    // Background first, blurred, then the cut-out person unfiltered on top.
    expect(draws[0]!.image).toBe(SOURCE)
    expect(draws[0]!.filter).toMatch(/^blur\(\d+px\)$/)
    expect(draws[1]!.image).not.toBe(SOURCE)
    expect(draws[1]!.filter).toBe('none')
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('cuts the person out with destination-in, not by painting over the frame', async () => {
    const { effect, factory } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 320, 240, 0)
    const person = factory.made.find((c) => c.ctx.ops.some((o) => o.gco === 'destination-in'))
    expect(person).toBeDefined()
    const cut = person!.ctx.ops.find((o) => o.gco === 'destination-in')!
    expect(cut.op).toBe('drawImage')
    expect(cut.image).not.toBe(SOURCE)
  })

  it('draws the replacement background instead of the blurred frame in replace mode', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    const background = { background: true }
    effect.setMode('replace')
    effect.setBackground(background)
    effect.renderFrame(SOURCE, 320, 240, 0)
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.image).toBe(background)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('falls back to blur when replace is asked for with no background loaded', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    effect.setMode('replace')
    effect.renderFrame(SOURCE, 320, 240, 0)
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.image).toBe(SOURCE)
    expect(draws[0]!.filter).toMatch(/^blur\(/)
  })

  it('passes the frame through untouched when the effect is off', () => {
    const { effect, out } = newEffect({ mode: 'off' })
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('passthrough')
    expect(rawSourcePaints(out.ctx)).toHaveLength(1)
  })

  it('resizes the output canvas to the source', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 640, 360, 0)
    expect(out.width).toBe(640)
    expect(out.height).toBe(360)
  })

  it('overdraws the blurred background so the blur does not bleed the edges in', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 320, 240, 0)
    const bg = out.ctx.ops.find((o) => o.op === 'drawImage' && o.filter.startsWith('blur('))!
    const [dx, dy, dw, dh] = bg.args
    expect(dx).toBeLessThan(0)
    expect(dy).toBeLessThan(0)
    expect(dw!).toBeGreaterThan(320)
    expect(dh!).toBeGreaterThan(240)
  })
})

describe('VideoEffect failure behaviour', () => {
  it('fails closed to a maximum-strength blur, never passthrough, when the segmenter will not load', async () => {
    const { effect, out } = newEffect({ loadError: new Error('wasm did not arrive') })
    await effect.ready()
    expect(effect.status).toBe('degraded')
    expect(effect.lastError).toMatch(/wasm did not arrive/)
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('blur-all')
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.filter).toMatch(/^blur\(/)
    effect.close()
  })

  it('fails closed to a cover frame, never passthrough, in replace mode when the segmenter will not load', async () => {
    const { effect, out } = newEffect({ loadError: new Error('wasm did not arrive'), mode: 'replace' })
    await effect.ready()
    const background = { background: true }
    effect.setBackground(background)
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('cover')
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0]!.image).toBe(background)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    effect.close()
  })

  it('clears the canvas to opaque black before drawing the backdrop, so a stale frame can never show through', async () => {
    const { effect, out } = newEffect({ loadError: new Error('wasm did not arrive'), mode: 'replace' })
    await effect.ready()
    const background = { background: true }
    effect.setBackground(background)
    effect.renderFrame(SOURCE, 320, 240, 0)

    const clear = out.ctx.ops.find((o) => o.op === 'clearRect')
    const fill = out.ctx.ops.find((o) => o.op === 'fillRect')
    const draw = out.ctx.ops.find((o) => o.op === 'drawImage' && o.image === background)
    expect(clear).toBeDefined()
    expect(clear!.args).toEqual([0, 0, 320, 240])
    expect(fill).toBeDefined()
    expect(fill!.args).toEqual([0, 0, 320, 240])
    expect(out.ctx.fillStyle).toBe('#000')
    // Opaque base, then the backdrop, in that order - never the other way
    // round, and never skipped.
    expect(out.ctx.ops.indexOf(clear!)).toBeLessThan(out.ctx.ops.indexOf(fill!))
    expect(out.ctx.ops.indexOf(fill!)).toBeLessThan(out.ctx.ops.indexOf(draw!))
  })

  it('falls back to a maximum-strength blur in replace mode with no backdrop loaded either', async () => {
    const { effect, out } = newEffect({ loadError: new Error('wasm did not arrive'), mode: 'replace' })
    await effect.ready()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('blur-all')
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.filter).toMatch(/^blur\(/)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    effect.close()
  })

  it('blurs everything while the segmenter is still loading', () => {
    const { effect, out } = newEffect()
    // No await: the model is still in flight, which is the common case for
    // the first second or so after someone turns the camera on.
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('blur-all')
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0]!.filter).toMatch(/^blur\(/)
  })

  it('tolerates a few throwing frames before giving up, and blurs meanwhile', async () => {
    const { effect, seg, out } = newEffect()
    await effect.ready()
    seg!.throws = new Error('lost the GPU context')
    for (let i = 0; i < MAX_CONSECUTIVE_SEGMENT_FAILURES - 1; i += 1) {
      expect(effect.renderFrame(SOURCE, 320, 240, i)).toBe('blur-all')
    }
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    expect(effect.status).toBe('ready')
  })

  it('degrades to a maximum-strength blur, never passthrough, once the segmenter keeps throwing', async () => {
    const { effect, seg, out } = newEffect()
    await effect.ready()
    seg!.throws = new Error('lost the GPU context')
    let action: FrameAction = 'composite'
    for (let i = 0; i <= MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
      action = effect.renderFrame(SOURCE, 320, 240, i)
    }
    expect(action).toBe('blur-all')
    expect(effect.status).toBe('degraded')
    expect(effect.lastError).toMatch(/lost the GPU context/)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    expect(seg!.closed).toBe(true)
    effect.close()
  })

  it('degrades to a cover frame, never passthrough, in replace mode once the segmenter keeps throwing', async () => {
    const { effect, seg, out } = newEffect({ mode: 'replace' })
    await effect.ready()
    const background = { background: true }
    effect.setBackground(background)
    seg!.throws = new Error('lost the GPU context')
    let action: FrameAction = 'composite'
    for (let i = 0; i <= MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
      action = effect.renderFrame(SOURCE, 320, 240, i)
    }
    expect(action).toBe('cover')
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[draws.length - 1]!.image).toBe(background)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
    effect.close()
  })

  it('retries the segmenter with backoff and recovers once it succeeds', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let attempt = 0
      let seg: FakeSegmenter | null = null
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('first attempt fails')
          seg = new FakeSegmenter()
          return seg
        },
      })
      await effect.ready()
      expect(effect.status).toBe('degraded')
      expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('blur-all')
      expect(attempt).toBe(1)

      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]!)
      await effect.ready()
      expect(attempt).toBe(2)
      expect(effect.status).toBe('ready')
      expect(effect.renderFrame(SOURCE, 320, 240, 1)).toBe('composite')
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off further on a second failed retry rather than hammering the loader', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let attempt = 0
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          attempt += 1
          throw new Error(`attempt ${attempt} fails`)
        },
      })
      await effect.ready()
      expect(attempt).toBe(1)

      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]!)
      await effect.ready()
      expect(attempt).toBe(2)

      // Not yet due for the third attempt at the first delay again.
      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]! - 1)
      expect(attempt).toBe(2)

      await vi.advanceTimersByTimeAsync(
        SEGMENTER_RETRY_DELAYS_MS[1]! - (SEGMENTER_RETRY_DELAYS_MS[0]! - 1),
      )
      await effect.ready()
      expect(attempt).toBe(3)
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps escalating backoff when the segmenter loads fine but segment() always throws', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let loads = 0
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          loads += 1
          const seg = new FakeSegmenter()
          seg.throws = new Error('lost the GPU context')
          return seg
        },
      })
      await effect.ready()
      expect(loads).toBe(1)
      expect(effect.status).toBe('ready')

      for (let i = 0; i < MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
        effect.renderFrame(SOURCE, 320, 240, i)
      }
      expect(effect.status).toBe('degraded')

      // First retry: the shortest delay, and it loads - but throws again at
      // once, which is not the same thing as having recovered.
      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]!)
      await effect.ready()
      expect(loads).toBe(2)
      expect(effect.status).toBe('ready')

      for (let i = 0; i < MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
        effect.renderFrame(SOURCE, 320, 240, 100 + i)
      }
      expect(effect.status).toBe('degraded')

      // A load succeeding must not have reset the backoff: the second retry
      // is due at the *second* delay, not the first one again.
      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]! - 1)
      expect(loads).toBe(2)

      await vi.advanceTimersByTimeAsync(
        SEGMENTER_RETRY_DELAYS_MS[1]! - (SEGMENTER_RETRY_DELAYS_MS[0]! - 1),
      )
      await effect.ready()
      expect(loads).toBe(3)
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the backoff level after a sustained run of good frames', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let loads = 0
      let seg: FakeSegmenter | null = null
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          loads += 1
          seg = new FakeSegmenter()
          if (loads === 1) seg.throws = new Error('first load is bad')
          return seg
        },
      })
      await effect.ready()
      for (let i = 0; i < MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
        effect.renderFrame(SOURCE, 320, 240, i)
      }
      expect(effect.status).toBe('degraded')

      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]!)
      await effect.ready()
      expect(loads).toBe(2)
      expect(effect.status).toBe('ready')

      // A long run of genuinely good frames - well past the reset streak.
      for (let i = 0; i < SEGMENTER_BACKOFF_RESET_STREAK + 5; i += 1) {
        expect(effect.renderFrame(SOURCE, 320, 240, 1000 + i)).toBe('composite')
      }

      // Degrades again, and this time the retry is due back at the first,
      // shortest delay: sustained use earned the backoff level back.
      seg!.throws = new Error('broke again')
      for (let i = 0; i < MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
        effect.renderFrame(SOURCE, 320, 240, 2000 + i)
      }
      expect(effect.status).toBe('degraded')

      await vi.advanceTimersByTimeAsync(SEGMENTER_RETRY_DELAYS_MS[0]! - 1)
      expect(loads).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      await effect.ready()
      expect(loads).toBe(3)
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying once the effect is turned off, and does not retry once closed', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let attempt = 0
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          attempt += 1
          throw new Error('always fails')
        },
      })
      await effect.ready()
      expect(attempt).toBe(1)
      effect.setMode('off')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempt).toBe(1)
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers immediately on turning the effect off and back on again, rather than staying degraded for the session', async () => {
    vi.useFakeTimers()
    try {
      const out = new FakeCanvas(320, 240, 'out')
      const factory = fakeCanvasFactory()
      let attempt = 0
      let seg: FakeSegmenter | null = null
      const effect = new VideoEffect({
        output: out,
        createCanvas: factory.create,
        loadSegmenter: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('first attempt fails')
          seg = new FakeSegmenter()
          return seg
        },
      })
      await effect.ready()
      expect(effect.status).toBe('degraded')
      expect(attempt).toBe(1)

      // Off, then straight back on - the thing the failure notice itself
      // tells somebody to do - with no time advanced at all: no waiting for
      // whatever backoff attempt the timer was on.
      effect.setMode('off')
      effect.setMode('blur')
      await effect.ready()
      expect(attempt).toBe(2)
      expect(effect.status).toBe('ready')
      expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
      effect.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers if a single frame throws and the next one works', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    seg!.throws = new Error('transient')
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('blur-all')
    seg!.throws = null
    expect(effect.renderFrame(SOURCE, 320, 240, 1)).toBe('composite')
    expect(effect.renderFrame(SOURCE, 320, 240, 2)).toBe('composite')
    expect(effect.status).toBe('ready')
  })

  it('reports state changes so the UI can say what happened', async () => {
    const onStateChange = vi.fn()
    const out = new FakeCanvas(320, 240, 'out')
    const factory = fakeCanvasFactory()
    const effect = new VideoEffect({
      output: out,
      createCanvas: factory.create,
      loadSegmenter: async () => {
        throw new Error('offline')
      },
      onStateChange,
    })
    await effect.ready()
    expect(onStateChange).toHaveBeenCalled()
    const states = onStateChange.mock.calls.map((c) => (c[0] as { status: string }).status)
    expect(states).toContain('loading')
    expect(states).toContain('degraded')
    // Cancels the retry backoff this schedules, so no real timer is left
    // running past the end of the test.
    effect.close()
  })
})

describe('VideoEffect across a camera flip', () => {
  it('never publishes an unblurred frame while the source is being swapped', async () => {
    const { effect, out, seg } = newEffect()
    await effect.ready()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')

    // The flip: the app tells the effect its source is about to change, and
    // the new camera has not produced a mask yet.
    effect.invalidateSource()
    seg!.mask = null
    for (let i = 1; i < 20; i += 1) {
      expect(effect.renderFrame(SOURCE, 640, 480, i)).toBe('blur-all')
    }
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)

    seg!.mask = fullMask()
    expect(effect.renderFrame(SOURCE, 640, 480, 21)).toBe('composite')
  })

  it('does not reuse the previous camera mask on the new camera', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 320, 240, 0)
    seg!.mask = null
    // Without an invalidate, holding the last mask for a frame or two is fine.
    expect(effect.renderFrame(SOURCE, 320, 240, 1)).toBe('composite')
    // With one, it is not: the mask belonged to the camera that just went away.
    effect.invalidateSource()
    expect(effect.renderFrame(SOURCE, 320, 240, 2)).toBe('blur-all')
  })

  it('keeps the effect on across a flip even if the mode was changed mid-swap', async () => {
    const { effect, out, seg } = newEffect()
    await effect.ready()
    effect.invalidateSource()
    seg!.mask = null
    effect.setMode('replace')
    effect.renderFrame(SOURCE, 320, 240, 1)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })
})

describe('VideoEffect mask staleness', () => {
  it('keeps compositing on a held mask within MASK_MAX_AGE_MS', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
    seg!.mask = null
    expect(effect.renderFrame(SOURCE, 320, 240, MASK_MAX_AGE_MS)).toBe('composite')
  })

  it('falls back to a maximum-strength blur once the held mask goes stale', async () => {
    const { effect, seg, out } = newEffect()
    await effect.ready()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
    seg!.mask = null
    expect(effect.renderFrame(SOURCE, 320, 240, MASK_MAX_AGE_MS + 1)).toBe('blur-all')
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('covers with the backdrop, not the composite, once a held mask goes stale in replace mode', async () => {
    const { effect, seg, out } = newEffect({ mode: 'replace' })
    await effect.ready()
    const background = { background: true }
    effect.setBackground(background)
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
    seg!.mask = null
    expect(effect.renderFrame(SOURCE, 320, 240, MASK_MAX_AGE_MS + 1)).toBe('cover')
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[draws.length - 1]!.image).toBe(background)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('is fresh again the moment a new mask arrives', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
    seg!.mask = null
    expect(effect.renderFrame(SOURCE, 320, 240, MASK_MAX_AGE_MS + 1)).toBe('blur-all')
    seg!.mask = fullMask()
    expect(effect.renderFrame(SOURCE, 320, 240, MASK_MAX_AGE_MS + 2)).toBe('composite')
  })
})

describe('VideoEffect teardown', () => {
  it('closes the segmenter so the WASM heap goes with it', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    effect.close()
    expect(seg!.closed).toBe(true)
  })

  it('is inert after close rather than throwing into a render loop', async () => {
    const { effect } = newEffect()
    await effect.ready()
    effect.close()
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('passthrough')
  })
})

describe('coverRect', () => {
  it('fills the frame without distorting a wider image', () => {
    const r = coverRect(1920, 1080, 640, 640)
    expect(r.dh).toBeCloseTo(640, 5)
    expect(r.dw).toBeCloseTo((1920 / 1080) * 640, 5)
    expect(r.dx).toBeLessThan(0)
    expect(r.dy).toBeCloseTo(0, 5)
  })

  it('fills the frame without distorting a taller image', () => {
    const r = coverRect(1080, 1920, 640, 360)
    expect(r.dw).toBeCloseTo(640, 5)
    expect(r.dh).toBeGreaterThan(360)
    expect(r.dy).toBeLessThan(0)
  })

  it('keeps the aspect ratio of the source in every case', () => {
    for (const [sw, sh] of [
      [16, 9],
      [9, 16],
      [1, 1],
      [1920, 1080],
    ] as const) {
      const r = coverRect(sw, sh, 800, 450)
      expect(r.dw / r.dh).toBeCloseTo(sw / sh, 6)
      expect(r.dw).toBeGreaterThanOrEqual(800 - 1e-9)
      expect(r.dh).toBeGreaterThanOrEqual(450 - 1e-9)
    }
  })

  it('degrades to a stretch rather than dividing by zero', () => {
    expect(coverRect(0, 0, 320, 240)).toEqual({ dx: 0, dy: 0, dw: 320, dh: 240 })
  })
})

describe('MaskSmoother', () => {
  const mask = (data: number[], width = data.length, height = 1): SegmentationMask => ({
    width,
    height,
    data: new Float32Array(data),
  })

  it('takes the first frame as it is, so the person does not fade in', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    const out = smoother.push(mask([0, 0.5, 1]))
    expect(Array.from(out.data)).toEqual([0, 0.5, 1])
  })

  it('damps a pixel that is flickering about the threshold', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    smoother.push(mask([0.5]))
    // The thing the edge actually does: 0.45, 0.55, 0.45, 0.55 for ever.
    let worst = 0
    for (let i = 0; i < 12; i += 1) {
      const value = smoother.push(mask([i % 2 === 0 ? 0.45 : 0.55])).data[0]!
      worst = Math.max(worst, Math.abs(value - 0.5))
    }
    // The raw signal swings 0.05 either side; smoothed it must sit well
    // inside that, or the edge still crawls.
    expect(worst).toBeLessThan(0.025)
  })

  it('follows a pixel the person has actually moved into, in one frame', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    smoother.push(mask([0]))
    expect(smoother.push(mask([1])).data[0]!).toBeGreaterThan(0.95)
  })

  it('converges on a value that has stopped changing', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    smoother.push(mask([0]))
    for (let i = 0; i < 40; i += 1) smoother.push(mask([0.8]))
    expect(smoother.push(mask([0.8])).data[0]!).toBeCloseTo(0.8, 3)
  })

  it('forgets everything on reset, so a swap is not averaged across', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    smoother.push(mask([1]))
    smoother.reset()
    expect(smoother.push(mask([0])).data[0]).toBe(0)
  })

  it('starts again when the mask changes size rather than reading off the end', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    smoother.push(mask([1, 1, 1, 1]))
    const out = smoother.push(mask([0, 0.25, 0.5, 0.75, 1, 1, 1, 1, 1], 3, 3))
    expect(out.width).toBe(3)
    expect(out.data[0]).toBe(0)
  })

  it('pulls the person edge in rather than leaving a fringe of the room', () => {
    const smoother = new MaskSmoother({ erode: 1 })
    // A person occupying the middle three of five columns.
    const out = smoother.push(mask([0, 1, 1, 1, 0]))
    expect(Array.from(out.data)).toEqual([0, 0, 1, 0, 0])
  })

  it('does not eat a person standing at the edge of the frame', () => {
    const smoother = new MaskSmoother({ erode: 1 })
    const out = smoother.push(mask([1, 1, 1, 0, 0]))
    // Nothing outside the frame is treated as background to erode by.
    expect(out.data[0]).toBe(1)
  })

  it('erodes in both directions, not only across', () => {
    const smoother = new MaskSmoother({ erode: 1 })
    const out = smoother.push(mask([0, 0, 0, 0, 1, 0, 0, 0, 0], 3, 3))
    expect(Array.from(out.data)).toEqual(new Array(9).fill(0))
  })
})

describe('MaskSmoother hole filling', () => {
  const mask2d = (rows: number[][]): SegmentationMask => {
    const height = rows.length
    const width = rows[0]!.length
    const data = new Float32Array(width * height)
    rows.forEach((row, y) => row.forEach((v, x) => {
      data[y * width + x] = v
    }))
    return { width, height, data }
  }
  const rows2d = (m: SegmentationMask): number[][] => {
    const out: number[][] = []
    for (let y = 0; y < m.height; y += 1) {
      out.push(Array.from(m.data.subarray(y * m.width, y * m.width + m.width)))
    }
    return out
  }

  it('fills an enclosed low-confidence island, surrounded on every side by person', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    const out = smoother.push(
      mask2d([
        [1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1],
        [1, 1, 0.2, 1, 1],
        [1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1],
      ]),
    )
    expect(out.data[2 * 5 + 2]).toBeCloseTo(HOLE_FILL_CONFIDENCE, 5)
  })

  it('leaves a low-confidence region alone once it reaches the frame edge', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    const rows = [
      [0, 0, 0, 0, 0],
      [1, 1, 0, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 1, 1],
    ]
    const out = smoother.push(mask2d(rows))
    expect(rows2d(out)).toEqual(rows)
  })

  it('leaves a feathered outline byte-identical, since it is connected to the edge', () => {
    // A ramp from background (left, touching the frame edge) through the
    // feather band up to person (right), repeated down every row: exactly
    // what the true silhouette's edge looks like, and none of it should move.
    const smoother = new MaskSmoother({ erode: 0 })
    const row = [0.1, 0.3, 0.48, 0.6, 0.9]
    const rows = [row, row, row, row, row]
    const before = rows.map((r) => Array.from(new Float32Array(r)))
    const out = smoother.push(mask2d(rows))
    expect(rows2d(out)).toEqual(before)
  })

  it('does not fill an enclosed region larger than the 12% cap', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    const rows: number[][] = Array.from({ length: 10 }, () => Array(10).fill(1))
    for (let y = 3; y < 7; y += 1) {
      for (let x = 3; x < 7; x += 1) rows[y]![x] = 0.1
    }
    const before = rows.map((r) => Array.from(new Float32Array(r)))
    const out = smoother.push(mask2d(rows))
    expect(rows2d(out)).toEqual(before)
  })

  it('fills a ring-shaped enclosed region right at the 12% cap', () => {
    const smoother = new MaskSmoother({ erode: 0 })
    const rows: number[][] = Array.from({ length: 10 }, () => Array(10).fill(1))
    // The perimeter of a 4x4 block: 12 cells, exactly floor(100 * 0.12).
    const cells: Array<[number, number]> = [
      [3, 3], [3, 4], [3, 5], [3, 6],
      [4, 3], [4, 6],
      [5, 3], [5, 6],
      [6, 3], [6, 4], [6, 5], [6, 6],
    ]
    for (const [y, x] of cells) rows[y]![x] = 0.1
    const out = smoother.push(mask2d(rows))
    for (const [y, x] of cells) {
      expect(out.data[y * 10 + x]).toBeCloseTo(HOLE_FILL_CONFIDENCE, 5)
    }
  })

  it('can be turned off for a test measuring what it costs on its own', () => {
    const smoother = new MaskSmoother({ erode: 0, holeFill: false })
    const out = smoother.push(
      mask2d([
        [1, 1, 1],
        [1, 0.2, 1],
        [1, 1, 1],
      ]),
    )
    expect(out.data[4]).toBeCloseTo(0.2, 5)
  })

  it('applies hole filling to the output only, never the stored temporal state', () => {
    const withFill = new MaskSmoother({ erode: 0 })
    const withoutFill = new MaskSmoother({ erode: 0, holeFill: false })

    const enclosed = mask2d([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 0.2, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ])
    withFill.push(enclosed)
    withoutFill.push(enclosed)

    // Frame two opens a path to the edge along the whole middle row, with a
    // different value at the same pixel: the blend this frame produces
    // depends on frame one's *true* confidence there, not on the 0.9 frame
    // one's output displayed for it. If hole filling had corrupted the
    // stored state, this frame's result would follow the filled 0.9
    // instead and the two smoothers would disagree.
    const opened = mask2d([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [0.5, 0.5, 0.5, 0.5, 0.5],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ])
    const outWith = withFill.push(opened)
    const outWithout = withoutFill.push(opened)

    expect(outWith.data[2 * 5 + 2]).toBeCloseTo(outWithout.data[2 * 5 + 2]!, 4)
  })
})

describe('fillMaskHoles performance', () => {
  it('costs well under a frame budget at a 256x256 mask', () => {
    const width = 256
    const height = 256
    const pixels = width * height
    const data = new Float32Array(pixels).fill(1)
    // Scattered isolated below-cut points, roughly the shape of the real
    // problem: small enclosed patches over a torso, not one giant blob.
    for (let i = 0; i < 60; i += 1) {
      const cx = 10 + ((i * 37) % (width - 20))
      const cy = 10 + ((i * 53) % (height - 20))
      data[cy * width + cx] = 0.3
    }
    const visited = new Uint8Array(pixels)
    const stack = new Int32Array(pixels)
    const runs = 20
    const start = performance.now()
    for (let i = 0; i < runs; i += 1) {
      fillMaskHoles(data, width, height, visited, stack, DEFAULT_MASK_THRESHOLD, HOLE_FILL_CONFIDENCE, 0.12)
    }
    const perFrameMs = (performance.now() - start) / runs
    // The module doc's target is "well under 1ms"; this asserts a generous
    // multiple of that so it does not flake on a loaded machine, while still
    // catching an accidental change from O(pixels) to something worse.
    expect(perFrameMs).toBeLessThan(8)
  })
})

describe('stencil erosion', () => {
  it('pulls the outline in with four offset destination-in draws', async () => {
    const { effect, factory } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 320, 240, 0)
    // The stencil is the canvas that had image data put into it.
    const stencil = factory.made.find((c) => c.ctx.ops.some((o) => o.op === 'putImageData'))
    expect(stencil).toBeDefined()
    const erosion = stencil!.ctx.ops.filter(
      (o) => o.op === 'drawImage' && o.gco === 'destination-in' && o.image === stencil,
    )
    expect(erosion).toHaveLength(4)
    // Left, right, up, down by the same amount, which is what makes the four
    // of them a separable minimum filter rather than a smear.
    const offsets = erosion.map((o) => [o.args[0], o.args[1]])
    expect(offsets).toEqual([
      [-STENCIL_ERODE_PX, 0],
      [STENCIL_ERODE_PX, 0],
      [0, -STENCIL_ERODE_PX],
      [0, STENCIL_ERODE_PX],
    ])
  })

  it('leaves the stencil context in source-over, so the next frame is not eaten', async () => {
    const { effect, factory } = newEffect()
    await effect.ready()
    effect.renderFrame(SOURCE, 320, 240, 0)
    const stencil = factory.made.find((c) => c.ctx.ops.some((o) => o.op === 'putImageData'))!
    expect(stencil.ctx.globalCompositeOperation).toBe('source-over')
  })
})

describe('VideoEffect with an animated background', () => {
  it('asks the source for a frame on every composited frame', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    const frames = [{ a: 1 }, { b: 2 }, { c: 3 }]
    let calls = 0
    effect.setMode('replace')
    effect.setBackgroundSource({
      frame: () => frames[calls++ % frames.length]!,
      size: () => null,
    })
    effect.renderFrame(SOURCE, 320, 240, 0)
    effect.renderFrame(SOURCE, 320, 240, 33)
    const drawn = out.ctx.ops.filter(
      (o) => o.op === 'drawImage' && frames.includes(o.image as (typeof frames)[number]),
    )
    expect(drawn).toHaveLength(2)
    expect(drawn[0]!.image).not.toBe(drawn[1]!.image)
  })

  it('passes the frame timestamp through, so the scene has a clock', async () => {
    const { effect } = newEffect()
    await effect.ready()
    const seen: number[] = []
    effect.setMode('replace')
    effect.setBackgroundSource({
      frame: (now) => {
        seen.push(now)
        return { image: true }
      },
      size: () => null,
    })
    effect.renderFrame(SOURCE, 320, 240, 1000)
    effect.renderFrame(SOURCE, 320, 240, 1033)
    expect(seen).toEqual([1000, 1033])
  })

  it('blurs rather than showing the room when the source hands back nothing', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    effect.setMode('replace')
    effect.setBackgroundSource({ frame: () => null, size: () => null })
    effect.renderFrame(SOURCE, 320, 240, 0)
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.filter).toMatch(/^blur\(/)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('blurs rather than showing the room when the source throws', async () => {
    const { effect, out } = newEffect()
    await effect.ready()
    effect.setMode('replace')
    effect.setBackgroundSource({
      frame: () => {
        throw new Error('the scene fell over')
      },
      size: () => null,
    })
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('composite')
    const draws = out.ctx.ops.filter((o) => o.op === 'drawImage')
    expect(draws[0]!.filter).toMatch(/^blur\(/)
    expect(rawSourcePaints(out.ctx)).toHaveLength(0)
  })

  it('closes the source it replaces, and its own on teardown', async () => {
    const { effect } = newEffect()
    await effect.ready()
    let closedFirst = false
    let closedSecond = false
    effect.setBackgroundSource({
      frame: () => null,
      size: () => null,
      close: () => {
        closedFirst = true
      },
    })
    effect.setBackgroundSource({
      frame: () => null,
      size: () => null,
      close: () => {
        closedSecond = true
      },
    })
    expect(closedFirst).toBe(true)
    effect.close()
    expect(closedSecond).toBe(true)
  })
})
