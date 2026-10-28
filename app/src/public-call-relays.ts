/**
 * Finding public call relays over Nostr, on this device only
 * (docs/2026-10-25-public-relay-discovery.md).
 *
 * Off until the person turns it on. When on, one query goes to the read
 * relays of this device's own Connections list for operator-signed Spry
 * adverts; KithMoot ships no list of call relays and contacts no host of
 * its own for this. The person chooses a relay; the chosen operator issues
 * an hour-long login for a call, held in memory and dropped when the call
 * ends. Persisted: whether it is on, the last good relay (transport key and
 * hostname) and the replay watermarks. Adverts and logins are never stored,
 * published, shared or put in a room, link, invitation or descriptor, and
 * nothing here goes through `saveCallRelay`.
 */
import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import type { RelayConfig, RelayHealth } from '../../src/relay-pool.js'
import {
  PUBLIC_RELAY_IDENTIFIER, PUBLIC_RELAY_KIND, PUBLIC_RELAY_MAX_LIFETIME, PUBLIC_RELAY_MAX_TRACKED, PublicRelayAdvertBook,
  PublicRelayLoginFailed, fetchPublicRelayLogin, publicRelayHostAllowed, publicRelayPrivacyValid,
  type PublicRelayAdvert, type PublicRelayLogin, type PublicRelayLoginOptions, type PublicRelayWatermark,
} from '../../src/public-call-relays.js'

export const PUBLIC_CALL_RELAYS_KEY = 'kithmoot.public-call-relays.v1'
/** Client rule 5: at most 64 adverts considered. */
export const PUBLIC_RELAY_QUERY_LIMIT = 64
/** The one query closes at the end of stored events or after this long. */
export const PUBLIC_RELAY_QUERY_TIMEOUT_MS = 5000
/** Client rule 5: at most three credential endpoints for one call. */
export const PUBLIC_RELAY_CALL_OPERATORS = 3
/** A login with less than this left is not reused. */
const LOGIN_REUSE_MARGIN_SECONDS = 120

export const PUBLIC_RELAY_START_FAILED = 'The public call relay you chose did not answer, so this call uses the room’s usual connection.'
export const PUBLIC_RELAY_RENEW_FAILED = 'The public call relay did not renew its login. The call may lose its relay when the current login ends.'
export const PUBLIC_RELAY_LOST = 'Call relay lost: the public call relay’s login ended and could not be renewed. The call carries on without it where a direct connection works.'
export const PUBLIC_RELAY_LOST_RELAY_ONLY = 'Call relay lost: the public call relay’s login ended and could not be renewed. You chose to hide your IP address, so this call will not switch to a direct connection.'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface Saved { v: 1; on: true; lastGood?: { key: string; host: string }; watermarks: PublicRelayWatermark[] }

const HEX64 = /^[0-9a-f]{64}$/

function load(store: Store): Saved | undefined {
  try {
    const text = store.getItem(PUBLIC_CALL_RELAYS_KEY)
    if (text === null || text.length > 262_144) return undefined
    const value = JSON.parse(text) as Partial<Saved>
    if (!value || value.v !== 1 || value.on !== true) return undefined
    const lastGood = value.lastGood && typeof value.lastGood.key === 'string' && HEX64.test(value.lastGood.key) &&
      typeof value.lastGood.host === 'string' && publicRelayHostAllowed(value.lastGood.host)
      ? { key: value.lastGood.key, host: value.lastGood.host } : undefined
    const watermarks = Array.isArray(value.watermarks) ? value.watermarks.filter((mark): mark is PublicRelayWatermark =>
      !!mark && typeof mark === 'object' && typeof mark.key === 'string' && typeof mark.id === 'string' && typeof mark.createdAt === 'number')
      .slice(0, PUBLIC_RELAY_MAX_TRACKED) : []
    return { v: 1, on: true, ...(lastGood ? { lastGood } : {}), watermarks }
  } catch { return undefined }
}

/** The relays the one query goes to: this device's default Connections
 *  entries marked read, less any its health reports failing. Never a room's
 *  relays, an invitation's hints or a relay added for this. */
