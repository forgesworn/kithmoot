/**
 * Public call relays: Spry's public-mode adverts (Nostr kind 31478) and the
 * hour-long login an operator's endpoint issues.
 *
 * `verifyPublicRelayAdvert` and `PublicRelayAdvertBook` are a port of
 * spry-turn `crates/spry-link/src/advert.rs` (client rules 2 to 4 and the
 * replay watermark of `docs/public-mode.md`), tested against spry-turn's
 * `docs/fixtures/public-advert-v1.json` so the two implementations agree.
 * Nothing here opens a socket except `fetchPublicRelayLogin`, which contacts
 * only the credential endpoint of an advert that already verified.
 *
 * A signature names the key that made the statement. It says nothing about
 * the operator's identity, honesty, uptime, logging or jurisdiction, and the
 * region, note and privacy link are the operator's own claims. Nothing here
 * ever fetches the privacy link (client rule 8).
 */
import type { Event } from 'nostr-tools/pure'
import { verifyEventUncached } from './verify.js'

export const PUBLIC_RELAY_KIND = 31478
export const PUBLIC_RELAY_IDENTIFIER = 'spry-turn'
export const PUBLIC_RELAY_CREDENTIAL_PATH = '/v1/public/credentials'
/** Largest serialised advert a client accepts. */
export const MAX_PUBLIC_RELAY_ADVERT = 4096
/** Longest permitted gap between `created_at` and `expiration`. */
export const PUBLIC_RELAY_MAX_LIFETIME = 2 * 60 * 60
/** Furthest a `created_at` may sit ahead of the reader's clock. */
export const PUBLIC_RELAY_MAX_FUTURE = 10 * 60
export const PUBLIC_RELAY_MAX_NOTE = 140
export const PUBLIC_RELAY_MAX_URLS = 4
const MAX_URL = 256
/** Longest operator privacy-notice link. */
export const PUBLIC_RELAY_MAX_PRIVACY = 256
/** Last labels a privacy link, like a credential endpoint, may not end in. */
const RESERVED_SUFFIXES = ['local', 'localhost', 'internal', 'invalid', 'test']
/** TURN ports a client will contact. Omitted means the scheme's default. */
export const PUBLIC_RELAY_TURN_PORTS: readonly string[] = ['3478', '5349', '443']
const MAX_EXPIRATION_DIGITS = 16
/** Hard ceiling on transport keys one book tracks. */
export const PUBLIC_RELAY_MAX_TRACKED = 1024
/** spry-link's `MAX_EVENT`, which bounds `content` in its shape check. */
const MAX_EVENT = 24_576

/** Spry's public logins last an hour. */
export const PUBLIC_RELAY_LOGIN_SECONDS = 3600
/** Clock slack allowed on a login's `expiresAt`. */
export const PUBLIC_RELAY_LOGIN_SLACK_SECONDS = 60
export const PUBLIC_RELAY_LOGIN_TIMEOUT_MS = 4000
export const PUBLIC_RELAY_LOGIN_LIMIT = 4096

/** The refusal names spry-link uses, so the fixture's verdicts compare directly. */
export type PublicRelayRefusal = 'Key' | 'Size' | 'Encoding' | 'Authentication' | 'Expired' | 'Destination' | 'Overload' | 'Replay'

export class PublicRelayRefused extends Error {
  constructor(readonly reason: PublicRelayRefusal) {
    super(`public call relay advert refused: ${reason}`)
    this.name = 'PublicRelayRefused'
  }
}
const refuse = (reason: PublicRelayRefusal): never => { throw new PublicRelayRefused(reason) }

/** What an open advert offers. */
export interface PublicRelayOffer { credentials: string; urls: string[]; note?: string }
/** A verified advert. */
export interface PublicRelayAdvert {
  publicKey: string
  createdAt: number
  expiresAt: number
  /** The operator's own claim, never verified. */
  region?: string
  /** The operator's own privacy-notice link, never fetched: shown with its
   *  hostname and opened only when the person taps it. */
  privacy?: string
  status: 'open' | 'withdrawn'
  /** Present exactly when `status` is `open`. */
  offer?: PublicRelayOffer
  /** The hostname every URL in the offer shares, when open. */
  host?: string
}

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length

