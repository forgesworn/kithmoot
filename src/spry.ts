import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { parseSpryControl, spryControlRequest, spryNodeCard } from './spry-link.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { hmac } from '@noble/hashes/hmac'

/** A room-scoped access capability, carried only inside the encrypted descriptor. */
export interface SpryOffer { v: 1; endpoint: string; token: string; expiresAt: number; node?: Event }
export interface SpryPairing { v: 1; endpoint: string; id: string; secretKey: string }
export interface SpryCredential { urls: string[]; username: string; credential: string; expiresAt: number; accessExpiresAt: number; node?: Event }
export const SPRY_GRANT_SECONDS = 30 * 24 * 60 * 60
const token = /^[A-Za-z0-9_-]{43}$/
const encoder = new TextEncoder()
export const spryHash = (value: string): string => bytesToHex(sha256(encoder.encode(value)))
export const newSpryKey = (): string => bytesToHex(generateSecretKey())
export const spryDeviceKey = (key: Uint8Array): string => bytesToHex(hmac(sha256, key, encoder.encode('spry-device-v1')))

export function spryEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid Spry address.')
  if (value.startsWith('spry:')) { parseSpryControl(value); return value }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.hash || url.search ||
    !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname) ||
    /^\[|^[0-9.]+$/.test(url.hostname)) throw new Error('Spry needs a public HTTPS address.')
  return url.origin
}

export function parseSpryOffer(value: unknown): SpryOffer | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Partial<SpryOffer>
    if (raw.v !== 1 || typeof raw.token !== 'string' || !token.test(raw.token) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt! < 0) return undefined
    return { v: 1, endpoint: spryEndpoint(raw.endpoint), token: raw.token, expiresAt: raw.expiresAt!, ...(spryNodeCard(raw.node) ? { node: spryNodeCard(raw.node) } : {}) }
  } catch { return undefined }
}

export function parseSpryPairingLink(hash: string, now = Math.floor(Date.now() / 1000)): { endpoint: string; code: string; expiresAt: number } {
  if (!hash.startsWith('#spry=') || hash.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(hash.slice(6))) throw new Error('This Spry pairing link could not be read.')
  const raw = JSON.parse(atob(hash.slice(6).replaceAll('-', '+').replaceAll('_', '/')))
  if (raw.v !== 1 || !token.test(raw.code) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now || raw.expiresAt > now + 360) {
    throw new Error('This Spry pairing link has expired. Open Spry and pair again.')
  }
  return { endpoint: spryEndpoint(raw.endpoint), code: raw.code, expiresAt: raw.expiresAt }
}

