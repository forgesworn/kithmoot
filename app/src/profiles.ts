import { NostrRelayPool, verifyEventUncached, sanitiseDisplayName } from '../../src/index.js'
import type { RelayPoolClient } from '../../src/relay-pool.js'
import type { Event } from 'nostr-tools/pure'
import { normalizeURL } from 'nostr-tools/utils'
import { newerProfile } from './people-profile-cache.js'

/**
 * Nostr profiles (kind 0) for the people in a room.
 *
 * This is the only thing in the app that can tell a **published Nostr
 * identity** apart from a key this browser generated five seconds ago: a
 * kind-0 event signed by that key and sitting on a relay. Nothing about the
 * roster carries that distinction, and nothing could - two participant
 * pubkeys look identical on the wire.
 *
 * Be precise about what it proves. A kind-0 `name` is **still
 * self-asserted**: it says "the holder of this key calls themselves
 * Robin", exactly as a typed name says "whoever is at this keyboard calls
 * themselves Robin". The difference is only that the key is persistent and
 * has a history - which is worth something, and is not the same as being
 * verified. The app labels it accordingly and never as "verified".
 *
 * **And be precise about what it costs, because it is not free.** The
 * lookup is a relay subscription filtered by `authors`. For the people in the
 * room on screen it is sent to that room's own relays plus a fixed set of
 * public aggregator relays - see `LookupScope`, `ProfileBookOptions.relays`,
 * and `PROFILE_RELAYS` in `app/src/main.ts` for the added ones (purplepag.es
 * and the general public relays). That hands all of those relays the
 * participant pubkeys of everybody in the room, in the clear, as a query.
 * For anybody else - the people in the chats list, People, who wrote an
 * invitation - it goes to the public relays alone, so the relays a room runs
 * do not learn who its members talk to somewhere else.
 *
 * The room's own design goes to some trouble to avoid exactly that: a
 * device credential is never published, precisely so "relays never see the
 * participant pubkey" (`KINDS.CREDENTIAL`), and the roster it travels in is
 * encrypted to the room key. A relay carrying a room therefore sees the
 * room id and the timing of its roster events, and - because of this file
 * and nothing else - can also learn which participant keys are in it.
 *
 * Directory lookups require the saved profile preference (Settings,
 * Privacy). Disabling closes those subscriptions and removes other people's
 * cached profiles and external pictures. AccountProfileBook owns a separate
 * book for the selected account's own metadata while Nostr networking is
 * enabled; private invitations closes both paths.
 *
 * NIP-05 checks are the exception to every other lookup this book makes:
 * verifying `name@domain` fetches `https://domain/.well-known/nostr.json`,
 * and the domain is chosen by the person being looked up. A hostile `nip05`
 * value therefore makes every room peer's client contact a server the
 * claimant controls, learning their IP, timing and rough fingerprint - a
 * de-anonymisation vector aimed back at the room, not just decoration.
 * So the check is never automatic: claims are held unverified until the
 * person turns "Verify Nostr addresses" on in settings, which then checks
 * every claim already held. Turning it back off aborts checks in flight,
 * and a late answer is ignored. It cannot undo a request already sent.
 *
 * Anything built on top of this - a lookup keyed on participant pubkeys for
 * any other purpose - inherits the same cost and does not add a new one.
 */
export interface Profile {
  /** From kind 0's `display_name` or `name`, sanitised like any other. */
  name?: string
  /** An `http:`/`https:` picture URL. Anything else is dropped. */
  picture?: string
  /** NIP-05 address, included only after its domain maps it to this key. */
  nip05?: string
}

/** How long a lookup has to produce an answer before "no profile" is the answer. */
const LOOKUP_TIMEOUT_MS = 15_000
const ADDRESS_TIMEOUT_MS = 5_000
const LOOKUP_RETRY_MS = [1_000, 5_000]
const PUBLIC_BATCH_SIZE = 48
const PUBLIC_BATCH_PAUSE_MS = 1_000

/** Only these schemes are ever put in an `<img src>`. */
const PICTURE_SCHEMES = ['http://', 'https://']

/**
 * Whose relays a lookup may be sent to.
 *
 * - `room`: the person is in the room on screen. The room's own relays are
 *   asked as well as the public ones, as the relay best placed to know them.
 * - `public`: the person is somebody else - in another chat, a contact, an
 *   account the person follows, the sender of an invitation, or the person
 *   using this browser. Only the public profile relays are asked, because
 *   anything else would tell the relays of whichever room happens to be open
 *   who this browser is interested in.
 *
 * There is no default: a caller has to say which it is.
 */
export type LookupScope = 'room' | 'public'

