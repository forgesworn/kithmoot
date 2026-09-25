import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { KINDS } from './kinds.js'
import { verifyEventUncached } from './verify.js'
import { sanitiseCallMembership } from './roster.js'
import type { CallMembership } from './types.js'

/**
 * The call bell: one event when a call starts and one when it ends, so a
 * phone with the app closed can wait on an idle socket for the one thing
 * that should wake it, instead of receiving and decrypting every presence
 * heartbeat in every room. See "Call bell" in `docs/protocol.md`.
 *
 * On the wire the bell says as little as it can. The outer event is signed
 * by a key minted for that one bell and thrown away, never a device or a
 * participant key. Its only tags are `d`, a rendezvous derived from the
 * room's current epoch key and the UTC day, and a NIP-40 `expiration`. The
 * content is NIP-44 v2 under a key derived from the same epoch key, and
 * carries the device that rang and that device's signature, so a member can
 * attribute it through the roster and nobody else can.
 */

/** How long a bell means anything, in seconds: its NIP-40 expiration, and
 *  the oldest a reader accepts. */
export const CALL_BELL_TTL_SECONDS = 120
/** How far ahead of the reader's clock a bell may be stamped. */
export const CALL_BELL_FUTURE_SKEW_SECONDS = 60
/** How long a call may have been running when its `end` rings. */
export const CALL_BELL_MAX_CALL_SECONDS = 30 * 86_400

const TAG_KEY_INFO = 'kithmoot/v1/call-bell-tag'
const CONTENT_KEY_INFO = 'kithmoot/v1/call-bell-key'
const TAG_PREFIX = 'kithmoot-call-bell-v1|'
const SIGNATURE_PREFIX = 'kithmoot/v1/call-bell'

export type CallBellState = 'start' | 'end'

export interface CallBell {
  state: CallBellState
  call: CallMembership
  /** The device that rang. A reader attributes it through the roster. */
  device: string
  /** The outer event's `created_at`, which the device's signature covers. */
  createdAt: number
}

/** The UTC day of a Unix second, `yyyy-mm-dd`. */
export function callBellDay(unixSeconds: number): string {
  return new Date(Math.floor(unixSeconds) * 1000).toISOString().slice(0, 10)
}

/**
 * The bell's `d` tag for a room/epoch key at a moment:
 * `hex(HMAC-SHA256(HKDF(key, "kithmoot/v1/call-bell-tag"), "kithmoot-call-bell-v1|" + day))`,
 * first 32 hex characters. It changes at every UTC midnight and shares
 * nothing with the roster's `d`.
 */
export function callBellTag(key: Uint8Array, unixSeconds: number): string {
  const tagKey = hkdf(sha256, key, undefined, TAG_KEY_INFO, 32)
  return bytesToHex(hmac(sha256, tagKey, new TextEncoder().encode(TAG_PREFIX + callBellDay(unixSeconds)))).slice(0, 32)
}

/** The tags a listener subscribes to at `now`: today's, and the neighbouring
 *  day's while a bell stamped on the other side of midnight could still be
 *  accepted. One or two values. */
export function callBellListenTags(key: Uint8Array, now: number): string[] {
  const tags = [now - CALL_BELL_TTL_SECONDS, now, now + CALL_BELL_FUTURE_SKEW_SECONDS].map((t) => callBellTag(key, t))
  return [...new Set(tags)]
}

/** The NIP-44 conversation key the bell's content is sealed under. */
export function callBellContentKey(key: Uint8Array): Uint8Array {
  return hkdf(sha256, key, undefined, CONTENT_KEY_INFO, 32)
}

/** The 32 bytes the device signs:
 *  `sha256("kithmoot/v1/call-bell:" + room + ":" + state + ":" + callId + ":" + since + ":" + createdAt)`. */
export function callBellMessage(roomId: string, state: CallBellState, call: CallMembership, createdAt: number): Uint8Array {
  return sha256(new TextEncoder().encode(`${SIGNATURE_PREFIX}:${roomId.toLowerCase()}:${state}:${call.id}:${call.since}:${createdAt}`))
}

