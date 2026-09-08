import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { verifyEventUncached as verifyEvent } from './verify.js'
import { KINDS } from './kinds.js'
import { SIGNAL_MAX_AGE_SECONDS } from './signal-guard.js'

// Re-exported here because this is where the staleness rule is applied, even
// though it sits with the other two NIP-AC rules in `signal-guard.ts`.
export { SIGNAL_MAX_AGE_SECONDS }
import { hexEquals, normaliseHex } from './hex.js'
import type { TrackAdvert } from './types.js'

export interface AnnotationPoint { x: number; y: number }
export interface ScreenAnnotation {
  op: 'stroke' | 'clear'
  /** The advertised screen track id: stable across every viewer's layout. */
  shareId: string
  /** Unique within one sending device. Empty only for a clear operation. */
  strokeId: string
  /** Coordinates in the shared image, from zero to one. */
  points?: AnnotationPoint[]
}

export interface SignalBody {
  /**
   * `assist` is not a negotiation step: it is one member asking another to
   * carry a pair it cannot reach directly, and the answer to that request.
   * It rides the same wrap as the rest of signalling because it is exactly as
   * sensitive - it names two devices and says they could not reach each other
   * - and because a second signalling path would be a second set of
   * staleness, dedup and rate-limit rules to get right.
   */
  type: 'offer' | 'answer' | 'ice' | 'assist' | 'annotation'
  roomId: string
  sdp?: string
  candidate?: string
  trackHints?: TrackAdvert[]
  /** For an `assist` signal: the far end of the pair being asked about. The
   *  sender is the near end, so the pair is fully named without a second
   *  field, and neither end can ask about a pair it is not part of. */
  assist?: string
  /**
   * For an offer: which rung of the route ladder the offerer is on.
   *
   * The two ends of a pair walk the ladder on their own clocks. One that
   * reaches TURN builds a connection with relay candidates and offers on
   * it; the other, still on the direct rung, answered from a connection
   * with no relay candidates, then tore it down on its own timer, and the
   * two chased each other round the ladder without ever meeting. Saying
   * which rung an offer comes from lets the far end hop to the same rung
   * before it answers. Optional and additive: a client that does not send
   * it is answered as before, and one that does not read it behaves as
   * before.
   */
  tier?: 'direct' | 'assist' | 'forwarder' | 'turn'
  /** For an `assist` signal: present on the reply and absent on the request.
   *  A refusal is an ordinary answer - a volunteer with no slots left - and
   *  saying so at once is what lets the asker fall to the next rung rather
   *  than waiting out a timeout. */
  accept?: boolean
  /** Temporary screen-share markup. It uses signalling because that path is
   * encrypted, live and already addressed to every room device. */
  annotation?: ScreenAnnotation
}

/** Relay retention hint; local acceptance still uses the signed inner time. */
export const SIGNAL_EXPIRATION_SECONDS = 60
/** Bound attacker-controlled input before signature verification or decryption. */
export const MAX_SIGNAL_WRAP_LENGTH = 131_072
export const SIGNAL_PROFILE = '1'

export interface WrapOptions {
  /** The sending device's secret key. Signs the inner event. */
  senderSk: Uint8Array
  recipientPubkey: string
}

/**
 * Wrap a signal for exactly one peer.
 *
 * An SDP names the sender's network addresses, so it must never sit readable
 * on a public relay. The inner event is signed by the sending device and then
 * wrapped under a fresh random key, so the relay sees neither the payload nor
 * who sent it - only that someone sent something to the recipient.
 */
export function wrapSignal(body: SignalBody, opts: WrapOptions): Event {
  // One captured instant for both layers. Sampling twice can straddle a Unix
  // second: the outer event then appears newer than the signed inner signal,
  // which makes boundary staleness checks nondeterministic.
  const createdAt = Math.floor(Date.now() / 1000)
  const inner = finalizeEvent(
    {
      kind: KINDS.SIGNAL,
      created_at: createdAt,
      tags: [['p', opts.recipientPubkey], ['call-id', body.roomId], ['alt', 'KithMoot call signalling'], ['kithmoot', SIGNAL_PROFILE]],
      content: JSON.stringify(body),
    },
    opts.senderSk,
  )

  const ephemeralSk = generateSecretKey()
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, opts.recipientPubkey)

  return finalizeEvent(
    {
      kind: KINDS.SIGNAL_WRAP,
      created_at: createdAt,
      tags: [['p', opts.recipientPubkey], ['expiration', String(createdAt + SIGNAL_EXPIRATION_SECONDS)]],
      content: nip44.v2.encrypt(JSON.stringify(inner), conversationKey),
    },
    ephemeralSk,
  )
}

