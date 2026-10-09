/** Stable gallery order belongs to a call, not to roster arrival order or
 *  the person currently speaking. A page change is always deliberate. */
export class GalleryPages {
  #order: string[] = []
  #size = 9
  #page = 0

  get page(): number { return this.#page }
  get count(): number { return this.#order.length }
  get pages(): number { return Math.max(1, Math.ceil(this.count / this.#size)) }
  get visible(): string[] { return this.#order.slice(this.#page * this.#size, (this.#page + 1) * this.#size) }

  update(ids: readonly string[], size: number): void {
    const present = new Set(ids)
    const anchor = this.visible.find(id => present.has(id))
    const order = this.#order.filter(id => present.has(id))
    const retained = new Set(order)
    for (const id of present) if (!retained.has(id)) order.push(id)
    this.#order = order
    this.#size = Math.max(1, Math.floor(size))
    // Preserve a surviving tile from the selected page through resize and
    // departure, instead of letting a roster reorder send the user elsewhere.
    if (anchor !== undefined) this.#page = Math.floor(order.indexOf(anchor) / this.#size)
    this.go(this.#page)
  }

  go(page: number): void { this.#page = Math.max(0, Math.min(this.pages - 1, Math.floor(page))) }
  clear(): void { this.#order = []; this.#page = 0 }
}

/** A bounded page fits readable tiles rather than extending below the
 *  stage. Physical room-capacity qualification is a separate measurement. */
export function galleryPageSize(width: number, height: number): number {
  const columns = Math.max(1, Math.floor((width - 10) / 170))
  const rows = Math.max(1, Math.floor((height - 10) / 100))
  return Math.min(9, columns * rows)
}