export interface ProfileBookOptions {
  /** The relays a `room` lookup asks: the room's own, then the public ones.
   *  Read lazily, because a room carries its own relay hints and a lookup
   *  should use the relays the room is actually on rather than whatever
   *  the app defaulted to before the link was opened. It is expected to
   *  include `publicRelays`: a key already asked here is not asked again
   *  on the public relays alone. */
  relays: () => string[]
  /** The relays a `public` lookup asks, and nothing else. */
  publicRelays: () => string[]
  /** Called when a lookup changed something worth re-rendering. */
  onChange: () => void
  /** Opens the pool for one scope's relays. Each scope has its own, so
   *  leaving a room can close its sockets and leave the public ones. */
  transport?: (relays: string[], scope: LookupScope) => RelayPoolClient
  /** May this profile initiate a request to its own address domain? */
  verifyAddress?: (pubkey: string) => boolean
  /** A device cache for the eligible authors from public queries. */
  publicCache?: {
    read(authors: string[]): readonly { event: Event; fresh: boolean }[]
    keep(event: Event): void
  }
}

const SCOPES: readonly LookupScope[] = ['room', 'public']

export class ProfileBook {
  readonly #opts: ProfileBookOptions
  readonly #pools: Partial<Record<LookupScope, RelayPoolClient>> = {}
  readonly #unsubs: Record<LookupScope, Set<() => void>> = { room: new Set(), public: new Set() }
  /** Pubkeys we have asked about, whether or not an answer came back, by
   *  the scope they were asked in. */
  readonly #asked: Record<LookupScope, Set<string>> = { room: new Set(), public: new Set() }
  readonly #timers: Record<LookupScope, Set<ReturnType<typeof setTimeout>>> = { room: new Set(), public: new Set() }
  readonly #found = new Map<string, { profile: Profile; event: Pick<Event, 'created_at' | 'id'>; nip05Claim?: string }>()
  readonly #publicPending = new Map<string, number>()
  #publicBusy = false
  #checks = new Set<AbortController>()
  #closed = false
  #enabled = true
  #paused = false
  #nip05Automatic = false

  constructor(opts: ProfileBookOptions) {
    this.#opts = opts
  }