export function publicRelayRegionValid(region: string): boolean {
  return /^[A-Z]{2}$/.test(region)
}
export function publicRelayNoteValid(note: string): boolean {
  return bytes(note) <= PUBLIC_RELAY_MAX_NOTE && !/\p{Cc}/u.test(note)
}

/** A DNS label as adverts accept it (spry-link's `label_valid`): lowercase
 *  letters, digits and inner hyphens, and no `xn--` prefix. */
function labelValid(label: string): boolean {
  return /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith('-') && !label.endsWith('-') && !label.startsWith('xn--')
}

/**
 * spry-link's `privacy_valid`: `https://`, a DNS name of two or more labels
 * whose last starts with a letter and is not reserved, and a path of
 * `[A-Za-z0-9._~/-]` with no empty, `.` or `..` segment, at most 256 bytes.
 * So no userinfo, port, query, fragment, percent-escape, uppercase host or
 * trailing dot, and the string is its own canonical form.
 */
export function publicRelayPrivacyValid(link: string): boolean {
  if (typeof link !== 'string' || bytes(link) > PUBLIC_RELAY_MAX_PRIVACY || !link.startsWith('https://')) return false
  const rest = link.slice('https://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return false
  const host = rest.slice(0, slash), path = rest.slice(slash)
  const labels = host.split('.')
  const last = labels[labels.length - 1]!
  if (labels.length < 2 || !labels.every(labelValid) || !/^[a-z]/.test(last) || RESERVED_SUFFIXES.includes(last)) return false
  if (!/^[A-Za-z0-9._~/-]*$/.test(path) || path.includes('//') || path.slice(1).split('/').some(segment => segment === '.' || segment === '..')) return false
  try { return new URL(link).href === link } catch { return false }
}

/** Static checks only; spry-link's `credential_host`. */
function credentialHost(endpoint: string): string {
  if (bytes(endpoint) > MAX_URL) refuse('Size')
  let url: URL
  try { url = new URL(endpoint) } catch { return refuse('Destination') }
  const host = url.hostname
  const labels = host.split('.')
  const suffix = labels[labels.length - 1]!
  if (url.protocol !== 'https:'
    // Only the canonical spelling: no explicit port, even :443.
    || url.href !== endpoint
    || url.username !== '' || url.password !== '' || url.port !== ''
    || url.search !== '' || url.hash !== ''
    || url.pathname !== PUBLIC_RELAY_CREDENTIAL_PATH
    || labels.length < 2
    || labels.some(label => label.length === 0 || label.length > 63 || !/^[A-Za-z0-9-]+$/.test(label)
      // Punycode labels are refused, as Android always has.
      || /^xn--/i.test(label))
    // An all-digit last label is an IPv4 literal; a bracketed IPv6 one fails the label check.
    || /^[0-9]+$/.test(suffix)
    || ['local', 'localhost', 'internal', 'invalid', 'test'].includes(suffix)) refuse('Destination')
  return host
}

const asciiFold = (value: string): string => value.replace(/[A-Z]/g, letter => letter.toLowerCase())

/** spry-link's `turn_host`, parsed by hand, ASCII only. */
function turnHost(uri: string): string {
  if (bytes(uri) > MAX_URL) refuse('Size')
  if (!/^[\x21-\x7e]*$/.test(uri)) refuse('Destination')
  let secure: boolean, rest: string
  if (uri.startsWith('turns:')) { secure = true; rest = uri.slice(6) }
  else if (uri.startsWith('turn:')) { secure = false; rest = uri.slice(5) }
  else return refuse('Destination')
  const question = rest.indexOf('?')
  const address = question < 0 ? rest : rest.slice(0, question)
  const query = question < 0 ? undefined : rest.slice(question + 1)
  if (!(query === undefined || query === 'transport=tcp' || (query === 'transport=udp' && !secure))) refuse('Destination')
  const colon = address.lastIndexOf(':')
  if (colon < 0) return address
  // Exact spellings only, so no leading zeros or signs.
  if (!PUBLIC_RELAY_TURN_PORTS.includes(address.slice(colon + 1))) refuse('Destination')
  return address.slice(0, colon)
}

/** Rule 4 of docs/public-mode.md, plus the note and size bounds. Returns the
 *  hostname the endpoint and every TURN URL share. */
export function validatePublicRelayOffer(offer: PublicRelayOffer): string {
  const host = credentialHost(offer.credentials)
  if (offer.urls.length < 1 || offer.urls.length > PUBLIC_RELAY_MAX_URLS) refuse('Size')
  for (const uri of offer.urls) if (asciiFold(turnHost(uri)) !== asciiFold(host)) refuse('Destination')
  if (offer.note !== undefined && !publicRelayNoteValid(offer.note)) refuse('Size')
  return host
}

/** The keys of the top-level JSON object in `text`, in order, duplicates
 *  included: serde refuses a repeated field where `JSON.parse` keeps the last. */
function topLevelKeys(text: string): string[] {
  const keys: string[] = []
  let depth = 0, expectKey = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (depth === 1 && expectKey) { keys.push(JSON.parse(text.slice(index, end + 1)) as string); expectKey = false }
      index = end
    } else if (char === '{' || char === '[') { depth++; if (depth === 1 && char === '{') expectKey = true }
    else if (char === '}' || char === ']') depth--
    else if (char === ',' && depth === 1) expectKey = true
  }
  return keys
}

