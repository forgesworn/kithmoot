import { describe, it, expect } from 'vitest'
import {
  FORCE_MAX_BLUR_LONG_EDGE_PX,
  SOLID_COVER_COLOUR,
  VideoEffect,
  blurRadiusPx,
  downscaleSize,
  downscaleSteps,
  probeBlurPath,
  probeDownscaleBlur,
  probeFilterBlur,
  type CanvasFactory,
  type CanvasLike,
  type Context2DLike,
  type ImageDataLike,
  type SegmentationMask,
  type Segmenter,
} from './video-effects.js'

// ---------------------------------------------------------------------------
// A canvas that really draws
//
// video-effects.test.ts records what was asked for; the question here is
// what came out, so this double keeps pixels. It does what a 2D context does
// with the handful of operations the effect uses: scaled `drawImage` (box
// average when shrinking with smoothing, bilinear when enlarging, nearest
// without), `source-over` and `destination-in`, `fillRect`, `putImageData`
// and `getImageData`. `filter` is a plain property, exactly as WebKit has
// it; whether a `blur(...)` in it does anything is the `filterBlurs` switch.
// ---------------------------------------------------------------------------

interface RasterOptions {
  /** Chromium, Firefox: true. WebKit: false, the filter is an expando. */
  filterBlurs: boolean
  /** A browser that draws nearest-neighbour whatever smoothing says. */
  ignoresSmoothing?: boolean
  /** `getImageData` throws, as on a lost context. */
  readbackThrows?: boolean
}

interface RasterDraw {
  image: unknown
  args: number[]
  filter: string
}

/** A camera frame: anything with pixels the raster can sample. */
interface RasterImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

function pixelsOf(image: unknown): RasterImage {
  if (image instanceof RasterCanvas) return image.pixels
  const candidate = image as RasterImage
  if (candidate && candidate.data instanceof Uint8ClampedArray) return candidate
  throw new Error('the raster cannot draw this')
}

class RasterCanvas implements CanvasLike {
  #width: number
  #height: number
  pixels: RasterImage
  readonly ctx: RasterContext

  constructor(width: number, height: number, opts: RasterOptions) {
    this.#width = width
    this.#height = height
    this.pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    this.ctx = new RasterContext(this, opts)
  }

  get width(): number {
    return this.#width
  }
  set width(value: number) {
    this.#width = value
    this.pixels = { width: value, height: this.#height, data: new Uint8ClampedArray(value * this.#height * 4) }
  }
  get height(): number {
    return this.#height
  }
  set height(value: number) {
    this.#height = value
    this.pixels = { width: this.#width, height: value, data: new Uint8ClampedArray(this.#width * value * 4) }
  }

  getContext(_id: '2d'): Context2DLike | null {
    return this.ctx
  }
}

function parseColour(style: unknown): [number, number, number] {
  const s = String(style)
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s)
  if (short) return [parseInt(short[1]! + short[1]!, 16), parseInt(short[2]! + short[2]!, 16), parseInt(short[3]! + short[3]!, 16)]
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  if (long) return [parseInt(long[1]!, 16), parseInt(long[2]!, 16), parseInt(long[3]!, 16)]
  throw new Error(`the raster does not parse ${s}`)
}

class RasterContext implements Context2DLike {
  filter = 'none'
  globalCompositeOperation = 'source-over'
  imageSmoothingEnabled = true
  imageSmoothingQuality = 'low'
  fillStyle: string | CanvasGradient | CanvasPattern = '#000'
  readonly draws: RasterDraw[] = []
  readonly fills: { colour: string; args: number[] }[] = []

  constructor(
    readonly owner: RasterCanvas,
    readonly opts: RasterOptions,
  ) {}

