import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { parseSpryControl, spryControlRequest, spryNodeCard, spryStandardCard, SpryRequestError } from './spry-link.js'
export { SpryRequestError } from './spry-link.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { hmac } from '@noble/hashes/hmac'

/**
 * A room-scoped access capability, carried only inside the encrypted descriptor.
 * `relayed: true` marks a copy: a member republishing the offer of a relay it
 * does not run, so the room keeps it while the host is away. Absent means the
 * publisher says it runs the relay itself. A copy is an unverifiable claim
 * about who runs the relay, so a client asking "whose relay?" ignores it.
 */
export interface SpryOffer { v: 1; endpoint: string; token: string; expiresAt: number; node?: Event; relayed?: true }
export interface SpryPairing { v: 1; endpoint: string; id: string; secretKey: string }
export interface SpryCredential { urls: string[]; username: string; credential: string; expiresAt: number; accessExpiresAt: number; node?: Event }
export const SPRY_GRANT_SECONDS = 30 * 24 * 60 * 60
const token = /^[A-Za-z0-9_-]{43}$/
const encoder = new TextEncoder()
export const spryHash = (value: string): string => bytesToHex(sha256(encoder.encode(value)))
export const newSpryKey = (): string => bytesToHex(generateSecretKey())
export { spryDeviceKey } from './spry-key.js'

export function spryEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid Spry address.')
  if (value.startsWith('spry:')) { parseSpryControl(value); return value }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.hash || url.search ||
    !url.hostname.includes('.') || url.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname) ||
    /^\[|^[0-9.]+$/.test(url.hostname)) throw new Error('Spry needs a public HTTPS address.')
  return url.origin
}

export function parseSpryOffer(value: unknown): SpryOffer | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Partial<SpryOffer>
    if (raw.v !== 1 || typeof raw.token !== 'string' || !token.test(raw.token) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt! < 0) return undefined
    const node = spryNodeCard(raw.node) ?? spryStandardCard(raw.node)
    return { v: 1, endpoint: spryEndpoint(raw.endpoint), token: raw.token, expiresAt: raw.expiresAt!, ...(node ? { node } : {}),
      // Exactly `true` marks a copy; any other value reads as unmarked.
      ...(raw.relayed === true ? { relayed: true as const } : {}) }
  } catch { return undefined }
}

/**
 * Whether an offer is a standard-profile node reached over `spry:` control,
 * such as a member's built-in relay: its card is a `spry-standard-v1` card
 * signed by the endpoint's own key. The card's ten-minute expiry was checked
 * when the offer was read; here it is checked as of the card's own signing
 * time, so a guest that read a fresh offer keeps using it. Only such an offer
 * from another member is ever redeemed: a private-node (`spry-peer-v1`) offer
 * belongs to its own pairing alone.
 */
export function isSpryStandardOffer(offer: Pick<SpryOffer, 'endpoint' | 'node'>): boolean {
  try {
    const node = offer.node
    return offer.endpoint.startsWith('spry:') && !!node && !!spryStandardCard(node, node.created_at) &&
      node.pubkey === parseSpryControl(offer.endpoint).publicKey
  } catch { return false }
}

/** Public unicast IPv4, as Spry's `public_v4` decides it: not private,
 *  loopback, link-local, broadcast, documentation, `0/8`, multicast or
 *  reserved (`224/3`), carrier-grade NAT, benchmarking or `192.0.0/24`. */
export function isPublicIpv4(text: string): boolean {
  const match = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/.exec(text)
  if (!match) return false
  const [a, b, c] = match.slice(1, 4).map(Number) as [number, number, number]
  return !(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 127 || a === 169 && b === 254 ||
    text === '255.255.255.255' || a === 192 && b === 0 && c === 2 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 ||
    a === 0 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a === 192 && b === 0 && c === 0)
}

