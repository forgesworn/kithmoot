import { AbstractSimplePool, SimplePool } from 'nostr-tools/pool'
import { verifyEventUncached } from './verify.js'
import { normalizeURL } from 'nostr-tools/utils'
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { isSafeRelayUrl, MAX_RELAY_HINTS } from './network-hints.js'
import { AUTH_TIMEOUT_MS, authenticatedWebSocket, type AuthenticationGrant, type RelayAuthentication, type RelayPoolOptions } from './relay-auth.js'
import { normaliseTorRelayUrl, type NetworkProfile } from './anonymous.js'
export type { RelayAuthentication, RelayPoolOptions } from './relay-auth.js'

/** Extra policy chosen by a caller that owns the complete network route. */
export interface NostrRelayPoolOptions extends RelayPoolOptions {
  profile?: NetworkProfile
}

/** The transport seam shared by real relays and the in-process simulator. */
export interface RelayTransport {
  publish(event: Event): Promise<void>
  /** `via` is the relay URL that delivered the event, when the transport
   *  knows it. A consumer works out a message's lane from it and from
   *  nothing on the wire; see `lane.ts`. */
  subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void): () => void
  close(): void
  /** The relays this transport reads from and writes to, when it has any.
   *  Absent on transports that are not relays at all. */
  describe?(): RelayConfig[]
  /** Told the room's epoch key when a session opens on this transport and
   *  on every epoch it moves to. A transport that derives anything from
   *  the key, such as a quiet room's drop keys, implements it; a relay
   *  pool has no use for the key and leaves it out. See `quiet.ts`. */
  rekey?(key: Uint8Array): void
}

/** `circle` marks a relay the client knows to be a box of the person's own
 *  circle, from verified current box status or an explicit keeper-confirmed mark. Only such a relay is
 *  ever shown as sheltered; see `lane.ts`. */
export interface RelayConfig { url: string; read: boolean; write: boolean; circle?: boolean }
export interface RelayHealth extends RelayConfig {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed'
  lastConnectedAt?: number
  lastPublishedAt?: number
  publishLatencyMs?: number
  lastError?: string
  authentication?: 'allowed' | 'authenticated' | 'failed' | 'withdrawn'
}


export function normaliseRelayConfig(entries: readonly (string | RelayConfig)[], profile: NetworkProfile = 'direct'): RelayConfig[] {
  if (entries.length === 0) throw new Error('at least one relay is required')
  if (entries.length > MAX_RELAY_HINTS) throw new Error(`use at most ${MAX_RELAY_HINTS} relays`)
  const seen = new Set<string>()
  return entries.map(entry => {
    const value = typeof entry === 'string' ? { url: entry, read: true, write: true } : entry
    if (!value || typeof value.url !== 'string') throw new Error('use a wss:// relay URL (ws:// is allowed only on localhost)')
    const candidate = value.url.trim()
    if (profile === 'direct' && !isSafeRelayUrl(candidate)) throw new Error('use a wss:// relay URL (ws:// is allowed only on localhost)')
    // Check the supplied direct URL before `normalizeURL` removes a password
    // or fragment. The Tor normaliser performs the same check itself.
    const parsed = profile === 'tor' ? new URL(normaliseTorRelayUrl(candidate)) : new URL(candidate)
    if (parsed.username || parsed.password || parsed.hash) throw new Error('relay URLs cannot contain credentials or fragments')
    if (typeof value.read !== 'boolean' || typeof value.write !== 'boolean' || (!value.read && !value.write)) throw new Error('each relay must allow reading or writing')
    const url = profile === 'tor' ? parsed.toString() : normalizeURL(candidate)
    if (seen.has(url)) throw new Error('that relay is already in the list')
    seen.add(url)
    return { url, read: value.read, write: value.write, ...(value.circle === true ? { circle: true } : {}) }
  })
}

type Subscription = {
  filters: Filter[]
  onEvent: (event: Event, via?: string) => void
  onEose?: () => void
  seen: Set<string>
  bindings: Map<string, { stop: () => void; closed: boolean }>
  eosed: Set<string>
  eoseSent: boolean
}

export class NostrRelayPool implements RelayTransport {
  #pool: AbstractSimplePool
  #relays: RelayConfig[]
  #health = new Map<string, Partial<RelayHealth>>()
  #subscriptions = new Set<Subscription>()
  #generation = 0
  #abort = new AbortController()
  #closed = false
  #attempted = new Map<string, number>()
  #recovery: ReturnType<typeof setInterval>
  #authentication = new Map<string, AuthenticationGrant | null>()
  #authFailures = new Map<string, string>()
  #publishing = 0
  readonly #authTimeout: number

