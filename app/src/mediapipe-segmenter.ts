import type { FrameSourceLike, SegmentationMask, Segmenter } from '../../src/video-effects.js'

/**
 * MediaPipe Selfie Segmentation, wrapped as the `Segmenter` the pure core
 * asks for.
 *
 * ## Why it is loaded like this
 *
 * The SIMD WASM build is 11.7MB on the wire, 3.4MB gzipped, plus a 250KB
 * model. That is twenty times the whole rest of the app. It is behind a
 * dynamic `import()` and a lazy `createSegmenter()` so it is fetched the
 * first time somebody actually turns an effect on, and never on first paint.
 *
 * ## Why it is served from here rather than a CDN
 *
 * Every MediaPipe example points `FilesetResolver` at Google's CDN. Doing
 * that would mean that turning on background blur, in an app whose entire
 * pitch is that no operator can see you, tells a third party your IP address
 * and that you are about to join a call. The WASM and the model are served
 * from the same origin as the app, which costs a copy in the deploy and buys
 * back the property the product is for.
 */

/** Small subset of `@mediapipe/tasks-vision` this file touches, named here so
 *  the dynamic import can be typed without pulling the package into the
 *  main chunk's type graph at build time. */
interface MpMask {
  width: number
  height: number
  getAsFloat32Array(): Float32Array
}

interface MpSegmentationResult {
  confidenceMasks?: MpMask[]
  close(): void
}

interface MpImageSegmenter {
  segmentForVideo(source: unknown, timestampMs: number): MpSegmentationResult
  close(): void
}

export interface CreateSegmenterOptions {
  /** Directory holding `vision_wasm_internal.js` and its `.wasm`. */
  wasmPath: string
  /** The `.tflite` model. */
  modelPath: string
  /** Tried first; CPU is the fallback. On a machine with no usable WebGL the
   *  GPU delegate throws at creation time rather than at the first frame. */
  delegate?: 'GPU' | 'CPU'
}

/**
 * Which confidence mask is the person.
 *
 * The two-class selfie segmenter emits masks in category order, background
 * first and person second, so with two masks the person is the last one.
 * Some builds emit a single foreground mask instead, in which case there is
 * no choice to make. Getting this wrong is not subtle: the person is blurred
 * and the room is sharp, which is why it is verified with a screenshot
 * rather than assumed from the documentation.
 */
function personMask(masks: MpMask[]): MpMask | undefined {
  if (masks.length === 0) return undefined
  return masks[masks.length - 1]
}

class MediaPipeSegmenter implements Segmenter {
  #inner: MpImageSegmenter | null
  #lastTimestamp = -1

  constructor(inner: MpImageSegmenter) {
    this.#inner = inner
  }

  segment(source: FrameSourceLike, timestampMs: number): SegmentationMask | null {
    const inner = this.#inner
    if (!inner) return null
    // MediaPipe's VIDEO running mode requires strictly increasing
    // timestamps and throws on a repeat, which `requestVideoFrameCallback`
    // will hand it if two callbacks land in the same millisecond.
    const stamp = timestampMs <= this.#lastTimestamp ? this.#lastTimestamp + 1 : Math.round(timestampMs)
    this.#lastTimestamp = stamp

    const result = inner.segmentForVideo(source, stamp)
    try {
      const mask = personMask(result.confidenceMasks ?? [])
      if (!mask) return null
      // Copied out before the result is closed: the underlying buffer is
      // owned by the WASM heap and is invalid the moment it is released.
      return { width: mask.width, height: mask.height, data: mask.getAsFloat32Array() }
    } finally {
      result.close()
    }
  }

  close(): void {
    this.#inner?.close()
    this.#inner = null
  }
}

export async function createSegmenter(opts: CreateSegmenterOptions): Promise<Segmenter> {
  const vision = await import('@mediapipe/tasks-vision')
  const fileset = await vision.FilesetResolver.forVisionTasks(opts.wasmPath)
  const make = async (delegate: 'GPU' | 'CPU'): Promise<MpImageSegmenter> =>
    (await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.modelPath, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    })) as unknown as MpImageSegmenter

  const first = opts.delegate ?? 'GPU'
  try {
    return new MediaPipeSegmenter(await make(first))
  } catch (err) {
    if (first === 'CPU') throw err
    // A machine with no usable WebGL, or a browser that has blocked it, is
    // common enough that falling back is worth more than the error message.
    return new MediaPipeSegmenter(await make('CPU'))
  }
}