export interface EncodeCallBellOptions {
  roomId: string
  /** The current room/epoch key: the one the roster rides under. */
  key: Uint8Array
  deviceSk: Uint8Array
  state: CallBellState
  call: CallMembership
  /** Unix seconds. */
  createdAt: number
}

/** Build a bell, signed by a key minted here and discarded. */
export function encodeCallBellEvent(opts: EncodeCallBellOptions): Event {
  const call = sanitiseCallMembership(opts.call)
  if (!call) throw new Error('call bell: malformed call')
  const createdAt = Math.floor(opts.createdAt)
  const sig = bytesToHex(schnorr.sign(callBellMessage(opts.roomId, opts.state, call, createdAt), opts.deviceSk))
  const plaintext = JSON.stringify({ v: 1, state: opts.state, call, device: getPublicKey(opts.deviceSk), sig })
  const throwaway = generateSecretKey()
  const event = finalizeEvent(
    {
      kind: KINDS.CALL_BELL,
      created_at: createdAt,
      tags: [['d', callBellTag(opts.key, createdAt)], ['expiration', String(createdAt + CALL_BELL_TTL_SECONDS)]],
      content: nip44.v2.encrypt(plaintext, callBellContentKey(opts.key)),
    },
    throwaway,
  )
  throwaway.fill(0)
  return event
}

export interface DecodeCallBellOptions {
  roomId: string
  key: Uint8Array
  /** Unix seconds. */
  now: number
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/**
 * Read and verify a bell. Null for anything that does not check out: wrong
 * kind or tag, bad outer signature, a key that does not open it, an unknown
 * version or state, a malformed call, a device signature that fails, a bell
 * older than its expiry or stamped too far ahead, a `since` that cannot be
 * right. Never throws. Whether `device` belongs to the room is the caller's
 * to check against the roster.
 */
export function decodeCallBellEvent(event: Event, opts: DecodeCallBellOptions): CallBell | null {
  try {
    if (event.kind !== KINDS.CALL_BELL) return null
    const createdAt = event.created_at
    if (!Number.isSafeInteger(createdAt)) return null
    if (opts.now - createdAt > CALL_BELL_TTL_SECONDS) return null
    if (createdAt - opts.now > CALL_BELL_FUTURE_SKEW_SECONDS) return null
    const d = event.tags.find((t) => t[0] === 'd')?.[1]
    if (d === undefined || d.toLowerCase() !== callBellTag(opts.key, createdAt)) return null
    if (!verifyEventUncached(event)) return null

    const body = JSON.parse(nip44.v2.decrypt(event.content, callBellContentKey(opts.key))) as Record<string, unknown>
    if (!body || typeof body !== 'object' || body.v !== 1) return null
    const state = body.state
    if (state !== 'start' && state !== 'end') return null
    const raw = body.call as { id?: unknown; since?: unknown } | undefined
    if (!raw || typeof raw.id !== 'string' || !/^[0-9a-f]{32}$/.test(raw.id)) return null
    if (typeof raw.since !== 'number' || !Number.isSafeInteger(raw.since) || raw.since < 0) return null
    const call: CallMembership = { id: raw.id, since: raw.since }
    if (call.since > createdAt + CALL_BELL_FUTURE_SKEW_SECONDS) return null
    const oldest = state === 'start' ? CALL_BELL_TTL_SECONDS : CALL_BELL_MAX_CALL_SECONDS
    if (call.since < createdAt - oldest) return null
    if (typeof body.device !== 'string' || !HEX64.test(body.device.toLowerCase())) return null
    if (typeof body.sig !== 'string' || !HEX128.test(body.sig.toLowerCase())) return null
    const device = body.device.toLowerCase()
    if (!schnorr.verify(hexToBytes(body.sig.toLowerCase()), callBellMessage(opts.roomId, state, call, createdAt), hexToBytes(device))) return null
    return { state, call, device, createdAt }
  } catch {
    return null
  }
}
