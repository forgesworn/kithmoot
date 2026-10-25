export const HIDDEN_CAMERA_FRAME_INTERVAL_MS = 1_000

export type HiddenCameraAction = 'render' | 'keep-alive'

/** Hidden output may be repeated only after a complete safe frame was published.
 * Any setting or source change invalidates that permission until the next render. */
export class HiddenCameraScheduler {
  #safeFrame = false
  #lastActionAt: number | null = null

  invalidate(): void {
    this.#safeFrame = false
  }

  rendered(nowMs: number): void {
    this.#safeFrame = true
    this.#lastActionAt = nowMs
  }

  next(nowMs: number): HiddenCameraAction | null {
    if (this.#lastActionAt !== null && nowMs - this.#lastActionAt < HIDDEN_CAMERA_FRAME_INTERVAL_MS) return null
    this.#lastActionAt = nowMs
    return this.#safeFrame ? 'keep-alive' : 'render'
  }
}
