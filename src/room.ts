import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'

const ROOM_ID_INFO = 'kithmoot/v1/room-id'
const ROOM_KEY_INFO = 'kithmoot/v1/room-key'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

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
 *
 * Encoding uses @scure/base and TextEncoder/TextDecoder rather than a
 * Node-only global: this library ships to a browser PWA as well as to Node,
 * and Node-only globals do not exist there.
 */
export function encodeJoinUrl(base: string, secret: Uint8Array, relays: string[]): string {
  if (secret.length !== 32) throw new Error('room secret must be 32 bytes')
  const payload: JoinPayload = { s: base64urlnopad.encode(secret), r: relays }
  const encoded = base64urlnopad.encode(utf8Encoder.encode(JSON.stringify(payload)))
  return `${base}#${encoded}`
}

export function decodeJoinUrl(url: string): { secret: Uint8Array; relays: string[] } {
  const hash = new URL(url).hash.slice(1)
  if (!hash) throw new Error('join URL has no fragment')
  let secret: Uint8Array
  let relays: string[]
  try {
    const payload = JSON.parse(utf8Decoder.decode(base64urlnopad.decode(hash))) as JoinPayload
    secret = base64urlnopad.decode(payload.s)
    relays = payload.r ?? []
  } catch {
    throw new Error('join URL fragment is not valid')
  }
  if (secret.length !== 32) throw new Error('join URL carries a malformed secret')
  return { secret, relays }
}