export interface UnwrapOptions {
  recipientSk: Uint8Array
  roomId: string
  /** Unix seconds. Defaults to the real clock; injectable so a test - or a
   *  vector, which is stamped with a fixed time - is not at the mercy of one. */
  now?: number
  /** How far either side of `now` a signal may be stamped before it is
   *  refused. See `SIGNAL_MAX_AGE_SECONDS`. */
  maxAgeSeconds?: number
}

export const MAX_ANNOTATION_POINTS = 128

/** Validate the bounded, normalised shape before a drawing reaches UI code. */
export function validScreenAnnotation(value: unknown): value is ScreenAnnotation {
  if (!value || typeof value !== 'object') return false
  const annotation = value as Partial<ScreenAnnotation>
  if (annotation.op !== 'stroke' && annotation.op !== 'clear') return false
  if (typeof annotation.shareId !== 'string' || annotation.shareId.length < 1 || annotation.shareId.length > 128) return false
  if (typeof annotation.strokeId !== 'string' || annotation.strokeId.length > 128) return false
  if (annotation.op === 'clear') return annotation.strokeId === '' && annotation.points === undefined
  if (annotation.strokeId.length < 1 || !Array.isArray(annotation.points) || annotation.points.length < 2 || annotation.points.length > MAX_ANNOTATION_POINTS) return false
  return annotation.points.every(point =>
    point !== null && typeof point === 'object' &&
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1,
  )
}

/**
 * Unwrap and verify a signal. Returns null for anything that does not check
 * out, and never throws - this runs inside a subscription handler.
 */
export function unwrapSignalEvent(
  wrap: Event,
  opts: UnwrapOptions,
): { id: string; from: string; body: SignalBody } | null {
  try {
    if (wrap.kind !== KINDS.SIGNAL_WRAP || typeof wrap.content !== 'string' || wrap.content.length > MAX_SIGNAL_WRAP_LENGTH) return null
    if (!Array.isArray(wrap.tags) || wrap.tags.length > 16 || wrap.tags.some(t => !Array.isArray(t) || t.length > 8 || t.some(v => typeof v !== 'string' || v.length > 2048))) return null
    if (!verifyEvent(wrap)) return null

    const conversationKey = nip44.v2.utils.getConversationKey(opts.recipientSk, wrap.pubkey)
    let inner = JSON.parse(nip44.v2.decrypt(wrap.content, conversationKey)) as Event
    if (inner.kind === 13) {
      const seal = inner
      if (!verifyEvent(seal)) return null
      const sealKey = nip44.v2.utils.getConversationKey(opts.recipientSk, seal.pubkey)
      inner = JSON.parse(nip44.v2.decrypt(seal.content, sealKey)) as Event
      // A rumor is unsigned. Its author must be the verified seal author,
      // and its id must be its canonical hash, not an attacker-supplied id.
      if (inner.kind !== KINDS.SIGNAL || !hexEquals(inner.pubkey, seal.pubkey)) return null
      if (getEventHash(inner) !== inner.id) return null
    } else if (inner.kind !== KINDS.SIGNAL || !verifyEvent(inner)) return null

    // Staleness, checked on the *inner* event: it is the one the sending
    // device signed, so its timestamp cannot be restamped by whoever replays
    // the wrap. See `SIGNAL_MAX_AGE_SECONDS` for why the window is symmetric.
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const maxAge = opts.maxAgeSeconds ?? SIGNAL_MAX_AGE_SECONDS
    if (Math.abs(now - inner.created_at) > maxAge) return null

    const body = JSON.parse(inner.content) as SignalBody
    if (!hexEquals(body.roomId, opts.roomId)) return null
    if (!['offer', 'answer', 'ice', 'assist', 'annotation'].includes(body.type)) return null
    if (body.type === 'annotation' && !validScreenAnnotation(body.annotation)) return null
    const calls = inner.tags.filter(tag => tag[0] === 'call-id')
    if (calls.length > 1 || (calls.length === 1 && !hexEquals(calls[0]?.[1] ?? '', opts.roomId))) return null

    // The inner event must be addressed to us, not merely wrapped to us.
    const addressed = inner.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, getPublicKey(opts.recipientSk))) return null

    // `from` is a device pubkey entering the system off the wire - the
    // `Mesh` peer map it gets looked up in is keyed by the same normalised
    // form roster decode produces, so this must match. See `normaliseHex`.
    return { id: inner.id, from: normaliseHex(inner.pubkey), body }
  } catch {
    return null
  }
}

/** Preserve the existing public return shape for callers and legacy vectors. */
export function unwrapSignal(wrap: Event, opts: UnwrapOptions): { from: string; body: SignalBody } | null {
  const event = unwrapSignalEvent(wrap, opts)
  return event ? { from: event.from, body: event.body } : null
}
