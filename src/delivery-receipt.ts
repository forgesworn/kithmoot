import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { KINDS } from './kinds.js'
import { withExpiration } from './expiration.js'
import { verifyEventUncached } from './verify.js'
import { verifyDeviceCredential } from './credential.js'
import { evaluateAccess } from './access.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { ChatStream } from './chat.js'
import type { DeviceCredential, KindredProof, RoomPolicy } from './types.js'

/**
 * Delivery receipts (kind 1465): a device saying "these messages reached
 * me", so their sender can show two ticks. Never "seen" or "read": a
 * receipt means the message was decrypted and verified on a device, and
 * nothing about whether anyone looked. See "Delivery receipts" in
 * `docs/protocol.md` and `docs/design/2026-10-28-delivery-ticks.md`.
 *
 * The outer event is signed by a key made for that one receipt, derived
 * from the device key so the device can later ask relays to delete it
 * (leave and delete, tidy-up, self-destruct). Its only tags are the chat
 * stream's existing `d` and a NIP-40 `expiration` at most seven days out,
 * so a relay learns no more than the stream's chat already tells it. The
 * content is NIP-44 v2 under a key derived from the stream key, and carries
 * the receiving device's signature and credential, so a member can say
 * whose device it was and nobody else can.
 *
 * Receipts name messages (by a short hash of each id) rather than saying
 * "everything up to here": chat has no sequence numbers, and a high-water
 * mark would light two ticks on a message a relay dropped.
 */

/** How long a receipt lives: its NIP-40 expiration at most, and the oldest a
 *  reader accepts. Seven days. */
export const DELIVERY_RECEIPT_TTL_SECONDS = 604_800
/** How far ahead of the reader's clock a receipt may be stamped, and the
 *  slack on its expiration. Tighter than chat's 300 s on purpose: a receipt
 *  is written the moment it is signed, never composed offline. */
export const DELIVERY_RECEIPT_FUTURE_SKEW_SECONDS = 60
/** The most message hashes one receipt may carry. A writer splits beyond it. */
export const MAX_DELIVERY_RECEIPT_IDS = 256
/** Maximum UTF-8 wire size, checked before signature verification or decryption. */
export const MAX_DELIVERY_RECEIPT_EVENT_BYTES = 16_384
/** The most tags a receipt may carry: `d`, `expiration` and room to grow. */
export const MAX_DELIVERY_RECEIPT_TAGS = 4

export const DELIVERY_RECEIPT_SIGNATURE_PREFIX = 'kithmoot/v1/delivery-receipt'
const OUTER_KEY_INFO = 'kithmoot/v1/delivery-receipt-outer'
const RECEIPT_KEY_INFO = 'kithmoot/v1/delivery-receipt-key'
const ID_HASH_PREFIX = 'kithmoot/v1/delivery-receipt-id:'

const HEX64 = /^[0-9a-f]{64}$/
const HEX64_ANY_CASE = /^[0-9a-fA-F]{64}$/
const ID_HASH = /^[0-9a-f]{16}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

/** A receipt that passed every check. */
export interface DeliveryReceipt {
  /** The stream it was published under: which chat it is about. */
  d: string
  /** The outer event's `created_at`, which the device signature covers. */
  createdAt: number
  /** The receiving person, bound to `device` by the carried credential. */
  participant: string
  device: string
  /** True only when the receipt said exactly `true`. */
  agent: boolean
  /** `deliveryReceiptIdHash` of each message received. */
  got: string[]
}

export interface EncodeDeliveryReceiptOptions {
  /** The room the credential names, whatever epoch the stream rides in. */
  roomId: string
  /** The chat stream these messages arrived on (see `chatStreamsOf`). */
  stream: ChatStream
  deviceSk: Uint8Array
  /** This device's credential for the room, valid at `createdAt`. Its
   *  participant is what the receipt names. */
  credential: DeviceCredential
  /** The admission proof chat carries in closed tiers, when there is one. */
  proof?: KindredProof
  agent?: boolean
  /** The ids (`ChatMessage.id`) of the messages being acknowledged. Hashed
   *  here; duplicates collapse. One to `MAX_DELIVERY_RECEIPT_IDS`. */
  messageIds: readonly string[]
  /** Unix seconds. */
  createdAt: number
  /** Which receipt this is within the same second for this stream, when a
   *  flush splits. Feeds the outer key, so two receipts never share one. */
  index?: number
  /** A conference room's end, in unix seconds, which lowers the expiration. */
  expiresAt?: number
}