  clearRect(x: number, y: number, w: number, h: number): void {
    const { width, height, data } = this.owner.pixels
    for (let py = Math.max(0, y); py < Math.min(height, y + h); py++) {
      for (let px = Math.max(0, x); px < Math.min(width, x + w); px++) data.fill(0, (py * width + px) * 4, (py * width + px) * 4 + 4)
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ colour: String(this.fillStyle), args: [x, y, w, h] })
    const [r, g, b] = parseColour(this.fillStyle)
    const { width, height, data } = this.owner.pixels
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(height, Math.ceil(y + h)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(width, Math.ceil(x + w)); px++) {
        const i = (py * width + px) * 4
        data[i] = r
        data[i + 1] = g
        data[i + 2] = b
        data[i + 3] = 255
      }
    }
  }

  putImageData(image: ImageDataLike, dx: number, dy: number): void {
    const { width, height, data } = this.owner.pixels
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const tx = x + dx
        const ty = y + dy
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue
        for (let c = 0; c < 4; c++) data[(ty * width + tx) * 4 + c] = image.data[(y * image.width + x) * 4 + c]!
      }
    }
  }

  createImageData(width: number, height: number): ImageDataLike {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike {
    if (this.opts.readbackThrows) throw new Error('readback refused')
    const { width, data } = this.owner.pixels
    const out = new Uint8ClampedArray(sw * sh * 4)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        for (let c = 0; c < 4; c++) out[(y * sw + x) * 4 + c] = data[((y + sy) * width + (x + sx)) * 4 + c]!
      }
    }
    return { width: sw, height: sh, data: out }
  }

  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void {
    this.draws.push({ image, args: [dx, dy, dw, dh], filter: this.filter })
    const src = pixelsOf(image)
    const { width: W, height: H, data: dst } = this.owner.pixels
    // Premultiplied layer the size of this canvas.
    const layer = new Float64Array(W * H * 4)
    const smooth = this.imageSmoothingEnabled && !this.opts.ignoresSmoothing
    const at = (x: number, y: number, c: number): number => {
      const cx = Math.min(src.width - 1, Math.max(0, x))
      const cy = Math.min(src.height - 1, Math.max(0, y))
      const i = (cy * src.width + cx) * 4
      const a = src.data[i + 3]! / 255
      return c === 3 ? a : (src.data[i + c]! / 255) * a
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = ((x + 0.5 - dx) / dw) * src.width
        const v = ((y + 0.5 - dy) / dh) * src.height
        if (u < 0 || v < 0 || u >= src.width || v >= src.height) continue
        const o = (y * W + x) * 4
        if (smooth && (dw < src.width || dh < src.height)) {
          const x0 = Math.floor(((x - dx) / dw) * src.width)
          const x1 = Math.max(x0 + 1, Math.ceil(((x + 1 - dx) / dw) * src.width))
          const y0 = Math.floor(((y - dy) / dh) * src.height)
          const y1 = Math.max(y0 + 1, Math.ceil(((y + 1 - dy) / dh) * src.height))
          const n = (x1 - x0) * (y1 - y0)
          for (let c = 0; c < 4; c++) {
            let sum = 0
            for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += at(sx, sy, c)
            layer[o + c] = sum / n
          }
        } else if (smooth) {
          const fx = u - 0.5
          const fy = v - 0.5
          const ix = Math.floor(fx)
          const iy = Math.floor(fy)
          const tx = fx - ix
          const ty = fy - iy
          for (let c = 0; c < 4; c++) {
            layer[o + c] =
              at(ix, iy, c) * (1 - tx) * (1 - ty) +
              at(ix + 1, iy, c) * tx * (1 - ty) +
              at(ix, iy + 1, c) * (1 - tx) * ty +
              at(ix + 1, iy + 1, c) * tx * ty
          }
        } else {
          for (let c = 0; c < 4; c++) layer[o + c] = at(Math.floor(u), Math.floor(v), c)
        }
      }
    }

    const blur = /^blur\((\d+(?:\.\d+)?)px\)$/.exec(this.filter)
    if (blur && this.opts.filterBlurs) boxBlur(layer, W, H, Math.max(1, Math.round(Number(blur[1]))))

    for (let i = 0; i < W * H * 4; i += 4) {
      const la = layer[i + 3]!
      const da = dst[i + 3]! / 255
      if (this.globalCompositeOperation === 'destination-in') {
        dst[i + 3] = Math.round(da * la * 255)
        continue
      }
      const outA = la + da * (1 - la)
      for (let c = 0; c < 3; c++) {
        const premult = layer[i + c]! + (dst[i + c]! / 255) * da * (1 - la)
        dst[i + c] = outA > 0 ? Math.round((premult / outA) * 255) : 0
      }
      dst[i + 3] = Math.round(outA * 255)
    }
  }
}

