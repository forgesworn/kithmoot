/**
 * When a relay that has failed may be dialled again, shared by every pool in
 * the process.
 *
 * Each `NostrRelayPool` used to keep this for itself, and a page or app holds
 * many: one per open room, one per known room it watches, one each for
 * profiles, bookmarks, projects and read positions. On 5 October 2026 a
 * desktop app with a few rooms dialled two dead relays about 80 times a
 * minute between its pools, and an Android emulator kept dozens of sockets
 * to the same host. Public relays answer that by banning the address:
 * `nos.lol` and `nostr.mom` stopped answering this machine altogether, and
 * `relay.damus.io` said "banned: too many rate-limit violations". Every
 * person whose relay misbehaved for a while would have met the same.
 *
 * So the backoff lives here, keyed by relay URL, and outlives any one pool.
 * A relay that has never failed, or whose last failure has since been
 * answered, is not held up at all. Once it fails, only one dial at a time is
 * let through, however many pools want it: a pool that is turned away waits
 * as it would for its own backoff, until that dial fails, opens, or is
 * answered.
 */
export class RelayDialGate {
  readonly #relays = new Map<string, { failures: number; after: number; lease: number }>()
  readonly #now: () => number

  constructor(now: () => number = () => Date.now()) { this.#now = now }

  /** Whether a new connection to `url` may start now. For a failing relay
   *  this takes the one dial on offer, until it fails, is answered, or its
   *  lease runs out. */
  take(url: string): boolean {
    const relay = this.#relays.get(url)
    if (!relay) return true
    const now = this.#now()
    if (now < relay.after || now < relay.lease) return false
    relay.lease = now + DIAL_LEASE_MS
    return true
  }

  /** Whether `url` is past its backoff with no dial under way. Takes nothing. */
  open(url: string): boolean {
    const relay = this.#relays.get(url)
    const now = this.#now()
    return !relay || (now >= relay.after && now >= relay.lease)
  }

  /** When `url` may next be dialled: now or earlier for a relay not held back. */
  retryAt(url: string): number { return this.#relays.get(url)?.after ?? 0 }

  /** Whether `url` has failed since it last answered. */
  failing(url: string): boolean { return this.#relays.has(url) }

  /** A connection to `url` failed, or one that opened never answered. One
   *  silence is one failure: several pools whose sockets died together would
   *  otherwise double the backoff once each. */
  failed(url: string): void {
    const now = this.#now()
    const relay = this.#relays.get(url) ?? { failures: 0, after: 0, lease: 0 }
    relay.lease = 0
    if (now >= relay.after) {
      relay.failures++
      relay.after = now + Math.min(DIAL_BACKOFF_MS * 2 ** (relay.failures - 1), DIAL_BACKOFF_MAX_MS)
    }
    this.#relays.set(url, relay)
  }

  /** A socket to `url` opened. Other pools may dial it again, but its
   *  backoff stands until it answers: a relay that takes the upgrade and
   *  then drops it or says nothing is still failing. */
  connected(url: string): void {
    const relay = this.#relays.get(url)
    if (relay) relay.lease = 0
  }

  /** `url` said something on its own account: an `OK` either way, or an
   *  event. That, not an open socket, is what ends its backoff. */
  answered(url: string): void { this.#relays.delete(url) }

  /** Forget every relay. For tests. */
  clear(): void { this.#relays.clear() }
}

/** Dial backoff after a failure: doubling from 1 s to at most 8 s. A
 *  publish keeps trying for 20 s (`PUBLISH_RETRY_BUDGET_MS`), so a relay that
 *  comes back still gets a late try within it; a longer cap lost the message
 *  instead. With every pool in the process behind one gate and one dial at a
 *  time, 8 s is at most about seven dials a minute to a dead relay from the
 *  whole app. */
export const DIAL_BACKOFF_MS = 1_000
export const DIAL_BACKOFF_MAX_MS = 8_000

/** How long one dial to a failing relay holds off the others. Past the
 *  longest connection timeout a pool gives a socket, including a relay that
 *  asks for authentication, so a dial that never reports back does not hold
 *  the relay for ever. */
export const DIAL_LEASE_MS = 30_000

/** The gate every pool uses unless it is given its own. */
export const relayDials = new RelayDialGate()