function parseOffer(content: string): PublicRelayOffer {
  let value: unknown
  try { value = JSON.parse(content) } catch { return refuse('Encoding') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Encoding')
  const keys = topLevelKeys(content)
  if (new Set(keys).size !== keys.length || keys.some(key => !['credentials', 'urls', 'note'].includes(key))) refuse('Encoding')
  const { credentials, urls, note } = value as Record<string, unknown>
  if (typeof credentials !== 'string' || !Array.isArray(urls) || urls.some(url => typeof url !== 'string') ||
      !(note === undefined || note === null || typeof note === 'string')) refuse('Encoding')
  return { credentials: credentials as string, urls: [...urls as string[]], ...(typeof note === 'string' ? { note } : {}) }
}

/** spry-link's `Event::tag`: exactly one tag of that name, of two elements. */
function tag(event: Event, name: string, missing: PublicRelayRefusal = 'Destination'): string {
  const matches = event.tags.filter(entry => entry[0] === name)
  if (matches.length === 0) refuse(missing)
  if (matches.length > 1 || matches[0]!.length !== 2) refuse(missing)
  return matches[0]![1]!
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/** The seven signed fields, freshly copied, or a refusal if the value cannot
 *  be a Nostr event at all (which spry-link refuses when it parses). */
function eventFields(value: unknown): Event {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Encoding')
  const raw = value as Record<string, unknown>
  const { id, pubkey, created_at, kind, tags, content, sig } = raw
  if (typeof id !== 'string' || typeof pubkey !== 'string' || typeof sig !== 'string' || typeof content !== 'string' ||
      typeof created_at !== 'number' || !Number.isSafeInteger(created_at) || created_at < 0 ||
      typeof kind !== 'number' || !Number.isSafeInteger(kind) || kind < 0 || kind > 65_535 ||
      !Array.isArray(tags) || tags.some(entry => !Array.isArray(entry) || entry.some(item => typeof item !== 'string'))) refuse('Encoding')
  return { id: id as string, pubkey: pubkey as string, created_at: created_at as number, kind: kind as number,
    tags: (tags as string[][]).map(entry => [...entry]), content: content as string, sig: sig as string }
}

/** Client rules 2 and 4 for one event. Rule 3 needs history: use the book. */
export function verifyPublicRelayAdvert(value: unknown, now: number): PublicRelayAdvert {
  const event = eventFields(value)
  // The UTF-8 length of the seven-field JSON, checked before anything else.
  if (bytes(JSON.stringify(event)) > MAX_PUBLIC_RELAY_ADVERT) refuse('Size')
  if (bytes(event.content) > MAX_EVENT - 1024 || event.tags.length > 8 ||
      event.tags.some(entry => entry.length === 0 || entry.length > 3 || entry.some(item => bytes(item) > 256))) refuse('Size')
  if (!HEX64.test(event.id) || !HEX64.test(event.pubkey) || !HEX128.test(event.sig)) refuse('Encoding')
  let signed = false
  try { signed = verifyEventUncached({ ...event }) } catch { signed = false }
  if (!signed) refuse('Authentication')
  if (event.kind !== PUBLIC_RELAY_KIND || tag(event, 'd') !== PUBLIC_RELAY_IDENTIFIER ||
      tag(event, 'v') !== '1' || tag(event, 'auth') !== 'public') refuse('Destination')
  const expiration = tag(event, 'expiration', 'Expired')
  // Digits only: no sign, space or other character.
  if (expiration.length < 1 || expiration.length > MAX_EXPIRATION_DIGITS || !/^[0-9]+$/.test(expiration)) refuse('Expired')
  const expiresAt = Number(expiration)
  if (!Number.isSafeInteger(expiresAt)) refuse('Expired')
  if (event.created_at > now + PUBLIC_RELAY_MAX_FUTURE || expiresAt <= now ||
      expiresAt > event.created_at + PUBLIC_RELAY_MAX_LIFETIME) refuse('Expired')
  let region: string | undefined
  if (event.tags.some(entry => entry[0] === 'g')) {
    region = tag(event, 'g')
    if (!publicRelayRegionValid(region)) refuse('Destination')
  }
  // Like `g`: optional, but once present it must occur once, with two items
  // and a valid link, or the whole advert is refused.
  let privacy: string | undefined
  if (event.tags.some(entry => entry[0] === 'privacy')) {
    privacy = tag(event, 'privacy')
    if (!publicRelayPrivacyValid(privacy)) refuse('Destination')
  }
  const status = tag(event, 'status')
  const base = { publicKey: event.pubkey, createdAt: event.created_at, expiresAt, ...(region !== undefined ? { region } : {}),
    ...(privacy !== undefined ? { privacy } : {}) }
  if (status === 'open') {
    const offer = parseOffer(event.content)
    const host = validatePublicRelayOffer(offer)
    return { ...base, status: 'open', offer, host: asciiFold(host) }
  }
  if (status === 'withdrawn') {
    let empty: unknown
    try { empty = JSON.parse(event.content) } catch { return refuse('Encoding') }
    if (!empty || typeof empty !== 'object' || Array.isArray(empty) || Object.keys(empty).length !== 0) refuse('Encoding')
    return { ...base, status: 'withdrawn' }
  }
  return refuse('Destination')
}

/**
 * Hostnames a browser must not contact even though the advert verified.
 * spry-link leaves "names that resolve to private, loopback, link-local or
 * reserved addresses" to the client when it connects; a browser cannot
 * resolve DNS, so this denies the suffixes that name such places instead.
 * Applied before a relay is listed and before any login request.
 */
const CONNECT_DENIED_SUFFIXES = new Set(['arpa', 'lan', 'home', 'localdomain', 'onion', 'alt', 'example',
  'local', 'localhost', 'internal', 'invalid', 'test'])
export function publicRelayHostAllowed(host: string): boolean {
  const labels = asciiFold(host).split('.')
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9-]{1,63}$/.test(label))) return false
  return !CONNECT_DENIED_SUFFIXES.has(labels[labels.length - 1]!) && !/^[0-9]+$/.test(labels[labels.length - 1]!)
}

