import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { verifyDeviceCredential } from './credential.js'
import { verifyEventUncached } from './verify.js'
import type { RosterEntry } from './types.js'

export interface EncodeRosterOptions {
  roomId: string
  roomKey: Uint8Array
  deviceSk: Uint8Array
}

/**
 * Encode a roster entry as an event encrypted to the room key.
 *
 * The room key is supplied directly as NIP-44's conversation key, which reuses
 * its audited AEAD rather than inventing a symmetric scheme. Everything
 * identifying - the participant pubkey, the credential, the track list - is
 * inside the ciphertext; only the room id is on the wire.
 */
export function encodeRosterEvent(entry: RosterEntry, opts: EncodeRosterOptions): Event {
  const plaintext = JSON.stringify(entry)
  const content = nip44.v2.encrypt(plaintext, opts.roomKey)
  return finalizeEvent(
    {
      kind: KINDS.ROSTER,
      created_at: entry.updatedAt,
      tags: [['d', opts.roomId]],
      content,
    },
    opts.deviceSk,
  )
}

export interface DecodeRosterOptions {
  roomId: string
  roomKey: Uint8Array
  /** Unix seconds. */
  now: number
}

/**
 * Decode and fully verify a roster event.
 *
 * Returns null for anything that does not check out - wrong key, wrong room,
 * bad signature, unauthorised device, expired credential, malformed payload.
 * It never throws, because it runs inside a relay subscription handler where a
 * throw would take down the whole room.
 */
export function decodeRosterEvent(event: Event, opts: DecodeRosterOptions): RosterEntry | null {
  try {
    if (event.kind !== KINDS.ROSTER) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1] !== opts.roomId) return null
    if (!verifyEventUncached(event)) return null

    const entry = JSON.parse(nip44.v2.decrypt(event.content, opts.roomKey)) as RosterEntry

    // The device that signed this event must be the device the credential names.
    if (entry.device !== event.pubkey) return null

    const verdict = verifyDeviceCredential(entry.credential, {
      roomId: opts.roomId,
      now: opts.now,
    })
    if (!verdict.ok) return null
    if (verdict.device !== event.pubkey) return null
    if (verdict.participant !== entry.participant) return null

    // Deliberately NOT restamping verifiedSymbol onto the credential here.
    // It would be truthful at the moment of writing, but it hands a future
    // caller an object pre-marked verified - the exact footgun
    // `verifyEventUncached` exists to close. Re-hashing a credential is
    // cheap; a signature check that silently does nothing is not.
    return entry
  } catch {
    return null
  }
}

/** Convenience for callers that hold a device secret key rather than a pubkey. */
export function devicePubkeyOf(deviceSk: Uint8Array): string {
  return getPublicKey(deviceSk)
}
