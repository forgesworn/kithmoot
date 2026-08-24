import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { randomBytes } from '@noble/hashes/utils'

const ROOM_ID_INFO = 'kithmoot/v1/room-id'
const ROOM_KEY_INFO = 'kithmoot/v1/room-key'

/** Generate a fresh 32-byte room secret. This is the capability that grants entry. */
export function generateRoomSecret(): Uint8Array {
  return randomBytes(32)
}

/**
 * Derive the public room identifier and the symmetric room key from the secret.
 *
 * The two are derived with separate HKDF info strings so that publishing the
 * room id (which relays necessarily see) reveals nothing about the room key.
 */
export function deriveRoom(secret: Uint8Array): { roomId: string; roomKey: Uint8Array } {
  if (secret.length !== 32) throw new Error('room secret must be 32 bytes')
  const idBytes = hkdf(sha256, secret, undefined, ROOM_ID_INFO, 32)
  const roomKey = hkdf(sha256, secret, undefined, ROOM_KEY_INFO, 32)
  const roomId = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return { roomId, roomKey }
}

interface JoinPayload {
  s: string
  r: string[]
}

/**
 * Build a join URL. The secret and relay hints live in the fragment, which
 * browsers never transmit to the server - the host of kithmoot.com learns
 * nothing about which room you are joining.
 */
export function encodeJoinUrl(base: string, secret: Uint8Array, relays: string[]): string {
  if (secret.length !== 32) throw new Error('room secret must be 32 bytes')
  const payload: JoinPayload = { s: Buffer.from(secret).toString('base64url'), r: relays }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${base}#${encoded}`
}

export function decodeJoinUrl(url: string): { secret: Uint8Array; relays: string[] } {
  const hash = new URL(url).hash.slice(1)
  if (!hash) throw new Error('join URL has no fragment')
  let payload: JoinPayload
  try {
    payload = JSON.parse(Buffer.from(hash, 'base64url').toString('utf8')) as JoinPayload
  } catch {
    throw new Error('join URL fragment is not valid')
  }
  const secret = new Uint8Array(Buffer.from(payload.s, 'base64url'))
  if (secret.length !== 32) throw new Error('join URL carries a malformed secret')
  return { secret, relays: payload.r ?? [] }
}