/** Signed, body-bound requests: no cookies, referrer, room key or redirect. */
export async function spryRequest(endpoint: string, path: string, data: object, secretKey: string,
  fetcher: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const origin = spryEndpoint(endpoint)
  if (!['/v1/pairings/claim', '/v1/pairings/remove-self', '/v1/grants', '/v1/credentials', '/v1/peers'].includes(path) || !/^[a-f0-9]{64}$/.test(secretKey)) throw new Error('Invalid Spry request.')
  if (origin.startsWith('spry:')) return spryControlRequest(origin, path, data, secretKey, now)
  const body = JSON.stringify(data), url = origin + path
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const event = finalizeEvent({ kind: 27235, created_at: now, content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', spryHash(body)], ['nonce', nonce]] },
  Uint8Array.from(secretKey.match(/../g)!.map(value => parseInt(value, 16))))
  try {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${btoa(JSON.stringify(event))}` },
      body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(6000) })
    if (!response.ok) throw new Error('Spry access is unavailable. Check the pairing in Connections.')
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
  } catch { throw new Error('Spry could not connect. Check the pairing in Connections and try again.') }
}

export async function claimSpryPairing(link: ReturnType<typeof parseSpryPairingLink>, fetcher: typeof fetch = fetch): Promise<SpryPairing> {
  const secretKey = newSpryKey()
  const result = await spryRequest(link.endpoint, '/v1/pairings/claim', { code: link.code }, secretKey, fetcher)
  if (result.version !== 1 || !token.test(String(result.id)) || result.endpoint !== link.endpoint) throw new Error('Invalid Spry pairing answer.')
  return { v: 1, endpoint: link.endpoint, id: result.id as string, secretKey }
}

export async function spryGrant(pair: SpryPairing, scope: string, fetcher: typeof fetch = fetch): Promise<SpryOffer> {
  const key = Uint8Array.from(pair.secretKey.match(/../g)!.map(value => parseInt(value, 16)))
  const opaqueScope = bytesToHex(hmac(sha256, key, encoder.encode(`spry-scope-v1:${scope}`)))
  const value = await spryRequest(pair.endpoint, '/v1/grants', { pairing: pair.id, scope: opaqueScope }, pair.secretKey, fetcher)
  const offer = parseSpryOffer(value)
  if (!offer || offer.endpoint !== pair.endpoint || offer.expiresAt <= Date.now() / 1000 || offer.expiresAt > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new Error('Invalid Spry call access.')
  return offer
}

export async function spryCredentials(offer: SpryOffer, secretKey: string, fetcher: typeof fetch = fetch, own?: SpryPairing): Promise<SpryCredential> {
  const privateNode = offer.endpoint.startsWith('spry:')
  if (privateNode && own?.endpoint !== offer.endpoint) throw new Error('Pair your own Spry node to use private call access.')
  if (offer.expiresAt <= Date.now() / 1000 || offer.expiresAt > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new Error('Spry call access has expired.')
  const value = await spryRequest(offer.endpoint, '/v1/credentials', { grant: offer.token }, secretKey, fetcher)
  const host = new URL(offer.endpoint).hostname
  const allowed = new Set([`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`])
  if (!Array.isArray(value.urls) || !value.urls.length || value.urls.length > 3 || !value.urls.every(url => typeof url === 'string' && (privateNode ? /^turns?:[A-Za-z0-9.-]{1,253}:[0-9]{2,5}\?transport=(udp|tcp)$/.test(url) && !/[\s@/]/.test(url) : allowed.has(url))) ||
    typeof value.username !== 'string' || !/^[0-9]{1,12}:[a-f0-9]{24}$/.test(value.username) ||
    typeof value.credential !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value.credential) ||
    !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now() / 1000 || Number(value.expiresAt) > Date.now() / 1000 + 360 ||
    Number(value.username.split(':')[0]) !== value.expiresAt || !Number.isSafeInteger(value.accessExpiresAt) ||
    Number(value.accessExpiresAt) < Number(value.expiresAt) || Number(value.accessExpiresAt) > Date.now() / 1000 + SPRY_GRANT_SECONDS + 60) throw new Error('Invalid Spry relay answer.')
  const node = spryNodeCard(value.node)
  if (privateNode && (!node || node.pubkey !== parseSpryControl(offer.endpoint).publicKey)) throw new Error('Invalid Spry node answer.')
  return { ...(node ? { node } : {}), urls: value.urls as string[], username: value.username, credential: value.credential, expiresAt: value.expiresAt as number, accessExpiresAt: value.accessExpiresAt as number }
}

/** Tell only the paired node which signed room peers may receive packets. */
export async function spryPeers(pair: SpryPairing, room: string, device: string, peers: Event[], fetcher: typeof fetch = fetch, revision = Date.now()): Promise<void> {
  if (!pair.endpoint.startsWith('spry:')) return
  const key = Uint8Array.from(pair.secretKey.match(/../g)!.map(value => parseInt(value, 16)))
  const scope = bytesToHex(hmac(sha256, key, encoder.encode(`spry-scope-v1:${room}`)))
  await spryRequest(pair.endpoint, '/v1/peers', { pairing: pair.id, scope, device: spryHash(device), revision, peers }, pair.secretKey, fetcher)
}