const STANDARD_URL = /^turn:([0-9.]{7,15}):([1-9][0-9]{3,4})\?transport=(udp|tcp)$/
/**
 * The TURN URLs a standard-profile node may hand a guest (built-in relay
 * design, section 3.3): one or two `turn:` URLs on one public IPv4 literal,
 * ports 1024 to 65535, UDP or TCP, no repeats. No `turns:`, names, IPv6 or
 * private addresses, so another member's offer cannot point a guest's TURN
 * client into its own network. `loopback` admits 127.0.0.1 and exists only
 * for the local acceptance build (`VITE_E2E_SPRY_LOOPBACK_TURN`).
 */
export function isSpryStandardTurnUrls(urls: unknown, loopback = false): urls is string[] {
  if (!Array.isArray(urls) || !urls.length || urls.length > 2 || new Set(urls).size !== urls.length) return false
  const hosts = new Set<string>()
  for (const url of urls) {
    const match = typeof url === 'string' ? STANDARD_URL.exec(url) : null
    if (!match || Number(match[2]) < 1024 || Number(match[2]) > 65535 || !(isPublicIpv4(match[1]!) || loopback && match[1] === '127.0.0.1')) return false
    hosts.add(match[1]!)
  }
  return hosts.size === 1
}

export function parseSpryPairingLink(hash: string, now = Math.floor(Date.now() / 1000)): { endpoint: string; code: string; expiresAt: number } {
  if (!hash.startsWith('#spry=') || hash.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(hash.slice(6))) throw new Error('This Spry pairing link could not be read.')
  const raw = JSON.parse(atob(hash.slice(6).replaceAll('-', '+').replaceAll('_', '/')))
  if (raw.v !== 1 || !token.test(raw.code) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now || raw.expiresAt > now + 360) {
    throw new Error('This Spry pairing link has expired. Open Spry and pair again.')
  }
  return { endpoint: spryEndpoint(raw.endpoint), code: raw.code, expiresAt: raw.expiresAt }
}

/** Every path a client may ask a Spry node for. */
const SPRY_PATHS = ['/v1/pairings/claim', '/v1/pairings/remove-self', '/v1/grants', '/v1/grants/remove', '/v1/grants/devices', '/v1/grants/vouch', '/v1/credentials', '/v1/peers']

/** Signed, body-bound requests: no cookies, referrer, room key or redirect.
 *  Throws `SpryRequestError`, carrying the node's status when it answered. */
