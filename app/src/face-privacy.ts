import { faceCovers, type FaceDetector, type FacePrivacyMode } from '../../src/face-privacy.js'
import { FACE_MASK_PATHS } from '../../src/face-mask-art.js'

export interface FacePrivacyState { mode: FacePrivacyMode; covered: boolean; message: string }

/** Draw only into a private staging canvas. The published canvas is copied
 * after this finishes, so even a throwing overlay cannot publish half a frame. */
export class FacePrivacy {
  #mode: FacePrivacyMode = 'off'
  #detector?: FaceDetector
  #generation = 0
  #loading = false
  #retryAt = 0
  #closed = false
  #state: FacePrivacyState = { mode: 'off', covered: false, message: 'Your face is visible.' }
  #paths?: { fill: string; path: Path2D }[]

  constructor(
    private readonly output: HTMLCanvasElement,
    private readonly onStateChange: (state: FacePrivacyState) => void = () => {},
    private readonly loadDetector: () => Promise<FaceDetector> = async () => ({ detect: () => [], close() {} }),
  ) {}

  get state(): FacePrivacyState { return this.#state }
  get mode(): FacePrivacyMode { return this.#mode }

  setMode(mode: FacePrivacyMode): void {
    if (this.#closed || this.#mode === mode) return
    this.#mode = mode
    this.#generation += 1
    this.#loading = false
    this.#retryAt = 0
    try { this.#detector?.close() } catch { /* Concealment must still change if native cleanup fails. */ }
    this.#detector = undefined
    if (mode !== 'off') this.cover()
    this.#report(mode !== 'off', mode === 'off' ? 'Your face is visible.' : mode === 'avatar'
      ? 'Avatar: the whole camera picture is replaced. The camera stays on locally.'
      : 'Picture covered: automatic face masking is unavailable in this build.')
  }

  render(source: unknown, width: number, height: number, timestampMs: number, drawCamera: () => void): void {
    if (this.#closed) return
    if (this.#mode === 'off') { drawCamera(); return }
    this.output.width = width
    this.output.height = height
    if (this.#mode === 'avatar') { this.cover(); return }
    if (!this.#detector) {
      this.cover()
      this.#load(timestampMs)
      return
    }
    try {
      const covers = faceCovers(this.#detector.detect(source, timestampMs), width, height)
      if (!covers) {
        this.cover()
        this.#report(true, 'Picture covered: face detection is unavailable or found no face. Avatar is available.')
        return
      }
      drawCamera()
      const ctx = this.output.getContext('2d')!
      for (const box of covers) this.#mask(ctx, box.x, box.y, box.width, box.height)
      this.#report(false, `Masking ${covers.length === 1 ? 'your face' : `${covers.length} faces`}. Tracking can miss faces; Avatar replaces the whole picture.`)
    } catch {
      this.cover()
      try { this.#detector?.close() } catch { /* The opaque fallback is already drawn. */ }
      this.#detector = undefined
      this.#retryAt = timestampMs + 5_000
      this.#report(true, 'Picture covered: face masking failed. Retrying; Avatar is also available.')
    }
  }

  /** Safe even before capture has produced its first frame. */
  cover(): void {
    const ctx = this.output.getContext('2d')!
    ctx.save()
    ctx.resetTransform()
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.filter = 'none'
    ctx.fillStyle = '#101820'
    ctx.fillRect(0, 0, this.output.width, this.output.height)
    const height = this.output.height * 0.8
    const width = Math.min(this.output.width * 0.7, height * 200 / 240)
    // Artwork failure must still leave a fully opaque picture. No camera
    // draw belongs to this path, even if Path2D or painting is unavailable.
    try { this.#mask(ctx, (this.output.width - width) / 2, (this.output.height - height) / 2, width, height) } catch { /* Keep the solid cover. */ }
    ctx.restore()
  }

  close(): void {
    this.#closed = true
    this.#generation += 1
    try { this.#detector?.close() } catch { /* Stop owns no further output. */ }
    this.#detector = undefined
  }

  #mask(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
    this.#paths ??= FACE_MASK_PATHS.map(({ fill, d }) => ({ fill, path: new Path2D(d) }))
    ctx.save()
    try {
      ctx.translate(x, y)
      ctx.scale(width / 200, height / 240)
      ctx.filter = 'none'
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      for (const { fill, path } of this.#paths) { ctx.fillStyle = fill; ctx.fill(path) }
    } finally { ctx.restore() }
  }

  #load(timestampMs: number): void {
    if (this.#closed || this.#loading || timestampMs < this.#retryAt) return
    this.#loading = true
    const generation = this.#generation
    void this.loadDetector().then(detector => {
      if (this.#closed || generation !== this.#generation) { detector.close(); return }
      this.#detector = detector
    }).catch(() => {
      if (generation !== this.#generation || this.#closed) return
      this.#retryAt = performance.now() + 5_000
      this.#report(true, 'Picture covered: face detection could not load. Retrying; Avatar is also available.')
    }).finally(() => {
      if (generation === this.#generation) this.#loading = false
    })
  }

  #report(covered: boolean, message: string): void {
    if (this.#state.mode === this.#mode && this.#state.covered === covered && this.#state.message === message) return
    this.#state = { mode: this.#mode, covered, message }
    this.onStateChange(this.#state)
  }
}
