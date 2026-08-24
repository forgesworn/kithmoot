import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { hexEquals } from './hex.js'
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

    const body = JSON.parse(inner.content) as SignalBody
    if (!hexEquals(body.roomId, opts.roomId)) return null

    // The inner event must be addressed to us, not merely wrapped to us.
    const addressed = inner.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, getPublicKey(opts.recipientSk))) return null

    return { from: inner.pubkey, body }
  } catch {
    return null
  }
}