  pause(): void {
    if (this.#paused) return
    this.#paused = true
    for (const check of this.#checks) check.abort()
    this.#checks.clear()
    for (const scope of SCOPES) {
      this.#closeScope(scope)
      this.#asked[scope].clear()
    }
  }

  resume(): void { this.#paused = false }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (enabled) return
    for (const check of this.#checks) check.abort()
    this.#checks.clear()
    for (const scope of SCOPES) {
      this.#closeScope(scope)
      this.#asked[scope].clear()
    }
    this.#found.clear()
  }

  /**
   * Start the room's lookups again from its relays as they are now, for a
   * different room or none: the sockets opened for the room just left are
   * closed, and who was asked about there is forgotten, so the next room's
   * people are asked afresh on its own relays. What has been learned stays
   * on screen. Switching lookups off is what forgets it.
   *
   * The public scope is left alone. It asks the same public profile relays
   * whichever room is open, so closing it here bought nothing and cost a
   * lot: a room switch restarts the book twice (leaving one room, then
   * opening the next), and each time the public pool was reopened for the
   * account and closed again before its sockets had connected, then every
   * public key was asked about again.
   */
  restartRoom(): void {
    if (this.#closed) return
    this.#closeScope('room')
    this.#asked.room.clear()
  }

  #closeScope(scope: LookupScope): void {
    for (const timer of this.#timers[scope]) clearTimeout(timer)
    this.#timers[scope].clear()
    for (const unsub of this.#unsubs[scope]) unsub()
    this.#unsubs[scope].clear()
    this.#pools[scope]?.close()
    delete this.#pools[scope]
    if (scope === 'public') {
      this.#publicPending.clear()
      this.#publicBusy = false
    }
  }

  /**
   * Whether claimed NIP-05 addresses are verified automatically. Off unless
   * the person switches it on: the check fetches from the claimed address's
   * domain (controlled by whoever published the profile), so an attacker in
   * a room could otherwise make every peer's client call a server they run.
   * Switching on checks every claim already held; switching back off aborts
   * checks in flight. Addresses already verified stay verified. See the
   * module header.
   */
  setNip05Automatic(automatic: boolean): void {
    if (automatic === this.#nip05Automatic) return
    this.#nip05Automatic = automatic
    if (this.#closed || !this.#enabled || this.#paused) return
    if (!automatic) {
      for (const check of this.#checks) check.abort()
      this.#checks.clear()
      return
    }
    for (const [pubkey, found] of this.#found) {
      if (found.nip05Claim !== undefined && found.profile.nip05 === undefined) {
        void this.#checkAddress(pubkey, found.profile, found.nip05Claim)
      }
    }
  }

  /** Look up any of these we have not already asked about, on the relays
   *  `scope` allows. Cheap to call on every render; it does nothing for a
   *  pubkey it has already seen. A key asked in `room` scope has been asked
   *  on the public relays too, so `public` skips it; a key asked only in
   *  `public` scope is still asked of the room's relays when it turns up
   *  in the room. */
  want(pubkeys: string[], scope: LookupScope): void {
    if (this.#closed || !this.#enabled || this.#paused) return
    const fresh = [...new Set(pubkeys)].filter((p) => !this.#asked.room.has(p) && (scope === 'room' || !this.#asked.public.has(p)))
    if (fresh.length === 0) return
    for (const pubkey of fresh) this.#asked[scope].add(pubkey)
    const usable = new Set<string>()
    let restored = false
    if (scope === 'public' && this.#opts.publicCache) {
      const requested = new Set(fresh)
      for (const { event, fresh: checked } of this.#opts.publicCache.read(fresh)) {
        if (!requested.has(event.pubkey) || !this.#ingest(event, false)) continue
        restored = true
        if (checked) usable.add(event.pubkey)
      }
    }
    const pending = fresh.filter(key => !usable.has(key))
    if (scope === 'public') {
      this.#queuePublic(pending, 0)
    } else if (pending.length) this.#lookup(pending, scope, 0)
    if (restored) queueMicrotask(() => { if (this.#enabled && !this.#closed) this.#opts.onChange() })
  }

  #queuePublic(pubkeys: string[], attempt: number): void {
    for (const key of pubkeys) this.#publicPending.set(key, attempt)
    this.#nextPublicBatch()
  }

  /** Opening People can queue a whole follow list. Read one small batch at
   * a time, including when new senders arrive while a batch is in flight. */
  #nextPublicBatch(): void {
    if (this.#publicBusy || !this.#enabled || this.#closed || this.#paused || !this.#publicPending.size) return
    const batch: string[] = []
    let attempt: number | undefined
    for (const [key, queuedAttempt] of this.#publicPending) {
      if (attempt !== undefined && queuedAttempt !== attempt) break
      this.#publicPending.delete(key)
      if (this.#asked.room.has(key) || queuedAttempt > 0 && this.#found.has(key)) continue
      attempt = queuedAttempt
      batch.push(key)
      if (batch.length === PUBLIC_BATCH_SIZE) break
    }
    if (attempt === undefined) return
    this.#publicBusy = true
    this.#lookup(batch, 'public', attempt, () => {
      this.#later('public', PUBLIC_BATCH_PAUSE_MS, () => {
        this.#publicBusy = false
        this.#nextPublicBatch()
      })
    })
  }

  #later(scope: LookupScope, delay: number, work: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers[scope].delete(timer)
      work()
    }, delay)
    this.#timers[scope].add(timer)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return timer
  }

  #lookup(pubkeys: string[], scope: LookupScope, attempt: number, publicBatchDone?: () => void): void {
    if (this.#closed || !this.#enabled || this.#paused) return
    const retry = () => {
      const missing = pubkeys.filter(key => !this.#found.has(key))
      const delay = LOOKUP_RETRY_MS[attempt]
      if (missing.length && delay !== undefined) this.#later(scope, delay, () => {
        if (scope === 'public') this.#queuePublic(missing, attempt + 1)
        else this.#lookup(missing, scope, attempt + 1)
      })
    }

    // Lazily, so a browser that never opens a room never opens a socket.
    // And guarded: a profile is decoration, and a relay that cannot be
    // opened - a blocked host, a bad URL, a browser that refuses the
    // socket - must never take the door or the room down with it. The
    // caller is `render()`.
    let unsub: () => void
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (ended: boolean) => {
      if (!this.#unsubs[scope].delete(unsub)) return
      if (timeout !== undefined) { clearTimeout(timeout); this.#timers[scope].delete(timeout) }
      unsub()
      if (!ended) retry()
      publicBatchDone?.()
    }
    try {
      const urls = uniqueRelays(scope === 'room' ? this.#opts.relays() : this.#opts.publicRelays())
      const pool = this.#pools[scope] ??= this.#opts.transport?.(urls, scope) ?? new NostrRelayPool(urls)
      const requested = new Set(pubkeys)
      unsub = pool.subscribe([{ kinds: [0], authors: pubkeys, ...(publicBatchDone ? { limit: pubkeys.length } : {}) }], event => {
        if (!requested.has(event.pubkey) || !this.#ingest(event)) return
        if (scope === 'public' && this.#enabled) this.#opts.publicCache?.keep(event)
      }, publicBatchDone ? () => queueMicrotask(() => finish(true)) : undefined)
    } catch {
      retry()
      publicBatchDone?.()
      return
    }
    this.#unsubs[scope].add(unsub)

    // Public reads finish at EOSE or the deadline. Missing profiles on
    // timed-out batches can retry through the same queue.
    timeout = this.#later(scope, LOOKUP_TIMEOUT_MS, () => finish(false))
  }

  get(pubkey: string): Profile | undefined {
    return this.#enabled && !this.#paused ? this.#found.get(pubkey)?.profile : undefined
  }

  /** An explicit People search found a profile for someone already listed. */
  rememberPublic(event: Event): void {
    if (this.#ingest(event)) this.#opts.publicCache?.keep(event)
  }

  close(): void {
    this.#closed = true
    for (const check of this.#checks) check.abort()
    this.#checks.clear()
    for (const scope of SCOPES) this.#closeScope(scope)
  }

  async #checkAddress(pubkey: string, profile: Profile, value: unknown): Promise<void> {
    if (this.#paused || typeof value !== 'string' || this.#opts.verifyAddress?.(pubkey) === false) return
    const match = /^([a-z0-9_.-]+)@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.exec(value)
    if (!match || value.length > 254) return
    const [, name, domain] = match
    const controller = new AbortController()
    this.#checks.add(controller)
    const timer = setTimeout(() => controller.abort(), ADDRESS_TIMEOUT_MS)
    try {
      const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name!)}`, {
        signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      if (!response.ok) return
      const body = await response.json()
      if (body?.names?.[name!] !== pubkey) return
      // A response for an older profile, a disabled lookup or verification
      // switched back off mid-flight cannot put metadata on screen.
      if (controller.signal.aborted || this.#closed || !this.#enabled || !this.#nip05Automatic || this.#found.get(pubkey)?.profile !== profile) return
      profile.nip05 = value
      this.#opts.onChange()
    } catch { /* An unreachable domain is not a confirmed Nostr address. */ }
    finally { clearTimeout(timer); this.#checks.delete(controller) }
  }

  /** Never throws: this runs inside a relay subscription handler. */
  #ingest(event: Event, notify = true): boolean {
    try {
      if (this.#closed || !this.#enabled || this.#paused) return false
      if (event.kind !== 0 || event.created_at > Math.floor(Date.now() / 1000) + 60) return false
      // The pool filters by author, but a relay is not obliged to honour a
      // filter and a signature is the only thing that actually binds this
      // profile to that key.
      if (!verifyEventUncached(event)) return false

      const existing = this.#found.get(event.pubkey)
      if (existing && !newerProfile(event, existing.event)) return existing.event.id === event.id

      const content = JSON.parse(event.content) as Record<string, unknown>
      const profile: Profile = {
        // A kind-0 name is attacker-controlled text off a relay exactly as
        // a roster name is, and gets exactly the same treatment.
        name: sanitiseDisplayName(content.display_name) ?? sanitiseDisplayName(content.name),
        picture: safePicture(content.picture),
      }
      // The claim is kept (a settings switch may later verify it); the
      // fetch it describes runs only when verification is switched on.
      const claim = typeof content.nip05 === 'string' ? content.nip05 : undefined
      this.#found.set(event.pubkey, { profile, event: { id: event.id, created_at: event.created_at }, ...(claim !== undefined ? { nip05Claim: claim } : {}) })
      if (notify) this.#opts.onChange()
      if (this.#nip05Automatic) void this.#checkAddress(event.pubkey, profile, content.nip05)
      return true
    } catch {
      // A malformed profile is a missing profile, not a broken room.
      return false
    }
  }
}

/**
 * The room's relays come back from the settings store normalised, with a
 * trailing slash; the public profile relays are written without one. The
 * same relay under both spellings is one relay to the pool, which refuses
 * a list that names it twice - and that refusal was swallowed above as "a
 * relay that cannot be opened", so no profile was ever looked up while the
 * room shared a relay with the public list, which the defaults do.
 */
function uniqueRelays(urls: string[]): string[] {
  const seen = new Set<string>()
  return urls.filter((url) => {
    let key: string
    try { key = normalizeURL(url) } catch { key = url }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function safePicture(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  // A profile is somebody else's JSON. `data:` and `javascript:` have no
  // business in an <img src> that this page renders.
  return PICTURE_SCHEMES.some((scheme) => url.toLowerCase().startsWith(scheme)) ? url : undefined
}