export interface DecodeDeliveryReceiptOptions {
  roomId: string
  /** Every stream this reader follows: a receipt under any other `d` is
   *  refused, and the matching stream's key opens it. */
  streams: readonly ChatStream[]
  /** Unix seconds. */
  now: number
  policy?: RoomPolicy
}

/** The NIP-44 conversation key receipts on a stream are sealed under:
 *  HKDF-SHA256(stream key, empty salt, `kithmoot/v1/delivery-receipt-key`).
 *  Separate from the chat key, so a receipt can never be read as chat. */
export function deliveryReceiptKey(streamKey: Uint8Array): Uint8Array {
  return hkdf(sha256, streamKey, undefined, new TextEncoder().encode(RECEIPT_KEY_INFO), 32)
}

/**
 * The outer secret key of one receipt: HKDF-SHA256(device secret key, empty
 * salt, `kithmoot/v1/delivery-receipt-outer:<d>:<created_at>:<n>`). Derived,
 * not drawn, so the device can sign NIP-09 deletions of its own receipts
 * from a list of `(d, created_at, n)`, and nobody without the device key can
 * link two receipts to each other or to the device. The caller zeroes it.
 */
export function deliveryReceiptOuterSecretKey(deviceSk: Uint8Array, d: string, createdAt: number, index = 0): Uint8Array {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('a receipt time is a whole number of seconds')
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('a receipt index is a whole number')
  const info = `${OUTER_KEY_INFO}:${normaliseHex(d)}:${createdAt}:${index}`
  const sk = hkdf(sha256, deviceSk, undefined, new TextEncoder().encode(info), 32)
  // Outside [1, n) with negligible probability; refuse rather than reduce.
  getPublicKey(sk)
  return sk
}

/** What a receipt says about one message: the first 16 hex characters of
 *  SHA-256(UTF-8 `kithmoot/v1/delivery-receipt-id:` + message id). A fixed
 *  size whatever the id's format; a sender matches it only against its own
 *  messages in that stream. */
export function deliveryReceiptIdHash(messageId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(ID_HASH_PREFIX + messageId))).slice(0, 16)
}

/** What the receiving device signs: SHA-256 of UTF-8
 *  `kithmoot/v1/delivery-receipt:<room id>:<d>:<outer pubkey>:<created_at>:<body>`,
 *  hex lower case. Binding the outer key and `d` stops a member lifting a
 *  body into another event or stream. */
export function deliveryReceiptDigest(roomId: string, d: string, outer: string, createdAt: number, body: string): Uint8Array {
  return sha256(new TextEncoder().encode(
    `${DELIVERY_RECEIPT_SIGNATURE_PREFIX}:${normaliseHex(roomId)}:${normaliseHex(d)}:${normaliseHex(outer)}:${createdAt}:${body}`))
}

/**
 * Encode one receipt. Throws when the inputs could not produce a receipt a
 * reader would accept: no ids or too many, a credential that does not name
 * this device for this room at `createdAt`, or an event over the size cap
 * (split the ids and try again).
 */
