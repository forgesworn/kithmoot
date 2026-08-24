import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { SIGNAL_MAX_AGE_SECONDS } from './signal-guard.js'

// Re-exported here because this is where the staleness rule is applied, even
// though it sits with the other two NIP-AC rules in `signal-guard.ts`.
export { SIGNAL_MAX_AGE_SECONDS }
import { hexEquals, normaliseHex } from './hex.js'
import type { TrackAdvert } from './types.js'

export interface SignalBody {
  type: 'offer' | 'answer' | 'ice'
  roomId: string
  sdp?: string
  candidate?: string
  trackHints?: TrackAdvert[]
}

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
  const inner = finalizeEvent(
    {
      kind: KINDS.SIGNAL,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', opts.recipientPubkey]],
      content: JSON.stringify(body),
    },
    opts.senderSk,
  )

  const ephemeralSk = generateSecretKey()
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, opts.recipientPubkey)

  return finalizeEvent(
    {
      kind: KINDS.SIGNAL_WRAP,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', opts.recipientPubkey]],
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

/**
 * Unwrap and verify a signal. Returns null for anything that does not check
 * out, and never throws - this runs inside a subscription handler.
 */
export function unwrapSignal(
  wrap: Event,
  opts: UnwrapOptions,
): { from: string; body: SignalBody } | null {
  try {
    if (wrap.kind !== KINDS.SIGNAL_WRAP) return null

    const conversationKey = nip44.v2.utils.getConversationKey(opts.recipientSk, wrap.pubkey)
    const inner = JSON.parse(nip44.v2.decrypt(wrap.content, conversationKey)) as Event

    if (inner.kind !== KINDS.SIGNAL) return null
    if (!verifyEvent(inner)) return null

    // Staleness, checked on the *inner* event: it is the one the sending
    // device signed, so its timestamp cannot be restamped by whoever replays
    // the wrap. See `SIGNAL_MAX_AGE_SECONDS` for why the window is symmetric.
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const maxAge = opts.maxAgeSeconds ?? SIGNAL_MAX_AGE_SECONDS
    if (Math.abs(now - inner.created_at) > maxAge) return null

    const body = JSON.parse(inner.content) as SignalBody
    if (!hexEquals(body.roomId, opts.roomId)) return null

    // The inner event must be addressed to us, not merely wrapped to us.
    const addressed = inner.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, getPublicKey(opts.recipientSk))) return null

    // `from` is a device pubkey entering the system off the wire - the
    // `Mesh` peer map it gets looked up in is keyed by the same normalised
    // form roster decode produces, so this must match. See `normaliseHex`.
    return { from: normaliseHex(inner.pubkey), body }
  } catch {
    return null
  }
}
