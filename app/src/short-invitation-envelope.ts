import { base64urlnopad } from '@scure/base'
import { parseRoomLink } from '../../src/link.js'

export const SHORT_INVITATION_ORIGIN = 'https://z1p.app'
export const MAX_SHORT_INVITATION_BYTES = 32 * 1024
export const MAX_SHORT_INVITATION_LIFETIME = 7 * 24 * 60 * 60

export interface ShortInvitationEnvelope {
  v: 1
  expires: number
  nonce: string
  ciphertext: string
}

const utf8 = new TextEncoder()
const decodeUtf8 = new TextDecoder('utf-8', { fatal: true })
const reject = (): never => { throw new Error('Invalid short invitation') }
const seconds = () => Math.floor(Date.now() / 1000)

function bytes(value: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > MAX_SHORT_INVITATION_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) return reject()
  let decoded: Uint8Array
  try { decoded = base64urlnopad.decode(value) } catch { return reject() }
  if (length !== undefined && decoded.length !== length || base64urlnopad.encode(decoded) !== value) return reject()
  return new Uint8Array(decoded)
}

function lifetime(expires: unknown, now: number): asserts expires is number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expires) || typeof expires !== 'number'
    || expires <= now || expires - now > MAX_SHORT_INVITATION_LIFETIME) reject()
}

function exactObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject()
}

function json(text: string): unknown {
  if (text.length > MAX_SHORT_INVITATION_BYTES || utf8.encode(text).length > MAX_SHORT_INVITATION_BYTES) return reject()
  try { return JSON.parse(text) } catch { return reject() }
}

function invitation(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_SHORT_INVITATION_BYTES) return reject()
  let target: URL
  try { target = new URL(value) } catch { return reject() }
  if (target.href !== value || target.origin !== 'https://kithmoot.app' || target.pathname !== '/j/'
    || target.search || target.username || target.password || !target.hash) return reject()
  // Use the existing admission parser; no replacement circle format or redirect.
  try { if (!parseRoomLink(value).invitation) return reject() } catch { return reject() }
  return value
}

function aad(id: string, expires: number): Uint8Array<ArrayBuffer> {
  return utf8.encode(`kithmoot-short-invite/v1:${id}:${expires}`)
}

/** Parse without fetching, requesting admission or revealing any room contents. */
export function parseShortInvitationUrl(value: string): { id: string; key: Uint8Array<ArrayBuffer> } {
  if (value.length !== 84) return reject()
  let url: URL
  try { url = new URL(value) } catch { return reject() }
  if (url.href !== value || url.origin !== SHORT_INVITATION_ORIGIN || url.search || url.username || url.password
    || !/^\/k\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) return reject()
  const id = url.pathname.slice(3)
  bytes(id, 16)
  return { id, key: bytes(url.hash.slice(1), 32) }
}

/** Seal an exact invitation for an already allocated random resolver ID. No HTTP. */
export async function sealShortInvitation(id: string, fullInvitation: string, expires: number, now = seconds()): Promise<{ url: string; envelope: ShortInvitationEnvelope }> {
  bytes(id, 16)
  lifetime(expires, now)
  const plaintext = utf8.encode(JSON.stringify({ v: 1, url: invitation(fullInvitation) }))
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(id, expires), tagLength: 128 }, key, plaintext)
    const envelope: ShortInvitationEnvelope = { v: 1, expires, nonce: base64urlnopad.encode(nonce), ciphertext: base64urlnopad.encode(new Uint8Array(ciphertext)) }
    json(JSON.stringify(envelope))
    return { url: `${SHORT_INVITATION_ORIGIN}/k/${id}#${base64urlnopad.encode(keyBytes)}`, envelope }
  } finally { keyBytes.fill(0); plaintext.fill(0) }
}

/** Authenticate a bounded resolver response, returning an invitation for ordinary review. */
export async function openShortInvitation(shortUrl: string, response: string, now = seconds()): Promise<string> {
  const { id, key: keyBytes } = parseShortInvitationUrl(shortUrl)
  let plaintext: Uint8Array | undefined
  try {
    const envelope = json(response)
    exactObject(envelope, ['v', 'expires', 'nonce', 'ciphertext'])
    if (envelope.v !== 1) return reject()
    lifetime(envelope.expires, now)
    const nonce = bytes(envelope.nonce, 12)
    const ciphertext = bytes(envelope.ciphertext)
    if (ciphertext.length < 17) return reject()
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(id, envelope.expires), tagLength: 128 }, key, ciphertext))
    } catch { return reject() }
    const payload = json(decodeUtf8.decode(plaintext))
    exactObject(payload, ['v', 'url'])
    if (payload.v !== 1) return reject()
    return invitation(payload.url)
  } finally { keyBytes.fill(0); plaintext?.fill(0) }
}
