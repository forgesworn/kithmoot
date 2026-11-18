import type { Event } from 'nostr-tools/pure'
import type { DeviceStore } from './device-store.js'

const PREFIX = 'kithmoot.people-profiles.v1.'
const MAX_ENTRIES = 2_000
const MAX_EVENT_BYTES = 80_000
const MAX_BYTES = 1024 * 1024
const DAY = 86_400
const ENCODER = new TextEncoder()

interface Entry { event: Event; checked: number }

/** Verified public metadata for follows and Nostr correspondents. ProfileBook
 * verifies signatures and parses the metadata again on a cache read. */
export class PeopleProfileCache {
  #pending = new Map<string, Map<string, Event>>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #generation = 0

  constructor(private readonly store: DeviceStore, private readonly now = () => Math.floor(Date.now() / 1000)) {}

  read(account: string, authors: ReadonlySet<string>): { event: Event; fresh: boolean }[] {
    if (!authors.size) return []
    const now = this.now()
    return this.#entries(account, now).filter(row => authors.has(row.event.pubkey))
      .map(row => ({ event: row.event, fresh: now - row.checked < DAY }))
  }

  /** Called with an already verified public event for an eligible author. */
  keep(account: string, event: Event): void {
    if (event.kind !== 0 || ENCODER.encode(JSON.stringify(event)).length > MAX_EVENT_BYTES) return
    const batch = this.#pending.get(account) ?? new Map<string, Event>()
    const earlier = batch.get(event.pubkey)
    if (earlier && !newerProfile(event, earlier)) return
    batch.set(event.pubkey, structuredClone(event))
    this.#pending.set(account, batch)
    this.#timer ??= setTimeout(() => this.flush(), 100)
  }

  flush(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const generation = this.#generation
    const pending = this.#pending
    this.#pending = new Map()
    for (const [account, batch] of pending) {
      const write = () => { if (generation === this.#generation) this.#write(account, batch) }
      const locks = globalThis.navigator?.locks
      if (locks) void locks.request(PREFIX + account, write).catch(() => {})
      else write()
    }
  }

  #write(account: string, batch: ReadonlyMap<string, Event>): void {
    try {
      const now = this.now()
      const entries = new Map(this.#entries(account, now).map(row => [row.event.pubkey, row]))
      for (const [pubkey, event] of batch) {
        const previous = entries.get(pubkey)?.event
        if (!previous || previous.id === event.id || newerProfile(event, previous)) entries.set(pubkey, { event, checked: now })
      }
      const next: string[] = []
      let size = 2
      for (const row of [...entries.values()].sort((a, b) => b.checked - a.checked)) {
        if (next.length === MAX_ENTRIES) break
        const encoded = JSON.stringify(row)
        const bytes = ENCODER.encode(encoded).length + Number(next.length > 0)
        if (size + bytes > MAX_BYTES) break
        next.push(encoded)
        size += bytes
      }
      this.store.set(PREFIX + account, '[' + next.join(',') + ']')
    } catch { /* Profiles work online when the device cache is unavailable. */ }
  }

  clear(): void {
    ++this.#generation
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending.clear()
    try { for (const key of this.store.keys()) if (key.startsWith(PREFIX)) this.store.remove(key) }
    catch { /* The disabled profile preference still controls display. */ }
  }

  #entries(account: string, now: number): Entry[] {
    try {
      const raw = this.store.get(PREFIX + account)
      if (!raw || raw.length > MAX_BYTES || ENCODER.encode(raw).length > MAX_BYTES) return []
      const entries: unknown = JSON.parse(raw)
      if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return []
      return entries.filter((row): row is Entry => !!row?.event && row.event.kind === 0 &&
        typeof row.event.pubkey === 'string' && typeof row.event.id === 'string' && Number.isSafeInteger(row.event.created_at) &&
        row.event.created_at <= now + 60 && Number.isSafeInteger(row.checked) && now - 30 * DAY <= row.checked && row.checked <= now)
    } catch { return [] }
  }
}

/** NIP-01 replacement ordering. */
export function newerProfile(event: Pick<Event, 'created_at' | 'id'>, previous: Pick<Event, 'created_at' | 'id'>): boolean {
  return event.created_at > previous.created_at || event.created_at === previous.created_at && event.id < previous.id
}
