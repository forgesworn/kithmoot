import { describe, it, expect, vi } from 'vitest'
import {
  BLUR_ON_BY_DEFAULT,
  DEFAULT_BLUR_STRENGTH,
  MAX_BLUR_RADIUS_FRACTION,
  MIN_BLUR_RADIUS_FRACTION,
  MAX_CONSECUTIVE_SEGMENT_FAILURES,
  VideoEffect,
  blurRadiusPx,
  clampStrength,
  coverRect,
  decideFrameAction,
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
  it('passes the camera through untouched only when the effect is off or broken', () => {
    const modes: EffectMode[] = ['off', 'blur', 'replace']
    const flags = [true, false]
    for (const mode of modes) {
      for (const degraded of flags) {
        for (const maskReady of flags) {
          const action = decideFrameAction({ mode, degraded, maskReady })
          if (action === 'passthrough') {
            expect(mode === 'off' || degraded).toBe(true)
          }
        }
      }
    }
  })

  it('blurs the whole frame while an effect is on but no mask is ready', () => {
    expect(decideFrameAction({ mode: 'blur', degraded: false, maskReady: false })).toBe('blur-all')
    expect(decideFrameAction({ mode: 'replace', degraded: false, maskReady: false })).toBe('blur-all')
  })

  it('composites once a mask is ready', () => {
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
  it('falls back to passthrough, never a black frame, when the segmenter will not load', async () => {
    const { effect, out } = newEffect({ loadError: new Error('wasm did not arrive') })
    await effect.ready()
    expect(effect.status).toBe('degraded')
    expect(effect.lastError).toMatch(/wasm did not arrive/)
    expect(effect.renderFrame(SOURCE, 320, 240, 0)).toBe('passthrough')
    expect(rawSourcePaints(out.ctx)).toHaveLength(1)
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

  it('degrades to passthrough once the segmenter keeps throwing', async () => {
    const { effect, seg } = newEffect()
    await effect.ready()
    seg!.throws = new Error('lost the GPU context')
    let action: FrameAction = 'composite'
    for (let i = 0; i <= MAX_CONSECUTIVE_SEGMENT_FAILURES; i += 1) {
      action = effect.renderFrame(SOURCE, 320, 240, i)
    }
    expect(action).toBe('passthrough')
    expect(effect.status).toBe('degraded')
    expect(effect.lastError).toMatch(/lost the GPU context/)
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
