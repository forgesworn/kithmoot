import type { FaceDetector } from '../../src/face-privacy.js'
import type { Segmenter } from '../../src/video-effects.js'

/** No third-party camera model or network fallback. The owned learned model
 * must be trained and qualified before a runtime is connected here. */
export class OwnedCameraVision {
  detector(): FaceDetector { return { detect: () => [], close() {} } }
  segmenter(): Segmenter { throw new Error('The owned foreground model is not yet qualified.') }
  reset(): void {}
}