export function publicRelayQueryRelays(personal: readonly RelayConfig[], health: readonly RelayHealth[]): string[] {
  const failing = new Set(health.filter(relay => relay.state === 'disconnected' ||
    relay.readEvidence === 'refused' || relay.readEvidence === 'authentication-required').map(relay => relay.url))
  return personal.filter(relay => relay.read && !failing.has(relay.url)).map(relay => relay.url)
}

/** The pool scope for the query. No relay is ever granted NIP-42
 *  authentication in this scope, so the query goes over a connection that is
 *  not signed in and tells no relay which key searched. */
export const PUBLIC_CALL_RELAY_SCOPE = 'public-call-relays'
/** The query pool's relays: exactly these, read-only. Read-only also keeps
 *  them out of the rewrite that gives a legacy pair of room relays a third,
 *  so no relay is added for discovery. */
export function publicRelayPoolHints(urls: readonly string[]): RelayConfig[] {
  return urls.map(url => ({ url, read: true, write: false }))
}

export function publicRelayFilter(nowSeconds: number): Filter {
  return { kinds: [PUBLIC_RELAY_KIND], '#d': [PUBLIC_RELAY_IDENTIFIER], limit: PUBLIC_RELAY_QUERY_LIMIT, since: nowSeconds - PUBLIC_RELAY_MAX_LIFETIME }
}

export interface PublicRelayQueryPool {
  query(url: string, filters: Filter[], timeoutMs?: number, maxEvents?: number): Promise<{ events: Event[]; complete: boolean }>
}

/** One query to each relay, closed at the end of stored events or after
 *  5 seconds; no standing subscription. At most 64 adverts are kept, the
 *  newest, returned oldest first so a newer one supersedes in order. */
export async function queryPublicRelayAdverts(pool: PublicRelayQueryPool, urls: readonly string[], nowSeconds: number): Promise<unknown[]> {
  const filter = publicRelayFilter(nowSeconds)
  const settled = await Promise.allSettled(urls.map(url => pool.query(url, [filter], PUBLIC_RELAY_QUERY_TIMEOUT_MS, PUBLIC_RELAY_QUERY_LIMIT)))
  const byId = new Map<string, Event>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const event of result.value.events) if (event && typeof event.id === 'string' && !byId.has(event.id)) byId.set(event.id, event)
  }
  return [...byId.values()]
    .sort((a, b) => (b.created_at - a.created_at) || a.id.localeCompare(b.id))
    .slice(0, PUBLIC_RELAY_QUERY_LIMIT)
    .reverse()
}

/** Bidi controls, zero-width characters, the BOM and line or paragraph
 *  separators, which could reorder or hide what an operator's note says. */
