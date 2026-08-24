import { finalizeEvent, getPublicKey, verifyEvent, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { verifyDeviceCredential } from './credential.js'
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
    if (!verifyEvent(event)) return null

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

    // JSON.stringify drops symbol-keyed properties, so the credential parsed
    // back out of the ciphertext has lost the verifiedSymbol cache that
    // finalizeEvent stamped on it originally. verifyDeviceCredential just did
    // the real work of checking its signature, so restamp it here - this
    // mirrors nostr-tools's own caching convention and means a caller who
    // re-verifies this credential later gets the cached fast path instead of
    // silently re-hashing.
    entry.credential[verifiedSymbol] = true

    return entry
  } catch {
    return null
  }
}

/** Convenience for callers that hold a device secret key rather than a pubkey. */
export function devicePubkeyOf(deviceSk: Uint8Array): string {
  return getPublicKey(deviceSk)
}