export function encodeDeliveryReceipt(opts: EncodeDeliveryReceiptOptions): Event {
  const got = [...new Set(opts.messageIds.map(deliveryReceiptIdHash))]
  if (got.length === 0 || got.length > MAX_DELIVERY_RECEIPT_IDS) throw new Error('a receipt names 1 to 256 messages')
  if (!Number.isSafeInteger(opts.createdAt) || opts.createdAt < 0) throw new Error('a receipt time is a whole number of seconds')
  if (!HEX64_ANY_CASE.test(opts.stream.d)) throw new Error('a receipt rides a chat stream')
  const roomId = normaliseHex(opts.roomId)
  const d = normaliseHex(opts.stream.d)
  const device = getPublicKey(opts.deviceSk)
  const verdict = verifyDeviceCredential(opts.credential, { roomId, now: opts.createdAt })
  if (!verdict.ok || !hexEquals(verdict.device, device)) throw new Error('a receipt carries this device\'s credential for the room')
  const participant = normaliseHex(verdict.participant)

  // Canonical order, no whitespace, optional fields absent rather than null.
  const body = JSON.stringify({
    v: 1,
    room: roomId,
    participant,
    device,
    credential: opts.credential,
    proof: opts.proof,
    agent: opts.agent === true ? true : undefined,
    got,
  })
  const tags = withExpiration([['d', d], ['expiration', String(opts.createdAt + DELIVERY_RECEIPT_TTL_SECONDS)]], opts.expiresAt)
  const outerSk = deliveryReceiptOuterSecretKey(opts.deviceSk, d, opts.createdAt, opts.index ?? 0)
  const receiptKey = deliveryReceiptKey(opts.stream.key)
  try {
    const outer = getPublicKey(outerSk)
    const sig = bytesToHex(schnorr.sign(deliveryReceiptDigest(roomId, d, outer, opts.createdAt, body), opts.deviceSk))
    const content = nip44.v2.encrypt(JSON.stringify({ v: 1, body, sig }), receiptKey)
    const event = finalizeEvent({ kind: KINDS.DELIVERY_RECEIPT, created_at: opts.createdAt, tags, content }, outerSk)
    if (wireBytes(event) > MAX_DELIVERY_RECEIPT_EVENT_BYTES) throw new Error('receipt too large; split its messages')
    return event
  } finally {
    outerSk.fill(0)
    receiptKey.fill(0)
  }
}

/**
 * Decode and verify a receipt. Returns null for anything that does not
 * check out, never throws: this runs inside a relay subscription handler.
 * Cheap bounds come before any signature check or decryption.
 */
