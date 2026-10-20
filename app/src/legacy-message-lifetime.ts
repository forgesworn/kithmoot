/** A view restriction, never account or signer authority. Concurrent and
 * nested transitions keep the view closed until the last operation settles. */
export class LegacyMessageLifetime {
  #transitions = 0
  constructor(private readonly invalidate: () => void, private readonly changed: () => void) {}
  get idle(): boolean { return this.#transitions === 0 }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#transitions++
    try {
      this.invalidate()
      this.changed()
      return await work()
    } finally {
      this.#transitions--
      this.changed()
    }
  }
}