export async function spryRequest(endpoint: string, path: string, data: object, secretKey: string,
  fetcher: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const origin = spryEndpoint(endpoint)
  if (!SPRY_PATHS.includes(path) || !/^[a-f0-9]{64}$/.test(secretKey)) throw new Error('Invalid Spry request.')
  if (origin.startsWith('spry:')) return spryControlRequest(origin, path, data, secretKey, now)
  const body = JSON.stringify(data), url = origin + path
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const event = finalizeEvent({ kind: 27235, created_at: now, content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', spryHash(body)], ['nonce', nonce]] },
  Uint8Array.from(secretKey.match(/../g)!.map(value => parseInt(value, 16))))
  let status = 0
  try {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${btoa(JSON.stringify(event))}` },
      body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(6000) })
    if (!response.ok) { status = response.status; throw new Error('refused') }
    // Read incrementally: an untrusted operator cannot make a client buffer an unbounded response.
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Spry did not answer.')
    const chunks: Uint8Array[] = []; let length = 0
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length
        if (length > 8192) throw new Error('Invalid Spry answer.'); chunks.push(value) }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Spry answer.')
    return result as Record<string, unknown>
  } catch { throw new SpryRequestError(status >= 400 && status <= 599 ? status : 0) }
}

export async function claimSpryPairing(link: ReturnType<typeof parseSpryPairingLink>, fetcher: typeof fetch = fetch): Promise<SpryPairing> {
  const secretKey = newSpryKey()
  const result = await spryRequest(link.endpoint, '/v1/pairings/claim', { code: link.code }, secretKey, fetcher)
  if (result.version !== 1 || !token.test(String(result.id)) || result.endpoint !== link.endpoint) throw new Error('Invalid Spry pairing answer.')
  return { v: 1, endpoint: link.endpoint, id: result.id as string, secretKey }
}

const opaqueScope = (pair: SpryPairing, scope: string): string =>
  bytesToHex(hmac(sha256, Uint8Array.from(pair.secretKey.match(/../g)!.map(value => parseInt(value, 16))), encoder.encode(`spry-scope-v1:${scope}`)))

export async function spryGrant(pair: SpryPairing, scope: string, fetcher: typeof fetch = fetch): Promise<SpryOffer> {
  const value = await spryRequest(pair.endpoint, '/v1/grants', { pairing: pair.id, scope: opaqueScope(pair, scope) }, pair.secretKey, fetcher)
  const offer = parseSpryOffer(value)
  if (!offer || offer.endpoint !== pair.endpoint || offer.expiresAt <= Date.now() / 1000 || offer.expiresAt > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new Error('Invalid Spry call access.')
  return offer
}

/** What a guest sees when the relay another member shared in the room fails:
 *  it has no pairing to check, so no pairing hint. */
export const SHARED_RELAY_UNAVAILABLE = 'The call relay shared in this room is not available right now.'

export interface SpryCredentialOptions {
  /** Local acceptance builds only: see `isSpryStandardTurnUrls`. */
  loopbackTurn?: boolean
}

export async function spryCredentials(offer: SpryOffer, secretKey: string, fetcher: typeof fetch = fetch, own?: SpryPairing,
  options: SpryCredentialOptions = {}): Promise<SpryCredential> {
  const control = offer.endpoint.startsWith('spry:')
  // Another member's relay: refusals and failures say so, without pointing
  // at a pairing this device does not have.
  const shared = own?.endpoint !== offer.endpoint
  // Another member's `spry:` offer is redeemed only from a standard node
  // that says so; a private mesh node serves its own pairing alone.
  if (control && shared && !isSpryStandardOffer(offer)) throw new Error('Pair your own Spry node to use private call access.')
  if (offer.expiresAt <= Date.now() / 1000 || offer.expiresAt > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new SpryRequestError(403, shared ? SHARED_RELAY_UNAVAILABLE : 'Spry call access has expired.')
  let value: Record<string, unknown>
  try { value = await spryRequest(offer.endpoint, '/v1/credentials', { grant: offer.token }, secretKey, fetcher) }
  catch (error) {
    if (shared && error instanceof SpryRequestError) throw new SpryRequestError(error.status, SHARED_RELAY_UNAVAILABLE)
    throw error
  }
  // A `spry:` answer carries the node's card, signed by the endpoint's key:
  // a standard card from a standard node (its URL rule below), or a peer
  // card from this device's own private node.
  const peer = spryNodeCard(value.node), standard = control && !peer ? spryStandardCard(value.node) : undefined
  const node = peer ?? standard
  if (control && (!node || node.pubkey !== parseSpryControl(offer.endpoint).publicKey || shared && !standard)) throw new Error('Invalid Spry node answer.')
  const host = new URL(offer.endpoint).hostname
  const allowed = new Set([`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`])
  if (!Array.isArray(value.urls) || !value.urls.length || value.urls.length > 3 ||
    (control && standard ? !isSpryStandardTurnUrls(value.urls, options.loopbackTurn === true) :
      !value.urls.every(url => typeof url === 'string' && (control ? /^turns?:[A-Za-z0-9.-]{1,253}:[0-9]{2,5}\?transport=(udp|tcp)$/.test(url) && !/[\s@/]/.test(url) : allowed.has(url)))) ||
    typeof value.username !== 'string' || !/^[0-9]{1,12}:[a-f0-9]{24}$/.test(value.username) ||
    typeof value.credential !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value.credential) ||
    !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now() / 1000 || Number(value.expiresAt) > Date.now() / 1000 + 360 ||
    Number(value.username.split(':')[0]) !== value.expiresAt || !Number.isSafeInteger(value.accessExpiresAt) ||
    Number(value.accessExpiresAt) < Number(value.expiresAt) || Number(value.accessExpiresAt) > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new Error('Invalid Spry relay answer.')
  return { ...(node ? { node } : {}), urls: value.urls as string[], username: value.username, credential: value.credential, expiresAt: value.expiresAt as number, accessExpiresAt: value.accessExpiresAt as number }
}

const KEY = /^[0-9a-f]{64}$/
const keyList = (keys: readonly string[], most: number): string[] => {
  const out = [...new Set(keys)]
  if (out.length > most || out.some(key => !KEY.test(key))) throw new Error('Invalid Spry request.')
  return out
}

/** The node's answer to a registration: whether the grant is sealed, whether
 *  the node enforces that, and how many keys it now holds. */
export interface SpryDevicesAnswer { sealed: boolean; enforced: boolean; devices: number }

/**
 * Register or drop room devices' Spry keys on this pairing's grant
 * (`/v1/grants/devices`, spry-turn docs/api.md "Room-grant paths"). At most
 * 32 keys each way, never one in both; `seal: true` seals the grant for good.
 * The node applies a request all or nothing, so callers send removals and a
 * seal on their own, apart from adds. `revision` must grow per grant.
 */
export async function spryRegisterDevices(pair: SpryPairing, offer: SpryOffer, change: { add?: readonly string[]; remove?: readonly string[]; seal?: boolean },
  revision: number, fetcher: typeof fetch = fetch): Promise<SpryDevicesAnswer> {
  const add = keyList(change.add ?? [], 32), remove = keyList(change.remove ?? [], 32)
  if (add.some(key => remove.includes(key)) || !Number.isSafeInteger(revision) || revision < 0 || offer.endpoint !== pair.endpoint) throw new Error('Invalid Spry request.')
  const value = await spryRequest(pair.endpoint, '/v1/grants/devices', { v: 1, pairing: pair.id, grant: offer.token, add, remove,
    ...(change.seal ? { seal: true } : {}), revision }, pair.secretKey, fetcher)
  if (value.v !== 1 || typeof value.sealed !== 'boolean' || typeof value.enforced !== 'boolean' || !Number.isSafeInteger(value.devices) || Number(value.devices) < 0) throw new SpryRequestError(0, 'Invalid Spry answer.')
  return { sealed: value.sealed, enforced: value.enforced, devices: value.devices as number }
}

/** Vouch, as a device the grant's owner registered, for up to four keys of
 *  devices that joined the call (`/v1/grants/vouch`). Returns `added`. */
export async function spryVouch(offer: SpryOffer, secretKey: string, add: readonly string[], fetcher: typeof fetch = fetch): Promise<number> {
  const keys = keyList(add, 4)
  if (!keys.length) throw new Error('Invalid Spry request.')
  const value = await spryRequest(offer.endpoint, '/v1/grants/vouch', { v: 1, grant: offer.token, add: keys }, secretKey, fetcher)
  if (value.v !== 1 || !Number.isSafeInteger(value.added) || Number(value.added) < 0) throw new SpryRequestError(0, 'Invalid Spry answer.')
  return value.added as number
}

/** Drop this pairing's grant and every key registered on it, so a token
 *  already shared stops working within five minutes. */
export async function spryRemoveGrant(pair: SpryPairing, offer: SpryOffer, fetcher: typeof fetch = fetch): Promise<void> {
  if (offer.endpoint !== pair.endpoint) throw new Error('Invalid Spry request.')
  const value = await spryRequest(pair.endpoint, '/v1/grants/remove', { pairing: pair.id, grant: offer.token }, pair.secretKey, fetcher)
  if (value.removed !== true) throw new SpryRequestError(0, 'Invalid Spry answer.')
}

/** Tell only the paired node which signed room peers may receive packets. */
export async function spryPeers(pair: SpryPairing, room: string, device: string, peers: Event[], fetcher: typeof fetch = fetch, revision = Date.now()): Promise<void> {
  if (!pair.endpoint.startsWith('spry:')) return
  await spryRequest(pair.endpoint, '/v1/peers', { pairing: pair.id, scope: opaqueScope(pair, room), device: spryHash(device), revision, peers }, pair.secretKey, fetcher)
}