export function decodeDeliveryReceipt(event: Event, opts: DecodeDeliveryReceiptOptions): DeliveryReceipt | null {
  let receiptKey: Uint8Array | undefined
  try {
    const shape = boundedReceipt(event)
    if (!shape) return null
    const { d, expiration } = shape
    const createdAt = event.created_at
    if (createdAt > opts.now + DELIVERY_RECEIPT_FUTURE_SKEW_SECONDS) return null
    if (createdAt < opts.now - DELIVERY_RECEIPT_TTL_SECONDS) return null
    if (expiration <= opts.now) return null
    const stream = opts.streams.find((s) => hexEquals(s.d, d))
    if (!stream) return null
    if (!verifyEventUncached(event)) return null

    receiptKey = deliveryReceiptKey(stream.key)
    const envelope = openEnvelope(JSON.parse(nip44.v2.decrypt(event.content, receiptKey)))
    if (!envelope) return null
    const parsed: unknown = JSON.parse(envelope.body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const body = parsed as Record<string, unknown>
    if (body.v !== 1) return null
    if (typeof body.room !== 'string' || !HEX64.test(body.room) || !hexEquals(body.room, opts.roomId)) return null
    if (typeof body.participant !== 'string' || !HEX64.test(body.participant)) return null
    if (typeof body.device !== 'string' || !HEX64.test(body.device)) return null
    if (typeof body.credential !== 'object' || body.credential === null || Array.isArray(body.credential)) return null
    if (body.proof !== undefined && (typeof body.proof !== 'object' || body.proof === null || Array.isArray(body.proof))) return null
    const got = wellFormedGot(body.got)
    if (!got) return null

    const digest = deliveryReceiptDigest(opts.roomId, d, event.pubkey, createdAt, envelope.body)
    if (!schnorr.verify(hexToBytes(envelope.sig), digest, hexToBytes(body.device))) return null

    // The credential is what binds the device to the person it names, as at
    // the receipt's own time, exactly as chat checks it at `sentAt`.
    const verdict = verifyDeviceCredential(body.credential as DeviceCredential, { roomId: opts.roomId, now: createdAt })
    if (!verdict.ok || !hexEquals(verdict.device, body.device) || !hexEquals(verdict.participant, body.participant)) return null
    if (opts.policy) {
      const access = evaluateAccess(opts.policy, body.participant, body.proof as KindredProof | undefined, createdAt, opts.roomId)
      if (!access.admitted) return null
    }

    return {
      d: normaliseHex(d),
      createdAt,
      participant: body.participant,
      device: body.device,
      agent: body.agent === true,
      got,
    }
  } catch {
    return null
  } finally {
    receiptKey?.fill(0)
  }
}

/** The routing a receipt may carry, checked on the wire fields alone. */
function boundedReceipt(event: Event): { d: string; expiration: number } | null {
  if (event.kind !== KINDS.DELIVERY_RECEIPT) return null
  if (typeof event.content !== 'string' || event.content.length > MAX_DELIVERY_RECEIPT_EVENT_BYTES) return null
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null
  if (typeof event.id !== 'string' || !HEX64_ANY_CASE.test(event.id) ||
      typeof event.pubkey !== 'string' || !HEX64_ANY_CASE.test(event.pubkey) ||
      typeof event.sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(event.sig)) return null
  if (!Array.isArray(event.tags) || event.tags.length > MAX_DELIVERY_RECEIPT_TAGS) return null
  const seen = new Set<string>()
  let d: string | undefined
  let expiration: number | undefined
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) return null
    for (const value of tag) {
      if (typeof value !== 'string' || value.length > MAX_DELIVERY_RECEIPT_EVENT_BYTES) return null
    }
    const name = tag[0]!
    if (!name || seen.has(name)) return null
    seen.add(name)
    if (name === 'd') {
      if (tag.length !== 2 || !HEX64_ANY_CASE.test(tag[1]!)) return null
      d = tag[1]!
    } else if (name === 'expiration') {
      if (tag.length !== 2 || !DECIMAL.test(tag[1]!)) return null
      const value = Number(tag[1])
      if (!Number.isSafeInteger(value)) return null
      expiration = value
    }
  }
  if (d === undefined || expiration === undefined) return null
  if (expiration <= event.created_at) return null
  if (expiration > event.created_at + DELIVERY_RECEIPT_TTL_SECONDS + DELIVERY_RECEIPT_FUTURE_SKEW_SECONDS) return null
  if (wireBytes(event) > MAX_DELIVERY_RECEIPT_EVENT_BYTES) return null
  return { d, expiration }
}

/** The UTF-8 size of the event's wire fields, never an untrusted object's
 *  extra properties. */
function wireBytes(event: Event): number {
  const wire = JSON.stringify({ id: event.id, pubkey: event.pubkey, sig: event.sig,
    kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })
  return new TextEncoder().encode(wire).length
}

function openEnvelope(raw: unknown): { body: string; sig: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'body' || keys[1] !== 'sig' || keys[2] !== 'v') return null
  if (value.v !== 1 || typeof value.body !== 'string' || typeof value.sig !== 'string' || !/^[0-9a-f]{128}$/.test(value.sig)) return null
  return { body: value.body, sig: value.sig }
}

function wellFormedGot(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DELIVERY_RECEIPT_IDS) return null
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || !ID_HASH.test(entry) || seen.has(entry)) return null
    seen.add(entry)
  }
  return [...seen]
}

/** Every wire label this file carries, frozen by `labels.test.ts`. */
export const DELIVERY_RECEIPT_LABELS = [
  "kithmoot/v1/delivery-receipt",
  "kithmoot/v1/delivery-receipt-id:",
  "kithmoot/v1/delivery-receipt-key",
  "kithmoot/v1/delivery-receipt-outer",
  "kithmoot/v1/delivery-receipt-outer:",
  "kithmoot/v1/delivery-receipt:",
] as const
