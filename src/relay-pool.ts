import { SimplePool } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'

/**
 * The seam every consumer talks to. The in-process simulator and the real
 * relay pool are interchangeable behind it, so full journeys are testable
 * with no network.
 */
export interface RelayTransport {
  publish(event: Event): Promise<void>
  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void
  close(): void
}

export class NostrRelayPool implements RelayTransport {
  #pool = new SimplePool()
  #relays: string[]
  #closed = false

  constructor(relays: string[]) {
    if (relays.length === 0) throw new Error('at least one relay is required')
    this.#relays = relays
  }

  async publish(event: Event): Promise<void> {
    if (this.#closed) throw new Error('pool is closed')
    // Publish everywhere; succeed if any relay accepts. No relay is
    // load-bearing, which is the entire point.
    const results = await Promise.allSettled(this.#pool.publish(this.#relays, event))
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw new Error('every relay rejected the event')
    }
  }

  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void {
    if (this.#closed) throw new Error('pool is closed')
    // Belt and braces. `subscribeMap` de-duplicates across the relays of one
    // subscription itself, so removing this changes nothing observable today -
    // which is exactly why it stays: the guarantee callers of `RelayTransport`
    // depend on is ours to make, not a pinned dependency's to keep. See
    // `nostr-tools-version-guard.test.ts`.
    const seen = new Set<string>()
    // subscribeMany only accepts one filter per relay, so fan each filter
    // out to every relay and let subscribeMap group them back into a
    // per-relay OR - this is what gives our own multi-filter subscribe its
    // NIP-01 OR semantics.
    const requests = this.#relays.flatMap((url) => filters.map((filter) => ({ url, filter })))
    const sub = this.#pool.subscribeMap(requests, {
      onevent(event) {
        // Hear each event once, however many relays deliver it.
        if (seen.has(event.id)) return
        seen.add(event.id)
        onEvent(event)
      },
    })
    return () => sub.close()
  }

  close(): void {
    this.#closed = true
    this.#pool.close(this.#relays)
  }
}
