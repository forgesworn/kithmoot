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
  // A conference room is nothing but long-lived subscriptions, and a relay
  // restart, a laptop lid, or a phone crossing from Wi-Fi to mobile closes
  // every one of them from the far side. Without `enableReconnect`,
  // nostr-tools treats that close as final: the subscriptions are torn down,
  // nothing is re-dialled, and the room silently stops hearing anybody new.
  // With it, the relay is re-dialled on a backoff and every open
  // subscription is re-issued on the new socket. `enablePing` is what
  // notices a socket that is dead but not closed - the usual state after a
  // sleep - by sending a dummy REQ and expecting its EOSE; a relay that
  // does not answer is dropped and re-dialled the same way.
  //
  // Known limit, stated rather than hidden: nostr-tools gives up on a relay
  // that refuses the *first* connection, so a relay that is down at join
  // time is not retried for the session. The others carry the room.
  #pool = new SimplePool({ enableReconnect: true, enablePing: true })
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