  constructor(relays: readonly (string | RelayConfig)[], private readonly circleAtUse?: (url: string) => boolean, private readonly options: NostrRelayPoolOptions = {}) {
    this.#relays = normaliseRelayConfig(relays, this.options.profile)
    if (this.options.profile === 'tor' && (this.options.authentication?.length ?? 0) !== 0) {
      throw new Error('Tor-only mode does not use relay authentication; start with a fresh local persona')
    }
    this.#authTimeout = options.authenticationTimeoutMs ?? AUTH_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#authTimeout) || this.#authTimeout < 100 || this.#authTimeout > 120_000) throw new Error('Invalid relay authentication deadline')
    this.#authentication = this.#grants(options.authentication ?? [])
    this.#pool = this.#createPool()
    this.#recovery = setInterval(() => this.#recoverSubscriptions(), 5_000)
    ;(this.#recovery as unknown as { unref?: () => void }).unref?.()
  }

  #createPool(): AbstractSimplePool {
    const generation = this.#generation
    // Own subscription recovery, including failed first connections and
    // stalled reconnect handshakes. Dependency reconnects can wait forever
    // without a timeout and leave a running agent unable to hear the room.
    const owner = this
    const current = (url: string) => !this.#closed && generation === this.#generation && !this.#authError(url)
    const base = this.options.websocketImplementation ?? globalThis.WebSocket
    const websocketImplementation = this.#authentication.size
      ? authenticatedWebSocket(base, url => this.#authentication.get(url) ?? undefined, current, (url, reason) => {
          if (generation === this.#generation) {
            this.#authFailures.set(url, reason)
            this.#mark(url, { state: 'disconnected', lastError: reason })
          }
        }, this.#authTimeout)
      : this.options.websocketImplementation
    // `enablePing` stays off. In a browser `AbstractRelay` has no real ping
    // frame to send, so it falls back to `waitForDummyReq`: every 29s it
    // opens a throwaway `REQ` and, if no `EOSE` answers within 20s, closes
    // the socket outright (abstract-relay.js's ping loop, ~line 293-328).
    // With `enableReconnect: false` that call is `closeAllSubscriptions`,
    // not a reconnect - and `#recoverSubscriptions` below only rebinds a
    // closed relay after its own 15s per-relay cooldown, so a relay that
    // was merely slow to answer one dummy REQ could cost up to ~35s of
    // missed events before anything noticed, let alone fixed it. `probe()`
    // is the same idea done right: it reconnects a relay that fails its own
    // round trip instead of just closing on it, and `#probeInterval` below
    // is what runs it on a schedule, so nothing here needs the library's
    // version of the same check.
    const pool = websocketImplementation ? new class extends AbstractSimplePool {
      override ensureRelay(url: string, params?: Parameters<AbstractSimplePool['ensureRelay']>[1]) {
        return super.ensureRelay(url, owner.#authentication.get(normalizeURL(url))
          ? { ...params, connectionTimeout: owner.#authTimeout + 8_000 }
          : params)
      }
    }({ enableReconnect: false, enablePing: false, websocketImplementation,
      verifyEvent: verifyEventUncached, maxWaitForConnection: 3_000 })
      : new SimplePool({ enableReconnect: false, enablePing: false })
    pool.allowConnectingToRelay = url => current(normalizeURL(url))
    pool.onRelayConnectionSuccess = url => {
      if (generation === this.#generation) this.#mark(url, { state: 'connected', lastConnectedAt: Date.now(), lastError: undefined })
    }
    pool.onRelayConnectionFailure = url => {
      if (generation === this.#generation) this.#mark(url, { state: 'disconnected', lastError: this.#authError(normalizeURL(url)) ?? 'Connection failed' })
    }
    return pool
  }

  #grants(entries: readonly RelayAuthentication[]): Map<string, AuthenticationGrant | null> {
    if (this.options.profile === 'tor' && entries.length !== 0) throw new Error('Tor-only mode does not use relay authentication')
    const grants = new Map<string, AuthenticationGrant | null>()
    for (const entry of entries) {
      const url = normaliseRelayConfig([entry.url], this.options.profile)[0]!.url
      if (!this.#relays.some(relay => relay.url === url) || grants.has(url)) {
        throw new Error('Authentication must name one configured relay')
      }
      if (entry.identity === null) { grants.set(url, null); continue }
      if (!/^[a-f0-9]{64}$/.test(entry.identity?.pubkey) || typeof entry.identity?.signEvent !== 'function') {
        throw new Error('Authentication needs an explicit signing identity')
      }
      grants.set(url, { pubkey: entry.identity.pubkey, sign: entry.identity.signEvent.bind(entry.identity) })
    }
    return grants
  }

  /** Replace session-only permissions. Withdrawing one closes existing sockets
   * and invalidates an outstanding signer response before it can be sent. */
  setAuthentication(entries: readonly RelayAuthentication[]): void {
    if (this.#closed) throw new Error('pool is closed')
    const next = this.#grants(entries)
    for (const url of this.#authentication.keys()) if (!next.has(url)) next.set(url, null)
    this.#authentication = next
    this.setRelays(this.#relays)
  }

  #authError(url: string): string | undefined {
    return this.#authFailures.get(url) ?? (this.#authentication.get(url) === null ? 'Relay authentication permission withdrawn' : undefined)
  }

  #mark(url: string, update: Partial<RelayHealth>): void {
    const key = normalizeURL(url)
    this.#health.set(key, { ...this.#health.get(key), ...update })
  }

  get closed(): boolean { return this.#closed }
  configuration(): RelayConfig[] { return this.describe() }

  health(): RelayHealth[] {
    const connections = this.#pool.listConnectionStatus()
    return this.describe().map(relay => {
      const previous = this.#health.get(relay.url)
      const connected = connections.get(relay.url)
      const state = this.#closed ? 'closed' : connected === true ? 'connected'
        : previous?.state === 'connected' ? 'disconnected' : previous?.state ?? 'idle'
      const grant = this.#authentication.get(relay.url)
      const authentication = grant === null ? 'withdrawn' : grant
        ? this.#authFailures.has(relay.url) ? 'failed' : connected ? 'authenticated' : 'allowed'
        : undefined
      return { ...previous, ...relay, state, authentication }
    })
  }

  /** Rebind existing consumers without leaving the room or replaying history. */
  setRelays(entries: readonly (string | RelayConfig)[]): void {
    if (this.#closed) throw new Error('pool is closed')
    const next = normaliseRelayConfig(entries, this.options.profile)
    this.#generation++
    this.#abort.abort()
    for (const sub of this.#subscriptions) this.#stop(sub)
    this.#pool.destroy()
    this.#relays = next
    for (const url of this.#authentication.keys()) if (!next.some(relay => relay.url === url)) this.#authentication.delete(url)
    this.#authFailures.clear()
    this.#health.clear()
    for (const [url, grant] of this.#authentication) if (grant === null) this.#mark(url, { state: 'disconnected', lastError: this.#authError(url) })
    this.#attempted.clear()
    this.#abort = new AbortController()
    this.#pool = this.#createPool()
    for (const sub of this.#subscriptions) this.#start(sub)
  }

  reconnect(): void { this.setRelays(this.#relays) }

  /** Whether a publish is currently in flight. A scheduled liveness probe
   *  checks this and skips its turn rather than racing a `REQ`/`CLOSE`
   *  round trip against an event the caller is waiting on. */
  get publishing(): boolean { return this.#publishing > 0 }

  async publish(event: Event): Promise<void> {
    if (this.#closed) throw new Error('pool is closed')
    const urls = this.#relays.filter(relay => relay.write).map(relay => relay.url)
    if (!urls.length) throw new Error('no writable relay is configured')
    const generation = this.#generation
    const start = Date.now()
    for (const url of urls) if (!this.#pool.listConnectionStatus().get(url)) this.#mark(url, { state: 'connecting' })
    // A caller only ever needed to know the event reached somewhere, not
    // that it reached everywhere - so this resolves the moment the first
    // relay acks, rather than waiting out a slow or half-open relay's own
    // retries. Those keep going in the background regardless (`.then`'s
    // second argument below is what stops a late rejection from one ever
    // surfacing as unhandled), so a relay that only answers after a
    // reconnect still gets the event. `#publishing` stays up - and a
    // liveness probe skipped - until every one of them, fast or slow, has
    // actually finished.
    this.#publishing++
    const results: (PromiseSettledResult<void> | undefined)[] = urls.map(() => undefined)
    let remaining = urls.length
    let settled = false
    return new Promise<void>((resolve, reject) => {
      urls.forEach((url, i) => {
        this.#publishToRelay(url, event, generation, start).then(
          () => {
            results[i] = { status: 'fulfilled', value: undefined }
            if (!settled) { settled = true; resolve() }
            if (--remaining === 0) this.#publishing--
          },
          (error: unknown) => {
            results[i] = { status: 'rejected', reason: error }
            const last = --remaining === 0
            if (last) this.#publishing--
            // Only the relay that finishes failing last can know whether
            // every relay refused: reporting on the first one to fail would
            // have called a publish that later succeeded elsewhere a total
            // failure.
            if (last && !settled) {
              settled = true
              try { this.#finishPublish(urls, results as PromiseSettledResult<void>[]); resolve() } catch (err) { reject(err) }
            }
          },
        )
      })
    })
  }

  #finishPublish(urls: string[], results: PromiseSettledResult<void>[]): void {
    if (!results.some(result => result.status === 'fulfilled')) {
      // Each relay's own words, because they differ and the difference is
      // the diagnosis: a box's drop tier says it holds kind 1059 only, and
      // a room pinned to that box alone needs to be told that, not that
      // something somewhere said no.
      const reasons = results.map((result, i) => `${urls[i]}: ${result.status === 'rejected' ? errorText(result.reason) : 'ok'}`)
      // A timeout is a socket that never answered - the joiner's own
      // connection or a phone that went half-open in the background - not a
      // relay that looked at the event and said no. Conflating the two sent
      // someone whose relays were simply unreachable a message that read as
      // a hostile refusal.
      const allTimedOut = results.every(result => result.status === 'rejected' && isTimeoutError(result.reason))
      throw new Error(allTimedOut
        ? `no relay could be reached in time (${reasons.join('; ')})`
        : `every relay rejected the event (${reasons.join('; ')})`)
    }
  }

  /** Publish to one relay, retrying a bare timeout (no OK either way) by
   *  treating the connection as suspect: close and reopen just this relay,
   *  resubscribe what it was carrying, and try again. An explicit rejection
   *  (OK false, auth-required, blocked) is a relay that answered, so it is
   *  never retried here. */
  async #publishToRelay(url: string, event: Event, generation: number, start: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#pool.publish([url], event, { abort: this.#abort.signal })[0]
        if (generation === this.#generation) this.#mark(url, { state: 'connected', lastPublishedAt: Date.now(), publishLatencyMs: Date.now() - start, lastError: undefined })
        return
      } catch (error) {
        const timedOut = isTimeoutError(error)
        if (generation === this.#generation) {
          this.#mark(url, { lastError: this.#authError(url) ?? (timedOut ? 'Publish timed out' : 'Last publish failed or was rejected') })
        }
        if (!timedOut || Date.now() - start >= PUBLISH_RETRY_BUDGET_MS || generation !== this.#generation || this.#closed) throw error
        // A socket that swallowed the send without ever answering is worth
        // more suspicion than a slow one: reopen it rather than hammer the
        // same half-open connection again.
        if (generation === this.#generation) this.#mark(url, { state: 'disconnected' })
        this.#pool.close([url])
        this.#attempted.set(url, Date.now())
        for (const sub of this.#subscriptions) if (sub.bindings.has(url)) this.#startRelay(sub, url)
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!, this.#abort.signal)
        if (generation !== this.#generation || this.#closed) throw error
      }
    }
  }

  /** A cheap round trip per connected relay: a filter that can match
   *  nothing, so the only thing being timed is whether the socket still
   *  answers at all. A relay that does not EOSE within `timeoutMs` is
   *  treated as dead - closed and reopened, with its subscriptions rebound -
   *  which is the only way to notice a half-open socket that `send()`
   *  still accepts into the void. `enablePing` stays off (see module intro
   *  in relay-auth.ts / CLAUDE.md); this is the without-ping substitute. */
  async probe(timeoutMs = 3_000): Promise<void> {
    if (this.#closed) return
    const generation = this.#generation
    const connected = [...this.#pool.listConnectionStatus().entries()].filter(([, ok]) => ok).map(([url]) => url)
    await Promise.all(connected.map(url => this.#probeRelay(url, timeoutMs, generation)))
  }

  async #probeRelay(url: string, timeoutMs: number, generation: number): Promise<void> {
    const alive = await new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        handle.close()
        resolve(ok)
      }
      // A filter nothing can match: the round trip is the point, not the
      // answer. A far-future `since` is honoured by every NIP-01 relay.
      const handle = this.#pool.subscribeMap([{ url, filter: { since: Math.floor(Date.now() / 1000) + 1_000_000_000 } }], {
        abort: this.#abort.signal,
        maxWait: timeoutMs,
        oneose: () => finish(true),
        onclose: () => finish(false),
      })
      const timer = setTimeout(() => finish(false), timeoutMs)
    })
    if (alive || generation !== this.#generation || this.#closed) return
    this.#pool.close([url])
    this.#attempted.set(url, Date.now())
    for (const sub of this.#subscriptions) if (sub.bindings.has(url)) this.#startRelay(sub, url)
  }

  describe(): RelayConfig[] {
    return this.#relays.map(relay => {
      if (!this.circleAtUse) return { ...relay }
      const { circle: _previous, ...rest } = relay
      return this.circleAtUse(relay.url) ? { ...rest, circle: true } : rest
    })
  }

  subscribe(filters: Filter[], onEvent: (event: Event, via?: string) => void, onEose?: () => void): () => void {
    if (this.#closed) throw new Error('pool is closed')
    const sub: Subscription = { filters, onEvent, onEose, seen: new Set(), bindings: new Map(), eosed: new Set(), eoseSent: false }
    this.#subscriptions.add(sub)
    this.#start(sub)
    return () => { this.#subscriptions.delete(sub); this.#stop(sub) }
  }

  #stop(sub: Subscription): void {
    for (const binding of sub.bindings.values()) binding.stop()
    sub.bindings.clear()
  }

  #start(sub: Subscription): void {
    sub.eosed.clear()
    sub.eoseSent = false
    for (const relay of this.#relays) if (relay.read) this.#startRelay(sub, relay.url)
  }

  #startRelay(sub: Subscription, url: string, since = Date.now()): void {
    sub.bindings.get(url)?.stop()
    const generation = this.#generation
    const binding = { stop: () => {}, closed: false }
    sub.bindings.set(url, binding)
    if (!this.#pool.listConnectionStatus().get(url)) {
      this.#mark(url, { state: 'connecting' })
      this.#attempted.set(url, Date.now())
    }
    const active = () => !this.#closed && generation === this.#generation && this.#subscriptions.has(sub) && sub.bindings.get(url) === binding
    // A `REQ` sent the instant a reopened socket connects can land in the
    // gap before a relay that was still recovering actually starts
    // answering again - the socket is open, but the relay drops the frame
    // on the floor the same way it dropped everything else. Nothing else
    // notices: the socket never closes, so `#recoverSubscriptions` sees a
    // healthy connection, and nostr-tools' own `maxWait` below does not
    // resend anything - it only fakes an `EOSE` locally once it gives up
    // waiting. So this watches for that specific silence and resends the
    // `REQ` on the same connection - it does not close it, which would
    // race a publish retry reopening (or finishing on) that same url and
    // turn its in-flight `OK` wait into a hard "connection closed by us"
    // failure instead of a clean, retryable timeout. A connection that is
    // genuinely dead surfaces as a real close on its own, or gets caught by
    // a publish attempt's own retry or the next scheduled `probe()`; `since`
    // carries the original start through each resend so this gives up
    // resending - not listening - once `SUBSCRIBE_STALL_BUDGET_MS` passes,
    // rather than resending into the void forever.
    const stall = setTimeout(() => {
      if (!active() || this.#authError(url) || Date.now() - since >= SUBSCRIBE_STALL_BUDGET_MS) return
      this.#startRelay(sub, url, since)
    }, SUBSCRIBE_STALL_MS)
    const handle = this.#pool.subscribeMap(sub.filters.map(filter => ({ url, filter: { ...filter } })), {
      abort: this.#abort.signal,
      maxWait: 8_000,
      oneose: () => {
        clearTimeout(stall)
        if (!active() || this.#authError(url)) return
        sub.eosed.add(url)
        if (!sub.eoseSent && this.#relays.filter(relay => relay.read).every(relay => sub.eosed.has(relay.url))) {
          sub.eoseSent = true
          sub.onEose?.()
        }
      },
      onevent: event => {
        clearTimeout(stall)
        if (!active() || sub.seen.has(event.id)) return
        sub.seen.add(event.id)
        sub.onEvent(event, url)
      },
      onclose: () => { clearTimeout(stall); if (active()) binding.closed = true },
    })
    binding.stop = () => { clearTimeout(stall); handle.close() }
  }

  #recoverSubscriptions(): void {
    if (this.#closed || this.#subscriptions.size === 0) return
    const connected = this.#pool.listConnectionStatus()
    const now = Date.now()
    for (const relay of this.#relays) {
      if (!relay.read || this.#authError(relay.url) ||
          now - (this.#attempted.get(relay.url) ?? 0) < (this.#authentication.get(relay.url) && this.#health.get(relay.url)?.state === 'connecting' ? this.#authTimeout + 8_000 : 15_000)) continue
      if (connected.get(relay.url)) {
        // A publish can reconnect before this timer, but cannot restore the
        // subscriptions closed with the old socket. Rebind only dead readers;
        // keep healthy readers and in-flight publishes on this socket intact.
        const closed = [...this.#subscriptions].filter(sub => sub.bindings.get(relay.url)?.closed)
        if (closed.length) this.#attempted.set(relay.url, now)
        for (const sub of closed) this.#startRelay(sub, relay.url)
        continue
      }
      // Keep healthy relays and their consumers running. Replaying the
      // original filters catches missed events; each consumer retains its
      // deduplication set across reconnections, including same-second events.
      this.#pool.close([relay.url])
      this.#attempted.set(relay.url, now)
      for (const sub of this.#subscriptions) this.#startRelay(sub, relay.url)
    }
  }

  close(): void {
    this.#closed = true
    clearInterval(this.#recovery)
    this.#generation++
    this.#abort.abort()
    for (const sub of this.#subscriptions) this.#stop(sub)
    this.#subscriptions.clear()
    this.#pool.destroy()
  }
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** Backoff before retrying a relay whose publish timed out: quick first,
 *  then a steady 3s. Cycled (the last value repeats) rather than exhausted
 *  after two goes: a fixed retry COUNT means the last attempt lands wherever
 *  the arithmetic happens to put it, and a socket that comes back mid-window
 *  - a phone that was backgrounded for exactly the wrong number of seconds -
 *  can lose the race against it by a few hundred milliseconds and be judged
 *  unreachable anyway. `PUBLISH_RETRY_BUDGET_MS` below is the real limit. */
const RETRY_DELAYS_MS = [1_000, 3_000]

/** How long a fresh subscription waits for its own `EOSE` before treating
 *  the silence as a dropped `REQ` and reopening. Shorter than nostr-tools'
 *  own 8s `maxWait` (see `#startRelay`), which never resends anything - it
 *  only fabricates an `EOSE` once it gives up, leaving a relay that ignored
 *  the request genuinely unsubscribed. Longer than a relay's ordinary
 *  response time, so an unusually slow but working `REQ` is not mistaken
 *  for a dropped one. */
const SUBSCRIBE_STALL_MS = 5_000

/** How long the resend-on-stall watchdog keeps resending a `REQ` that never
 *  gets an `EOSE`, before it stops and leaves recovery to `#recoverSubscriptions`,
 *  a publish attempt's own retry, or the next scheduled `probe()` - the same
 *  ceiling philosophy as `PUBLISH_RETRY_BUDGET_MS` below, so a relay that is
 *  really gone is not resent to for ever. */
const SUBSCRIBE_STALL_BUDGET_MS = 20_000

/** How long `#publishToRelay` keeps reopening and retrying a relay that only
 *  ever times out, before it stops being a retry and starts being a real
 *  failure. Matches the join flow's own ~20s auto-retry window in
 *  app/src/main.ts, so one honest attempt covers the whole thing without
 *  needing that outer retry to paper over a per-relay budget that was too
 *  short. */
const PUBLISH_RETRY_BUDGET_MS = 20_000

/** Whether a publish failed without ever being answered - a timeout (no
 *  `OK` before `publishTimeout`), or the connection it was waiting on being
 *  closed out from under it (our own retry reopening that same url for
 *  another reason, `setRelays`, or the far end simply going away). Neither
 *  is the relay saying no; both are exactly what a suspect connection looks
 *  like, so both are retried the same way. An explicit `OK false` rejects
 *  with the relay's own reason instead, and is never mistaken for either. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.message === 'publish timed out' || error.message.startsWith('relay connection closed'))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
