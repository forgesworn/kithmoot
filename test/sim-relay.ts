import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'

type Handler = (event: Event) => void

interface Subscription {
  filters: Filter[]
  handler: Handler
}

function matches(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false

  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    const tagName = key.slice(1)
    const values = event.tags.filter((t) => t[0] === tagName).map((t) => t[1])
    if (!(wanted as string[]).some((w) => values.includes(w))) return false
  }
  return true
}

/**
 * An in-process relay honouring enough of NIP-01 to run full journeys with no
 * network. Ephemeral kinds are delivered but never replayed, which is what
 * makes it a fair test of signalling.
 */
export class SimRelay {
  readonly published: Event[] = []
  #subs = new Set<Subscription>()
  #closed = false

  publish(event: Event): void {
    if (this.#closed) throw new Error('relay is closed')
    this.published.push(event)
    for (const sub of this.#subs) {
      if (sub.filters.some((f) => matches(event, f))) sub.handler(event)
    }
  }

  subscribe(filters: Filter[], handler: Handler): () => void {
    if (this.#closed) throw new Error('relay is closed')
    const sub: Subscription = { filters, handler }
    this.#subs.add(sub)
    return () => this.#subs.delete(sub)
  }

  close(): void {
    this.#closed = true
    this.#subs.clear()
  }
}
