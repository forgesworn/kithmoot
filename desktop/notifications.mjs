/** Bounded native banners. Never pass invitation URLs or keys to the OS. */
export class DesktopNotices {
  #deps
  #active = new Map()
  #last = new Map()
  constructor(deps) { this.#deps = deps }
  show(value) {
    if (!value || typeof value !== 'object') return false
    for (const [key, limit] of [['title', 160], ['body', 400], ['tag', 200], ['roomId', 128]]) {
      if (typeof value[key] !== 'string' || !value[key].length || value[key].length > limit) return false
    }
    if (!/^[a-f0-9]{64}$/.test(value.roomId) || typeof value.silent !== 'boolean') return false
    if (!this.#deps.supported()) return false
    const now = Date.now()
    // One banner per conversation per five seconds, bounded even with many rooms.
    if (now - (this.#last.get(value.tag) ?? 0) < 5000) return false
    if (this.#last.size >= 100) this.#last.delete(this.#last.keys().next().value)
    this.#last.set(value.tag, now)
    this.#active.get(value.tag)?.close()
    if (this.#active.size >= 20) {
      const oldest = this.#active.keys().next().value
      this.#active.get(oldest).close()
      this.#active.delete(oldest)
    }
    const notice = this.#deps.create({ title: value.title, body: value.body, silent: value.silent })
    this.#active.set(value.tag, notice)
    const forget = () => { if (this.#active.get(value.tag) === notice) this.#active.delete(value.tag) }
    notice.on('click', () => { this.#deps.open(value.roomId); notice.close(); forget() })
    // The first banner may grant OS badge permission after the count arrived.
    notice.on('show', () => this.#deps.shown?.())
    notice.on('close', forget)
    notice.on('failed', forget)
    try { notice.show(); return true } catch { forget(); return false }
  }
  clear() { for (const notice of this.#active.values()) notice.close(); this.#active.clear(); this.#last.clear() }
}