/** Separable box blur over a premultiplied layer, outside counted as
 *  transparent, which is what a canvas blur does at its edges. */
function boxBlur(layer: Float64Array, w: number, h: number, r: number): void {
  const pass = (horizontal: boolean): void => {
    const copy = layer.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0
          for (let k = -r; k <= r; k++) {
            const sx = horizontal ? x + k : x
            const sy = horizontal ? y : y + k
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
            sum += copy[(sy * w + sx) * 4 + c]!
          }
          layer[(y * w + x) * 4 + c] = sum / (2 * r + 1)
        }
      }
    }
  }
  pass(true)
  pass(false)
}

function rasterFactory(opts: RasterOptions): { create: CanvasFactory; made: RasterCanvas[] } {
  const made: RasterCanvas[] = []
  return {
    made,
    create: (w, h) => {
      const canvas = new RasterCanvas(w, h, opts)
      made.push(canvas)
      return canvas
    },
  }
}

const SAFARI: RasterOptions = { filterBlurs: false }
const CHROMIUM: RasterOptions = { filterBlurs: true }

/** The camera: a one-pixel checkerboard on the left, a hard black/white
 *  edge on the right. Everything a blur exists to take away. */
function cameraFrame(width: number, height: number): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? ((x + y) % 2 === 0 ? 0 : 255) : y < height / 2 ? 0 : 255
      const i = (y * width + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

/** Largest step between neighbouring pixels: 255 for anything sharp. */
function sharpness(image: RasterImage): number {
  let max = 0
  const { width, height, data } = image
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (x + 1 < width) max = Math.max(max, Math.abs(data[i]! - data[i + 4]!))
      if (y + 1 < height) max = Math.max(max, Math.abs(data[i]! - data[i + width * 4]!))
    }
  }
  return max
}

const W = 64
const H = 48

function newEffect(opts: RasterOptions, segmenter?: Segmenter) {
  const factory = rasterFactory(opts)
  const out = new RasterCanvas(W, H, opts)
  const effect = new VideoEffect({
    output: out,
    createCanvas: factory.create,
    loadSegmenter: async () => {
      if (!segmenter) throw new Error('no segmenter in this build')
      return segmenter
    },
    mode: 'blur',
    maskSmoothing: false,
  })
  return { effect, out, factory }
}

// ---------------------------------------------------------------------------

describe('probeFilterBlur', () => {
  it('is false where the filter is an ignored expando, as in WebKit', () => {
    expect(probeFilterBlur(rasterFactory(SAFARI).create)).toBe(false)
  })

  it('is true where the filter blurs', () => {
    expect(probeFilterBlur(rasterFactory(CHROMIUM).create)).toBe(true)
  })

  it('is false, not a throw, when the readback throws', () => {
    expect(probeFilterBlur(rasterFactory({ filterBlurs: true, readbackThrows: true }).create)).toBe(false)
  })

  it('is false when the context has no readback at all', () => {
    const create: CanvasFactory = (w, h) => {
      const canvas = new RasterCanvas(w, h, CHROMIUM)
      const ctx = canvas.ctx as Partial<RasterContext>
      Object.defineProperty(ctx, 'getImageData', { value: undefined })
      return canvas
    }
    expect(probeFilterBlur(create)).toBe(false)
  })

  it('is false when the readback does not show what was drawn', () => {
    // Fingerprinting defences can hand back noise. A control that does not
    // read back as drawn means nothing the probe reads can be believed.
    const create: CanvasFactory = (w, h) => {
      const canvas = new RasterCanvas(w, h, CHROMIUM)
      canvas.ctx.getImageData = (_sx, _sy, sw, sh) => {
        const data = new Uint8ClampedArray(sw * sh * 4)
        for (let i = 0; i < data.length; i++) data[i] = (i * 97) % 256
        return { width: sw, height: sh, data }
      }
      return canvas
    }
    expect(probeFilterBlur(create)).toBe(false)
  })

  it('is false when a canvas will not take its size', () => {
    const create: CanvasFactory = (w, h) => {
      const canvas = new RasterCanvas(w, h, CHROMIUM)
      Object.defineProperty(canvas, 'width', { get: () => 1, set: () => {} })
      return canvas
    }
    expect(probeFilterBlur(create)).toBe(false)
  })
})

