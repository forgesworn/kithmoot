import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'
import { normaliseHex } from './hex.js'
import type { AccessTier, RoomPolicy } from './types.js'

const ROOM_ID_INFO = 'kithmoot/v1/room-id'
const ROOM_KEY_INFO = 'kithmoot/v1/room-key'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/** Generate a fresh 32-byte room traffic secret.
 *
 * Legacy v1 links carry this directly. New app links exchange it through
 * `invitation.ts` and never expose it in the URL. */
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
  /** The room's access policy. */
  a?: RoomPolicy
}

const TIERS: AccessTier[] = ['open', 'ken', 'kith', 'kin']

/**
 * Parse an access policy out of a URL fragment, which is untrusted input.
 *
 * A policy that does not parse is refused rather than silently dropped: a
 * dropped policy is an open room, and failing open is exactly the mistake
 * carrying the policy in the capability is meant to prevent.
 */
export function parseRoomPolicy(raw: unknown): RoomPolicy | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new Error('join URL carries a malformed access policy')
  const policy = raw as RoomPolicy
  if (!TIERS.includes(policy.tier)) throw new Error('join URL carries an access policy at an unknown tier')
  if (policy.admitted !== undefined) {
    if (!Array.isArray(policy.admitted) || !policy.admitted.every((a) => typeof a === 'string')) {
      throw new Error('join URL carries a malformed access policy')
    }
  }
  // The allow-list is exactly the case this rule was written for: entries a
  // person typed or pasted into a link. Canonicalise here, at the point they
  // enter the system off the URL, rather than relying on every reader to
  // compare them case-insensitively.
  return policy.admitted
    ? { tier: policy.tier, admitted: policy.admitted.map(normaliseHex) }
    : { tier: policy.tier }
}

/**
 * Build a legacy v1 join URL. The secret and relay hints live in the fragment, which
 * browsers never transmit to the server - the host of kithmoot.com learns
 * nothing about which room you are joining.
 *
 * Encoding uses @scure/base and TextEncoder/TextDecoder rather than a
 * Node-only global: this library ships to a browser PWA as well as to Node,
 * and Node-only globals do not exist there.
 *
 * The access policy rides here too. It is deliberately NOT a room descriptor
 * event on a relay: the URL is the capability, so everyone who joins holds
 * the same policy bytes and agreement is structural, with nothing to fetch
 * before a member can check another member's tier and no durable artefact of
 * the room on any relay. The cost is that the policy cannot change mid-room -
 * a new rule is a new link. See `docs/decisions.md`.
 */
export function encodeJoinUrl(
  base: string,
  secret: Uint8Array,
  relays: string[],
  policy?: RoomPolicy,
): string {
  if (secret.length !== 32) throw new Error('room secret must be 32 bytes')
  const payload: JoinPayload = { s: base64urlnopad.encode(secret), r: relays }
  if (policy) payload.a = policy
  const encoded = base64urlnopad.encode(utf8Encoder.encode(JSON.stringify(payload)))
  return `${base}#${encoded}`
}

/** Decode a legacy v1 room-secret link. Version 2 invitation links are
 * resolved by `invitation.ts` plus the app's URL envelope. */
export function decodeJoinUrl(url: string): {
  secret: Uint8Array
  relays: string[]
  policy?: RoomPolicy
} {
  const hash = new URL(url).hash.slice(1)
  if (!hash) throw new Error('join URL has no fragment')
  let payload: JoinPayload
  try {
    payload = JSON.parse(utf8Decoder.decode(base64urlnopad.decode(hash))) as JoinPayload
  } catch {
    throw new Error('join URL fragment is not valid')
  }

  let secret: Uint8Array
  try {
    secret = base64urlnopad.decode(payload.s)
  } catch {
    throw new Error('join URL carries a malformed secret')
  }
  if (secret.length !== 32) throw new Error('join URL carries a malformed secret')

  const policy = parseRoomPolicy(payload.a)
  return policy ? { secret, relays: payload.r ?? [], policy } : { secret, relays: payload.r ?? [] }
}
