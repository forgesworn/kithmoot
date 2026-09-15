export interface PresencePerson { participant: string; name?: string; agent?: boolean }
export interface PresenceAnnouncement { person: PresencePerson; arrived: boolean }

/** Presentation grace only. The live roster and access rules still change immediately. */
export const DEPARTURE_GRACE_MS = 30_000

export class PresenceAnnouncements {
  #known = new Map<string, PresencePerson>()
  #missing = new Map<string, number>()
  #started = false

  update(people: PresencePerson[], now: number, settled: boolean): PresenceAnnouncement[] {
    const present = new Map(people.map(person => [person.participant, person]))
    if (!this.#started || !settled) {
      this.#started = true
      this.#known = present
      this.#missing.clear()
      return []
    }
    const notices: PresenceAnnouncement[] = []
    for (const [key, person] of present) {
      if (!this.#known.has(key)) notices.push({ person, arrived: true })
      this.#known.set(key, person)
      this.#missing.delete(key)
    }
    for (const [key, person] of this.#known) {
      if (present.has(key)) continue
      const since = this.#missing.get(key) ?? now
      this.#missing.set(key, since)
      if (now - since < DEPARTURE_GRACE_MS) continue
      notices.push({ person, arrived: false })
      this.#known.delete(key)
      this.#missing.delete(key)
    }
    return notices
  }

  get nextCheck(): number | undefined {
    if (!this.#missing.size) return undefined
    return Math.min(...this.#missing.values()) + DEPARTURE_GRACE_MS
  }
}
