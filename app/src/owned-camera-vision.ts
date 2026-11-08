import type { FaceDetector } from '../../src/face-privacy.js'

/** Face privacy stays covered until its detector is qualified. Foreground
 * segmentation has a separate bundled runtime in bundled-segmenter.ts. */
export class OwnedCameraVision {
  detector(): FaceDetector { return { detect: () => [], close() {} } }
  reset(): void {}
}
