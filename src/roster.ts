import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { KINDS } from './kinds.js'
import { verifyDeviceCredential } from './credential.js'
import { verifyEventUncached } from './verify.js'
import { hexEquals, normaliseHex } from './hex.js'
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

/**
 * How far ahead of our own clock a roster timestamp may be stamped.
 *
 * `updatedAt` decides which of two entries for one device wins, and a
 * singular-role claim time decides which of a participant's devices holds the
 * microphone. Both are chosen by the device that publishes them, so a device
 * stamping the year 3000 pins itself into the roster for good and locks the
 * mic against its owner's other devices - neither can ever be superseded by a
 * genuine later value. The bound has to be loose enough that real clocks,
 * which disagree by seconds, are not refused.
 */
export const MAX_FUTURE_SKEW_SECONDS = 60

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
    const roomTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (roomTag === undefined || !hexEquals(roomTag, opts.roomId)) return null
    if (!verifyEventUncached(event)) return null

    const entry = JSON.parse(nip44.v2.decrypt(event.content, opts.roomKey)) as RosterEntry

    // This is the boundary: a roster entry's device/participant/proof
    // fields are attacker- or other-implementation-controlled JSON, with
    // nothing on the wire forcing lower case. Canonicalise them here, once,
    // so every later comparison downstream - `Peer`'s politeness tiebreak,
    // `resolveSingularRoles`' device tiebreak, every Map/Set keyed on a
    // device or participant string - is correct by construction rather than
    // needing its own case-insensitive check. See `hex.ts`'s `normaliseHex`.
    entry.device = normaliseHex(entry.device)
    entry.participant = normaliseHex(entry.participant)
    if (entry.proof) {
      entry.proof = {
        ...entry.proof,
        issuer: normaliseHex(entry.proof.issuer),
        participant: normaliseHex(entry.proof.participant),
      }
    }

    // The device that signed this event must be the device the credential names.
    if (!hexEquals(entry.device, event.pubkey)) return null

    // A timestamp beyond clock skew is a pin, not a clock - see
    // `MAX_FUTURE_SKEW_SECONDS`. The entry goes; a claim only costs the
    // claim, because a device with one bad claim is still in the room.
    const horizon = opts.now + MAX_FUTURE_SKEW_SECONDS
    if (!Number.isFinite(entry.updatedAt) || entry.updatedAt > horizon) return null
    entry.claims = Object.fromEntries(
      Object.entries(entry.claims ?? {}).filter(
        ([, claimedAt]) => typeof claimedAt === 'number' && Number.isFinite(claimedAt) && claimedAt <= horizon,
      ),
    )

    const verdict = verifyDeviceCredential(entry.credential, {
      roomId: opts.roomId,
      now: opts.now,
    })
    if (!verdict.ok) return null
    if (!hexEquals(verdict.device, event.pubkey)) return null
    if (!hexEquals(verdict.participant, entry.participant)) return null

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
