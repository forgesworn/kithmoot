/** One bounded creation ceremony. Wall-clock rollback or a monotonic clock
 * regression permanently invalidates it; neither can lengthen authority.
 * The application always captures real clocks before its first async work. */
export class BrowserMlsRoomCeremonyClock {
  readonly #startWall = Date.now()
  readonly #startMono = performance.now()
  #wall = this.#startWall
  #mono = this.#startMono
  #invalid = false
  readonly deadline = Math.floor(this.#startWall / 1000) + 600
  read(): number | undefined {
    if (this.#invalid) return undefined
    try {
      const wall = Date.now(), mono = performance.now()
      if (!Number.isSafeInteger(this.#startWall) || this.#startWall < 0 || !Number.isFinite(this.#startMono) || this.#startMono < 0 ||
          !Number.isSafeInteger(wall) || wall < this.#wall || !Number.isFinite(mono) || mono < this.#mono ||
          wall - this.#startWall >= 600_000 || mono - this.#startMono >= 600_000) {
        this.#invalid = true; return undefined
      }
      this.#wall = wall; this.#mono = mono
      return Math.floor(wall / 1000)
    } catch { this.#invalid = true; return undefined }
  }
  current = (): boolean => this.read() !== undefined
}
