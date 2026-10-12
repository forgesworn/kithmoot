import { OrdinaryStateHold } from './ordinary-state-codec.js'
export interface OrdinaryLegacyArea { storage: Storage; selected(name: string): boolean }
/** Armed only after every selected legacy area has completed migration.
 * Storage events fence other-window writes; assertClean must also run in the
 * exact foreground guard before each commit/result/effect, since a page does
 * not receive an event for its own Storage write and events can be delayed. */
export class OrdinaryLegacyGuard {
  #held = false
  #closed = false
  readonly #areas: readonly OrdinaryLegacyArea[]
  #changed = (event: StorageEvent) => {
    if (event.key === null || event.newValue === null) return
    const matching = this.#areas.filter(area => area.storage === event.storageArea)
    try { if (matching.some(area => area.selected(event.key!))) this.#hold() }
    catch { this.#hold() }
  }
  constructor(areas: readonly OrdinaryLegacyArea[], private readonly stop: () => void) {
    this.#areas = areas.map(area => ({ ...area }))
    this.assertClean()
    window.addEventListener('storage', this.#changed)
  }
  get live(): boolean { return !this.#closed && !this.#held }
  #hold(): void {
    if (this.#held) return
    this.#held = true
    // The held flag fences future work even if an embedding's stop fails.
    try { this.stop() } catch { /* Retain both stores for explicit recovery. */ }
  }
  assertClean(): void {
    if (!this.live) throw new OrdinaryStateHold()
    try {
      for (const area of this.#areas) for (let index = 0; index < area.storage.length; index++) {
        const name = area.storage.key(index)
        if (name === null || area.selected(name)) throw new OrdinaryStateHold()
      }
    } catch {
      this.#hold()
      throw new OrdinaryStateHold()
    }
  }
  close(): void { this.#closed = true; window.removeEventListener('storage', this.#changed) }
}