/** A watermark carried between visits: the newest `created_at` seen for a
 *  transport key and the id of the event that set it. */
export interface PublicRelayWatermark { key: string; createdAt: number; id: string }

interface BookEntry { createdAt: number; id: string; advert?: PublicRelayAdvert; restored: boolean }

/**
 * The replay watermark of rule 3: per transport key, the newest `created_at`
 * seen. Anything not newer is refused, so a newer withdrawal cannot be
 * undone by an older open advert. Bounded and swept. One book is shared by
 * every relay read, so a relay cannot replay what another has superseded.
 *
 * Watermarks may be restored from an earlier visit, without their adverts
 * (adverts are kept in memory only). The one event that set a restored
 * watermark may then be admitted once more, so a reload does not hide a
 * relay until its operator next republishes. It is the identical signed
 * statement (the id binds `created_at`, status and offer), so admitting it
 * again cannot roll anything back; any other event at or below the
 * watermark is still a replay.
 */
export class PublicRelayAdvertBook {
  #entries = new Map<string, BookEntry>()
  readonly capacity: number
  constructor(capacity = PUBLIC_RELAY_MAX_TRACKED, restored: readonly PublicRelayWatermark[] = []) {
    this.capacity = Math.max(0, Math.min(capacity, PUBLIC_RELAY_MAX_TRACKED))
    for (const mark of restored) {
      if (this.#entries.size >= this.capacity) break
      if (!HEX64.test(mark.key) || !HEX64.test(mark.id) || !Number.isSafeInteger(mark.createdAt) || mark.createdAt < 0) continue
      const old = this.#entries.get(mark.key)
      if (!old || mark.createdAt > old.createdAt) this.#entries.set(mark.key, { createdAt: mark.createdAt, id: mark.id, restored: true })
    }
  }
  #sweep(now: number): void {
    // Once a watermark is two hours old, every older event has expired under
    // rule 2, so forgetting it cannot admit a replay.
    for (const [key, entry] of this.#entries) if (entry.createdAt + PUBLIC_RELAY_MAX_LIFETIME <= now) this.#entries.delete(key)
  }
  /** Verify first, then advance the watermark. Throws `PublicRelayRefused`. */
  accept(event: unknown, now: number): PublicRelayAdvert {
    this.#sweep(now)
    const advert = verifyPublicRelayAdvert(event, now)
    const id = (event as { id: string }).id
    const entry = this.#entries.get(advert.publicKey)
    if (entry) {
      const repeat = entry.restored && advert.createdAt === entry.createdAt && id === entry.id
      if (advert.createdAt <= entry.createdAt && !repeat) refuse('Replay')
    } else if (this.#entries.size >= this.capacity) refuse('Overload')
    this.#entries.set(advert.publicKey, { createdAt: advert.createdAt, id, restored: false, ...(advert.status === 'open' ? { advert } : {}) })
    return advert
  }
  watermark(publicKey: string): number | undefined { return this.#entries.get(publicKey)?.createdAt }
  /** Unexpired open adverts. Ranking and the per-call limits are the client's. */
  open(now: number): PublicRelayAdvert[] {
    return [...this.#entries.values()].flatMap(entry => entry.advert && entry.advert.expiresAt > now ? [entry.advert] : [])
  }
  /** The current open advert from one transport key, if any. */
  openFrom(publicKey: string, now: number): PublicRelayAdvert | undefined {
    const advert = this.#entries.get(publicKey)?.advert
    return advert && advert.expiresAt > now ? advert : undefined
  }
  /** Watermarks to carry to the next visit, swept, newest first, bounded. */
  watermarks(now: number): PublicRelayWatermark[] {
    this.#sweep(now)
    return [...this.#entries].map(([key, entry]) => ({ key, createdAt: entry.createdAt, id: entry.id }))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, PUBLIC_RELAY_MAX_TRACKED)
  }
}

/** A login issued by the chosen operator, held in memory for one call. */
export interface PublicRelayLogin {
  /** The transport key of the advert it was requested through. */
  key: string
  host: string
  urls: string[]
  username: string
  credential: string
  expiresAt: number
}

export class PublicRelayLoginFailed extends Error {
  /** `busy` is a 429: the operator's limiter, worth retrying before the deadline. */
  constructor(readonly busy = false) {
    super(busy ? 'The public call relay is busy.' : 'The public call relay did not issue a login.')
    this.name = 'PublicRelayLoginFailed'
  }
}

export interface PublicRelayLoginOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Seconds. */
  now?: () => number
  timeoutMs?: number
}

const USERNAME = /^(\d+):pub-[0-9a-f]{24}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Ask a verified advert's operator for a public login. Separate from the
 * room's credential mint on purpose: a `POST` whose JSON body forces a CORS
 * preflight, no cookies, no referrer, no cache and no redirect, 4 seconds
 * and 4 KiB at most, and every returned URL must be one the signed advert
 * named. Throws `PublicRelayLoginFailed`; never echoes what the operator said.
 */
export async function fetchPublicRelayLogin(advert: PublicRelayAdvert, options: PublicRelayLoginOptions = {}): Promise<PublicRelayLogin> {
  const offer = advert.offer
  if (advert.status !== 'open' || !offer || !advert.host || !publicRelayHostAllowed(advert.host)) throw new PublicRelayLoginFailed()
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new PublicRelayLoginFailed()) }, options.timeoutMs ?? PUBLIC_RELAY_LOGIN_TIMEOUT_MS)
  })
  const attempt = (async (): Promise<PublicRelayLogin> => {
    let res: Response
    try {
      res = await send(offer.credentials, {
        method: 'POST', body: '{"v":1}', headers: { 'Content-Type': 'application/json' },
        mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: controller.signal,
      })
    } catch { throw new PublicRelayLoginFailed() }
    if (res.status === 429) throw new PublicRelayLoginFailed(true)
    if (controller.signal.aborted || res.status !== 200 || res.redirected || res.type === 'opaqueredirect' ||
        !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '') || !res.body) throw new PublicRelayLoginFailed()
    const declared = res.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PUBLIC_RELAY_LOGIN_LIMIT)) throw new PublicRelayLoginFailed()
    reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > PUBLIC_RELAY_LOGIN_LIMIT) throw new PublicRelayLoginFailed()
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw new PublicRelayLoginFailed() }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicRelayLoginFailed()
    const { urls, username, credential, expiresAt } = value as Record<string, unknown>
    const at = now()
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= at ||
        expiresAt > at + PUBLIC_RELAY_LOGIN_SECONDS + PUBLIC_RELAY_LOGIN_SLACK_SECONDS) throw new PublicRelayLoginFailed()
    const name = typeof username === 'string' ? USERNAME.exec(username) : null
    if (!name || name[1] !== String(expiresAt)) throw new PublicRelayLoginFailed()
    if (typeof credential !== 'string' || credential.length === 0 || credential.length > 64 || !BASE64.test(credential)) throw new PublicRelayLoginFailed()
    if (!Array.isArray(urls)) throw new PublicRelayLoginFailed()
    // A URL the signed advert did not name is dropped, never contacted.
    const narrowed = [...new Set(urls.filter((url): url is string => typeof url === 'string' && offer.urls.includes(url)))]
    if (narrowed.length === 0) throw new PublicRelayLoginFailed()
    return { key: advert.publicKey, host: advert.host!, urls: narrowed, username: username as string, credential, expiresAt }
  })()
  try { return await Promise.race([attempt, bound]) } catch (error) {
    throw error instanceof PublicRelayLoginFailed ? error : new PublicRelayLoginFailed()
  } finally {
    clearTimeout(timer)
    controller.abort()
    attempt.catch(() => {})
    void reader?.cancel().catch(() => {})
  }
}
