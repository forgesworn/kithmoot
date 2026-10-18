/** Local camera concealment. Detection is a visual aid, never an anonymity guarantee. */
export type FacePrivacyMode = 'off' | 'mask' | 'avatar'
export interface FaceBox { x: number; y: number; width: number; height: number }
export interface FaceDetector {
  /** Boxes in source pixels for THIS frame. No cached detections. */
  detect(source: unknown, timestampMs: number): FaceBox[]
  close(): void
}

/** A generous opaque rectangle, including the forehead, cheeks and chin.
 * Invalid results cover the whole picture; silently discarding a bad box
 * could leave one of several people exposed. Kept in step with Android. */
export function faceCovers(boxes: readonly FaceBox[], width: number, height: number): FaceBox[] | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || boxes.length === 0) return null
  const covers: FaceBox[] = []
  for (const box of boxes) {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 ||
      box.x >= width || box.y >= height || box.x + box.width <= 0 || box.y + box.height <= 0) return null
    const left = Math.max(0, box.x - box.width * 0.4)
    const top = Math.max(0, box.y - box.height * 0.5)
    const right = Math.min(width, box.x + box.width * 1.4)
    const bottom = Math.min(height, box.y + box.height * 1.35)
    covers.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return covers
}

export function facePrivacyMode(value: unknown): FacePrivacyMode {
  return value === 'mask' || value === 'avatar' ? value : 'off'
}
