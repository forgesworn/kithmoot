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
declare const dialLease: unique symbol
export interface RelayDialLease { readonly [dialLease]: true }
interface DialState { failures: number; after: number; lease: number; owner?: RelayDialLease }
/** A doubling hold: how many times in a row it was set, and until when. */
interface Hold { strikes: number; until: number }

/**
 * The machine-readable prefix of a relay's `OK false`, `CLOSED` or `NOTICE`
 * reason, lower case and without its colon: `rate-limited`, `blocked`,
 * `restricted`, `pow`, `auth-required`, `invalid`, `error` and so on, or
 * undefined when the reason has none. strfry puts `ERROR: ` in front of
 * every `CLOSED` reason (RelayServer.h), so that is taken off first: without
 * it a strfry refusal could never be told apart from any other close.
 */
export function relayReason(reason: string): string | undefined {
  const bare = reason.replace(/^ERROR: ?/, '')
  return /^([a-z][a-z-]*):/i.exec(bare)?.[1]?.toLowerCase()
}

/** Whether a relay's `NOTICE` asks this client to slow down: rate limiting by
 *  any wording, or strfry's "too many concurrent REQs" for a connection past
 *  its subscription cap. */
export function noticeThrottles(message: string): boolean {
  return /\brate\b|rate[- ]?limit|too many/i.test(message)
}

/** `start` doubled `strikes - 1` times, at most `max`. */
export function doublingBackoff(strikes: number, start: number, max: number): number {
  return Math.min(start * 2 ** Math.max(0, Math.min(strikes - 1, 30)), max)
}

export class RelayDialGate {
  readonly #relays = new Map<string, DialState>()
  /** Relays that said we write too fast: nothing more is written to them until the hold ends. */
  readonly #writes = new Map<string, Hold>()
  /** Relays that refused a read with `rate-limited:`: no subscription is resent to them until the hold ends. */
  readonly #reads = new Map<string, Hold>()
  readonly #leases = new WeakMap<RelayDialLease, { url: string; state?: DialState }>()
  readonly #now: () => number

  constructor(now: () => number = () => Date.now()) { this.#now = now }

  /** Whether a new connection to `url` may start now. For a failing relay
   *  this takes the one dial on offer, until it fails, is answered, or its
   *  lease runs out. */
  take(url: string): boolean {
    return this.reserve(url) !== undefined
  }

  /** A local reservation receipt, never relay or protocol authority. */
  reserve(url: string): RelayDialLease | undefined {
    const relay = this.#relays.get(url)
    const now = this.#now()
    if (relay && (now < relay.after || now < relay.lease)) return
    const receipt = Object.freeze({}) as RelayDialLease
    if (relay) { relay.lease = now + DIAL_LEASE_MS; relay.owner = receipt }
    this.#leases.set(receipt, { url, state: relay })
    return receipt
  }

  /** Consume only this exact still-current reservation. Expired/replaced,
   * healthy-URL and forged receipts cannot release a later pool's lease. */
  release(receipt: RelayDialLease): boolean {
    const held = this.#leases.get(receipt)
    this.#leases.delete(receipt)
    if (!held?.state || this.#relays.get(held.url) !== held.state || held.state.owner !== receipt) return false
    held.state.lease = 0; delete held.state.owner
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
    this.#failure(url, false)
  }

  /** A dial failure may record backoff, but only its own receipt may free an
   * in-progress reservation. Connected-socket failures own no dial receipt. */
  failedDial(url: string, receipt?: RelayDialLease): void {
    if (receipt && this.#leases.get(receipt)?.url === url) this.release(receipt)
    this.#failure(url, true)
  }

  #failure(url: string, preserveLease: boolean): void {
    const now = this.#now()
    const relay = this.#relays.get(url) ?? { failures: 0, after: 0, lease: 0 }
    if (!preserveLease) { relay.lease = 0; delete relay.owner }
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
    if (relay) { relay.lease = 0; delete relay.owner }
  }

  /** `url` said something on its own account: an `OK` either way, or an
   *  event. That, not an open socket, is what ends its backoff. */
  answered(url: string): void { this.#relays.delete(url) }

  /**
   * `url` asked this client to slow down: `rate-limited:` in an `OK false` or
   * a `CLOSED`, or a `NOTICE` about rates or too many requests. Nothing more
   * is written to it, from any pool in the process, for 30 s, doubling with
   * each further complaint to at most an hour. Several pools hearing the same
   * complaint at once count it once: a further one counts only after the
   * hold it caused has ended. A relay that has said nothing of the kind for
   * an hour after its last hold ended starts again from 30 s.
   */
  throttled(url: string): void { this.#hold(this.#writes, url, WRITE_HOLD_MS, WRITE_HOLD_MAX_MS) }

  /** Whether writes to `url` are held because it asked us to slow down. */
  writeHeld(url: string): boolean { return this.writeHeldUntil(url) > this.#now() }

  /** When writes to `url` may start again: now or earlier when not held. */
  writeHeldUntil(url: string): number { return this.#writes.get(url)?.until ?? 0 }

  /**
   * `url` refused a subscription with `rate-limited:`. No subscription is
   * sent to it again, from any pool, for 60 s, doubling to at most 30
   * minutes. Resending a refused `REQ` every few seconds is exactly the
   * stream of "rate-limit violations" that relays ban an address for.
   */
  readRateLimited(url: string): void { this.#hold(this.#reads, url, READ_HOLD_MS, READ_HOLD_MAX_MS) }

  /** Whether subscriptions to `url` are held after a `rate-limited:` refusal. */
  readHeld(url: string): boolean { return this.readHeldUntil(url) > this.#now() }

  /** When a subscription may be sent to `url` again. */
  readHeldUntil(url: string): number { return this.#reads.get(url)?.until ?? 0 }

  /** The relay refused the WebSocket upgrade itself with 429 or 503. That is
   *  a relay telling this address to go away for a while, not a network
   *  failure: writes are held, and so is the next dial, until the hold ends. */
  refusedUpgrade(url: string): void {
    this.throttled(url)
    const relay = this.#relays.get(url) ?? { failures: 0, after: 0, lease: 0 }
    relay.failures = Math.max(relay.failures, 1)
    relay.after = Math.max(relay.after, this.writeHeldUntil(url))
    this.#relays.set(url, relay)
  }

  #hold(holds: Map<string, Hold>, url: string, start: number, max: number): void {
    const now = this.#now()
    const held = holds.get(url)
    // One complaint per hold: pools hearing it together do not double it.
    if (held && now < held.until) return
    // Quiet for as long as the longest hold since the last one ended: start again.
    const strikes = held && now - held.until < max ? held.strikes + 1 : 1
    holds.set(url, { strikes, until: now + doublingBackoff(strikes, start, max) })
  }

  /** Forget every relay. For tests. */
  clear(): void { this.#relays.clear(); this.#writes.clear(); this.#reads.clear() }
}

/** How long writes to a relay that asked us to slow down are held: 30 s,
 *  doubling to an hour. */
export const WRITE_HOLD_MS = 30_000
export const WRITE_HOLD_MAX_MS = 60 * 60_000

/** How long subscriptions to a relay that refused one with `rate-limited:`
 *  are held: 60 s, doubling to 30 minutes. */
export const READ_HOLD_MS = 60_000
export const READ_HOLD_MAX_MS = 30 * 60_000

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