describe('probeDownscaleBlur', () => {
  it('is true with smoothing', () => {
    expect(probeDownscaleBlur(rasterFactory(SAFARI).create)).toBe(true)
  })

  it('is true when smoothing is ignored, because a mosaic is still not a picture', () => {
    expect(probeDownscaleBlur(rasterFactory({ filterBlurs: false, ignoresSmoothing: true }).create)).toBe(true)
  })

  it('is false when the readback throws', () => {
    expect(probeDownscaleBlur(rasterFactory({ filterBlurs: false, readbackThrows: true }).create)).toBe(false)
  })
})

describe('probeBlurPath', () => {
  it('chooses the filter where it blurs, the downscale where it does not, and solid where nothing can be shown', () => {
    expect(probeBlurPath(rasterFactory(CHROMIUM).create)).toBe('filter')
    expect(probeBlurPath(rasterFactory(SAFARI).create)).toBe('downscale')
    expect(probeBlurPath(rasterFactory({ filterBlurs: false, readbackThrows: true }).create)).toBe('solid')
  })

  it('never throws, even when no canvas can be made', () => {
    expect(probeBlurPath(() => { throw new Error('no canvases') })).toBe('solid')
  })
})

describe('downscale sizing', () => {
  const frames: Array<[number, number]> = [
    [640, 480],
    [1280, 720],
    [1920, 1080],
    [480, 640],
    [720, 1280],
    [1080, 1920],
  ]

  it('keeps the untrusted full blur to at most 12 px on the long edge, at any frame shape', () => {
    for (const [w, h] of frames) {
      const size = downscaleSize(w, h, blurRadiusPx(1, w), FORCE_MAX_BLUR_LONG_EDGE_PX)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(FORCE_MAX_BLUR_LONG_EDGE_PX)
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps more detail at a weaker strength, and is always a real reduction', () => {
    for (const [w, h] of frames) {
      const weak = downscaleSize(w, h, blurRadiusPx(0, w))
      const strong = downscaleSize(w, h, blurRadiusPx(1, w))
      expect(weak.width).toBeGreaterThan(strong.width)
      expect(weak.width).toBeLessThanOrEqual(w / 2)
      expect(weak.height).toBeLessThanOrEqual(h / 2)
    }
  })

  it('steps down by at most half at a time and ends at the target', () => {
    const target = downscaleSize(1280, 720, blurRadiusPx(1, 1280), FORCE_MAX_BLUR_LONG_EDGE_PX)
    const steps = downscaleSteps(1280, 720, target)
    let prev = { width: 1280, height: 720 }
    for (const step of steps) {
      expect(step.width).toBeGreaterThanOrEqual(Math.ceil(prev.width / 2))
      expect(step.width).toBeLessThan(prev.width)
      prev = step
    }
    expect(steps.at(-1)).toEqual(target)
    expect(steps[0]!.width).toBeLessThanOrEqual(640)
  })
})

describe('VideoEffect where the canvas filter does nothing (WebKit)', () => {
  it('blurs by downscaling and never draws the camera onto the published canvas', () => {
    const { effect, out } = newEffect(SAFARI)
    const camera = cameraFrame(W, H)
    expect(sharpness(camera)).toBe(255)

    expect(effect.renderFrame(camera, W, H, 0)).toBe('blur-all')
    expect(effect.blurPath).toBe('downscale')

    // The camera frame itself is never drawn onto the output, at any size
    // or with any filter: only the smallest downscale canvas is.
    expect(out.ctx.draws.some((d) => d.image === camera)).toBe(false)
    expect(out.ctx.draws).toHaveLength(1)
    const small = out.ctx.draws[0]!.image as RasterCanvas
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(FORCE_MAX_BLUR_LONG_EDGE_PX)
    expect(out.ctx.draws[0]!.args).toEqual([0, 0, W, H])

    // And what came out has no sharp step left in it.
    expect(sharpness(out.pixels)).toBeLessThan(80)
  })

  it('would have published the camera sharp through the old filter-only code', () => {
    // The defect, kept as a test so the fake is known to reproduce it.
    const out = new RasterCanvas(W, H, SAFARI)
    const camera = cameraFrame(W, H)
    out.ctx.filter = 'blur(22px)'
    out.ctx.drawImage(camera, 0, 0, W, H)
    expect(out.ctx.filter).toBe('blur(22px)')
    expect(sharpness(out.pixels)).toBe(255)
  })

  it('reuses its downscale canvases from frame to frame', () => {
    const { effect, factory } = newEffect(SAFARI)
    const camera = cameraFrame(W, H)
    effect.renderFrame(camera, W, H, 0)
    const made = factory.made.length
    effect.renderFrame(camera, W, H, 33)
    effect.renderFrame(camera, W, H, 66)
    expect(factory.made.length).toBe(made)
  })

  it('blurs the composited background the same way', async () => {
    const mask: SegmentationMask = { width: 8, height: 6, data: new Float32Array(48).fill(0) }
    const segmenter: Segmenter = { segment: () => mask, close: () => {} }
    const { effect, out } = newEffect(SAFARI, segmenter)
    await effect.ready()
    const camera = cameraFrame(W, H)
    expect(effect.renderFrame(camera, W, H, 0)).toBe('composite')
    // The mask says "all room", so all of the output is background.
    expect(out.ctx.draws.some((d) => d.image === camera)).toBe(false)
    expect(sharpness(out.pixels)).toBeLessThan(80)
  })
})

describe('VideoEffect where the filter blurs (Chromium, Firefox, Electron)', () => {
  it('keeps using the canvas filter, as before', () => {
    const { effect, out } = newEffect(CHROMIUM)
    const camera = cameraFrame(W, H)
    effect.renderFrame(camera, W, H, 0)
    expect(effect.blurPath).toBe('filter')
    const draws = out.ctx.draws
    expect(draws).toHaveLength(1)
    expect(draws[0]!.image).toBe(camera)
    expect(draws[0]!.filter).toMatch(/^blur\(\d+px\)$/)
    expect(sharpness(out.pixels)).toBeLessThan(255)
  })
})

describe('VideoEffect where no blur can be shown to work', () => {
  it('paints a solid cover, and no camera pixel, when the probe throws', () => {
    const { effect, out } = newEffect({ filterBlurs: false, readbackThrows: true })
    const camera = cameraFrame(W, H)
    expect(effect.renderFrame(camera, W, H, 0)).toBe('blur-all')
    expect(effect.blurPath).toBe('solid')
    expect(out.ctx.draws).toHaveLength(0)
    expect(out.ctx.fills).toEqual([{ colour: SOLID_COVER_COLOUR, args: [0, 0, W, H] }])
    const [r, g, b] = [0x10, 0x18, 0x20]
    for (let i = 0; i < out.pixels.data.length; i += 4) {
      expect([...out.pixels.data.subarray(i, i + 4)]).toEqual([r, g, b, 255])
    }
  })

  it('paints a solid cover when the downscale canvases cannot be made mid-call', () => {
    let allow = true
    const inner = rasterFactory(SAFARI)
    const out = new RasterCanvas(W, H, SAFARI)
    const effect = new VideoEffect({
      output: out,
      createCanvas: (w, h) => {
        if (!allow) throw new Error('out of canvases')
        return inner.create(w, h)
      },
      loadSegmenter: async () => { throw new Error('no segmenter in this build') },
      mode: 'blur',
    })
    expect(effect.blurPath).toBe('downscale')
    allow = false
    const camera = cameraFrame(W, H)
    expect(effect.renderFrame(camera, W, H, 0)).toBe('blur-all')
    expect(out.ctx.draws.some((d) => d.image === camera)).toBe(false)
    expect(out.ctx.fills.at(-1)).toEqual({ colour: SOLID_COVER_COLOUR, args: [0, 0, W, H] })
  })
})