const HIDDEN = /[\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g
export function cleanOperatorNote(note: string): string {
  return note.replace(HIDDEN, '').replace(/\p{Cc}/gu, '').trim()
}
export function shortTransportKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

/** A verified advert's privacy link with its hostname, or nothing when the
 *  host fails `publicRelayHostAllowed`: the advert is still listed. */
export function privacyLink(url: string | undefined): { url: string; host: string } | undefined {
  if (!url || !publicRelayPrivacyValid(url)) return undefined
  const host = url.slice('https://'.length, url.indexOf('/', 'https://'.length))
  return publicRelayHostAllowed(host) ? { url, host } : undefined
}

export interface PublicRelayListing {
  key: string
  shortKey: string
  /** ASCII; an internationalised name stays `xn--` encoded. */
  host: string
  /** The operator's own claim. */
  region?: string
  /** The operator's own claim, cleaned for display. */
  note?: string
  /** The operator's own privacy-notice link and its hostname, from the live
   *  advert only. Never fetched, persisted, or copied into the last good
   *  relay, a room, a descriptor, a link or an invitation. Absent when its
   *  host fails the rules a relay's own host must meet before any contact. */
  privacy?: { url: string; host: string }
  lastGood: boolean
  /** The last good relay's hostname, now advertised under another key. */
  knownHostNewKey: boolean
}

export interface PublicCallRelaysOptions {
  store: Store
  /** Runs the one discovery query and returns the raw events. */
  search: (nowSeconds: number) => Promise<unknown[]>
  fetch?: PublicRelayLoginOptions['fetch']
  now?: () => number
}

export class PublicCallRelays {
  #saved: Saved | undefined
  #book: PublicRelayAdvertBook
  #selected?: string
  #logins = new Map<string, PublicRelayLogin>()
  #searching?: Promise<PublicRelayListing[]>
  #searchedAt = 0
  #generation = 0
  constructor(private options: PublicCallRelaysOptions) {
    this.#saved = load(options.store)
    this.#book = new PublicRelayAdvertBook(PUBLIC_RELAY_MAX_TRACKED, this.#saved?.watermarks ?? [])
  }
  #now(): number { return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))() }
  get enabled(): boolean { return this.#saved !== undefined }
  get lastGood(): { key: string; host: string } | undefined { return this.#saved?.lastGood }
  get selected(): string | undefined { return this.#selected }
  get searchedAt(): number { return this.#searchedAt }
  #persist(): void {
    if (!this.#saved) return
    this.#saved = { ...this.#saved, watermarks: this.#book.watermarks(this.#now()) }
    try { this.options.store.setItem(PUBLIC_CALL_RELAYS_KEY, JSON.stringify(this.#saved)) } catch { /* Kept for this visit only. */ }
  }
  /** Turning it off forgets everything it kept: watermarks, the last good
   *  relay, adverts, the selection and any login. */
  setEnabled(on: boolean): void {
    this.#generation++
    this.#selected = undefined
    this.#logins.clear()
    this.#searching = undefined
    this.#searchedAt = 0
    this.#book = new PublicRelayAdvertBook()
    if (on) { this.#saved = { v: 1, on: true, watermarks: [] }; this.#persist() }
    else {
      this.#saved = undefined
      try { this.options.store.removeItem(PUBLIC_CALL_RELAYS_KEY) } catch { /* Nothing more to clear. */ }
    }
  }
  /** One discovery query; a second caller shares the one in flight. */
  discover(): Promise<PublicRelayListing[]> {
    if (!this.enabled) return Promise.reject(new Error('Public call relays are off.'))
    if (this.#searching) return this.#searching
    const generation = this.#generation
    const work = (async () => {
      const events = await this.options.search(this.#now())
      if (generation !== this.#generation) return []
      for (const event of events) { try { this.#book.accept(event, this.#now()) } catch { /* Refused: not shown. */ } }
      this.#searchedAt = Date.now()
      this.#persist()
      return this.listing()
    })()
    this.#searching = work
    void work.finally(() => { if (this.#searching === work) this.#searching = undefined }).catch(() => {})
    return work
  }
  #allowed(): PublicRelayAdvert[] {
    return this.#book.open(this.#now()).filter(advert => advert.host && publicRelayHostAllowed(advert.host))
  }
  /** What the picker shows. Sorted on this device only: the last good relay
   *  first, then by hostname. */
  listing(): PublicRelayListing[] {
    if (!this.enabled) return []
    const good = this.lastGood
    return this.#allowed().map(advert => {
      const note = advert.offer?.note !== undefined ? cleanOperatorNote(advert.offer.note) : ''
      const privacy = privacyLink(advert.privacy)
      return {
        key: advert.publicKey, shortKey: shortTransportKey(advert.publicKey), host: advert.host!,
        ...(advert.region ? { region: advert.region } : {}), ...(note ? { note } : {}), ...(privacy ? { privacy } : {}),
        lastGood: good?.key === advert.publicKey,
        knownHostNewKey: !!good && good.key !== advert.publicKey && good.host === advert.host,
      }
    }).sort((a, b) => Number(b.lastGood) - Number(a.lastGood) || a.host.localeCompare(b.host) || a.key.localeCompare(b.key))
      .slice(0, PUBLIC_RELAY_QUERY_LIMIT)
  }
  select(key: string | undefined): void { this.#selected = key && this.#allowed().some(advert => advert.publicKey === key) ? key : undefined }
  advert(key: string): PublicRelayAdvert | undefined {
    const advert = this.#book.openFrom(key, this.#now())
    return advert?.host && publicRelayHostAllowed(advert.host) ? advert : undefined
  }
  /** The relays this person chose that a call may use, in order, at most three. */
  callCandidates(): string[] {
    return [...new Set([this.#selected, this.lastGood?.key].filter((key): key is string => !!key))].slice(0, PUBLIC_RELAY_CALL_OPERATORS)
  }
  /** A login from the chosen operator: the one already held (from the
   *  check) while it is still good, otherwise a fresh one. */
  async login(key: string, fresh = false): Promise<PublicRelayLogin> {
    if (!this.enabled) throw new PublicRelayLoginFailed()
    const held = this.#logins.get(key)
    if (!fresh && held && held.expiresAt - this.#now() > LOGIN_REUSE_MARGIN_SECONDS) return held
    const advert = this.advert(key)
    if (!advert) throw new PublicRelayLoginFailed()
    const generation = this.#generation
    const login = await fetchPublicRelayLogin(advert, { fetch: this.options.fetch, now: () => this.#now() })
    if (generation !== this.#generation) throw new PublicRelayLoginFailed()
    this.#logins.set(key, login)
    return login
  }
  dropLogin(key: string): void { this.#logins.delete(key) }
  /** The relay worked: remember it, on this device only, as the last good one. */
  markGood(key: string): void {
    const advert = this.advert(key)
    if (!this.#saved || !advert?.host) return
    this.#saved = { ...this.#saved, lastGood: { key, host: advert.host } }
    this.#persist()
  }
  /** Stop using a public relay, keeping the switch on. */
  forgetChoice(): void {
    this.#selected = undefined
    this.#logins.clear()
    if (!this.#saved) return
    const { lastGood: _gone, ...rest } = this.#saved
    this.#saved = rest
    this.#persist()
  }
}

export type CallRelaySource = 'spry-pairing' | 'hand-entered' | 'room' | 'discovered' | 'default'
/** Which relay a call uses: a Spry pairing, then a hand-entered relay, then
 *  the room's own TURN or Spry offer, then a discovered relay, then the
 *  default. */
export function callRelaySource(state: { spryPairing: boolean; handEntered: boolean; roomTurn: boolean; spryOffer: boolean; discovered: boolean }): CallRelaySource {
  if (state.spryPairing) return 'spry-pairing'
  if (state.handEntered) return 'hand-entered'
  if (state.roomTurn || state.spryOffer) return 'room'
  if (state.discovered) return 'discovered'
  return 'default'
}
/** With a Spry pairing or a hand-entered relay present, no discovery query
 *  or login request is made at all. */
export function publicRelaysMayRun(state: { enabled: boolean; spryPairing: boolean; handEntered: boolean }): boolean {
  return state.enabled && !state.spryPairing && !state.handEntered
}

/** The ICE server for a discovered login: only the URLs the advert named. */
export function publicRelayIceServer(login: PublicRelayLogin): RTCIceServer {
  return { urls: [...login.urls], username: login.username, credential: login.credential }
}

export interface PublicRelayCallHooks {
  /** Puts the login's relay in the call, renews it in place, or (undefined)
   *  removes it. Must go through `callRelayPeerConnection` and the same
   *  WebKit filter for `setConfiguration`. */
  apply(login: PublicRelayLogin | undefined, why: 'start' | 'renew' | 'lost'): void
  /** Says something to the person: a failure is shown, never swallowed. */
  notice(text: string): void
  relayOnly: boolean
  /** Whether a higher-precedence relay has taken over (a Spry offer). */
  superseded?: () => boolean
  now?: () => number
  random?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * One call's use of a discovered relay. Started when the call starts,
 * renewed by the call's existing ICE refresh, dropped when the login lapses
 * or the call ends. Never fails over to anything but the relays this person
 * chose (at most three operators), never searches again mid-call and never
 * turns a relay-only call direct.
 */
export class PublicRelayCall {
  #login?: PublicRelayLogin
  #lapse?: unknown
  #renewing?: Promise<void>
  #ended = false
  #contacted = new Set<string>()
  constructor(private relays: PublicCallRelays, private hooks: PublicRelayCallHooks) {}
  #now(): number { return (this.hooks.now ?? (() => Math.floor(Date.now() / 1000)))() }
  get active(): boolean { return this.#login !== undefined }
  get login(): PublicRelayLogin | undefined { return this.#login }
  #schedule(login: PublicRelayLogin): void {
    const clear = this.hooks.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    const set = this.hooks.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    if (this.#lapse !== undefined) clear(this.#lapse)
    this.#lapse = set(() => this.#lost(login), Math.max(0, (login.expiresAt - this.#now()) * 1000))
  }
  #lost(login: PublicRelayLogin): void {
    if (this.#ended || this.#login !== login) return
    this.#login = undefined
    this.#lapse = undefined
    this.relays.dropLogin(login.key)
    this.hooks.apply(undefined, 'lost')
    this.hooks.notice(this.hooks.relayOnly ? PUBLIC_RELAY_LOST_RELAY_ONLY : PUBLIC_RELAY_LOST)
  }
  /** Tries the chosen relays in order. A relay whose advert is not in hand
   *  costs one discovery query for the whole start, never one per relay. */
  async start(): Promise<boolean> {
    const candidates = this.relays.callCandidates()
    if (this.#ended || candidates.length === 0) return false
    let searched = false
    for (const key of candidates) {
      if (this.#ended || this.hooks.superseded?.()) return false
      if (!this.#contacted.has(key) && this.#contacted.size >= PUBLIC_RELAY_CALL_OPERATORS) break
      if (!this.relays.advert(key) && !searched) {
        searched = true
        try { await this.relays.discover() } catch { /* Shown below if nothing works. */ }
        if (this.#ended) return false
      }
      if (!this.relays.advert(key)) continue
      this.#contacted.add(key)
      try {
        const login = await this.relays.login(key)
        if (this.#ended || this.hooks.superseded?.()) return false
        this.#login = login
        this.relays.markGood(key)
        this.hooks.apply(login, 'start')
        this.#schedule(login)
        return true
      } catch { /* Next chosen relay, if any. */ }
    }
    if (!this.#ended) this.hooks.notice(PUBLIC_RELAY_START_FAILED)
    return false
  }
  /** Called from the call's ICE refresh. Renews from the same operator when
   *  the login would not outlast the next refresh, with jitter, retrying a
   *  429 before the login ends. */
  renew(refreshIntervalMs: number): Promise<void> {
    if (this.#renewing) return this.#renewing
    const login = this.#login
    if (!login || this.#ended) return Promise.resolve()
    if (login.expiresAt - this.#now() > refreshIntervalMs / 1000 + 600) return Promise.resolve()
    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const random = this.hooks.random ?? Math.random
    const work = (async () => {
      await sleep(Math.floor(random() * 30_000))
      let wait = 10_000
      for (;;) {
        if (this.#ended || this.#login !== login || this.hooks.superseded?.()) return
        try {
          const fresh = await this.relays.login(login.key, true)
          if (this.#ended || this.#login !== login || this.hooks.superseded?.()) return
          this.#login = fresh
          this.hooks.apply(fresh, 'renew')
          this.#schedule(fresh)
          return
        } catch (error) {
          const busy = error instanceof PublicRelayLoginFailed && error.busy
          if (!busy || this.#now() + wait / 1000 >= login.expiresAt - 30) {
            if (!this.#ended && this.#login === login) this.hooks.notice(PUBLIC_RELAY_RENEW_FAILED)
            return
          }
          await sleep(wait)
          wait *= 2
        }
      }
    })()
    this.#renewing = work
    void work.finally(() => { this.#renewing = undefined })
    return work
  }
  /** The call ended, or something with higher precedence took over: the
   *  login is dropped from memory. The caller restores the call's servers. */
  end(): void {
    this.#ended = true
    if (this.#lapse !== undefined) (this.hooks.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.#lapse)
    this.#lapse = undefined
    if (this.#login) this.relays.dropLogin(this.#login.key)
    this.#login = undefined
  }
}
