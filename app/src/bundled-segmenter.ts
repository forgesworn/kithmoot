import type { FrameSourceLike, Segmenter } from '../../src/video-effects.js'

interface Mask {
  width: number
  height: number
  getAsFloat32Array(): Float32Array
}
export interface SegmentationResult {
  confidenceMasks?: Mask[]
  close(): void
}
export interface ImageSegmenterLike {
  segment(source: FrameSourceLike): SegmentationResult
  close(): void
}

/** IMAGE mode has no history: repeated timestamps and camera changes cannot
 * reuse another frame's silhouette. The caller still owns source invalidation. */
export function wrapSegmenter(inner: ImageSegmenterLike): Segmenter {
  let closed = false
  return {
    segment(source) {
      if (closed) return null
      const result = inner.segment(source)
      try {
        // Square Selfie Segmenter emits either foreground alone, or
        // background then foreground. Never use its background as the person.
        const masks = result.confidenceMasks ?? []
        const mask = masks.at(-1)
        if (!mask) return null
        // The result owns the WASM buffer. Keep a copy before releasing it.
        const data = mask.getAsFloat32Array().slice()
        if (mask.width <= 0 || mask.height <= 0 || data.length !== mask.width * mask.height
          || data.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw Error('Invalid foreground mask')
        return { width: mask.width, height: mask.height, data }
      } finally { result.close() }
    },
    close() { if (!closed) { closed = true; inner.close() } },
  }
}

/** No CDN or hosted inference. Both runtime and weights ship with the app. */
export async function createBundledSegmenter(): Promise<Segmenter> {
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const base = new URL(`${import.meta.env.BASE_URL}camera-vision/`, location.origin)
  const fileset = await FilesetResolver.forVisionTasks(base.href)
  const segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('selfie_segmenter.tflite', base).href, delegate: 'CPU' },
    runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
  })
  return wrapSegmenter(segmenter as unknown as ImageSegmenterLike)
}
