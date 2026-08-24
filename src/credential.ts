import { finalizeEvent, verifyEvent, verifiedSymbol } from 'nostr-tools/pure'
import { KINDS } from './kinds.js'
import type { DeviceCredential } from './types.js'

export interface CreateCredentialOptions {
  /** The participant's secret key. This never leaves the participant's primary device. */
  participantSk: Uint8Array
  /** The pubkey of the device being authorised. */
  devicePubkey: string
  roomId: string
  /** Unix seconds. */
  expiresAt: number
}

/**
 * Authorise a device to act for a participant in one room, until an expiry.
 *
 * The credential is signed by the participant key but is never published to a
 * relay - it travels inside the room-key-encrypted roster, so relays never
 * learn the participant pubkey.
 */
export function createDeviceCredential(opts: CreateCredentialOptions): DeviceCredential {
  return finalizeEvent(
    {
      kind: KINDS.CREDENTIAL,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', opts.roomId],
        ['device', opts.devicePubkey],
        ['expiration', String(opts.expiresAt)],
      ],
      content: '',
    },
    opts.participantSk,
  )
}

export type VerifyResult =
  | { ok: true; participant: string; device: string }
  | { ok: false; reason: string }

export function verifyDeviceCredential(
  cred: DeviceCredential,
  opts: { roomId: string; now: number },
): VerifyResult {
  if (cred.kind !== KINDS.CREDENTIAL) return { ok: false, reason: 'wrong kind' }

  const room = cred.tags.find((t) => t[0] === 'd')?.[1]
  if (room !== opts.roomId) return { ok: false, reason: 'wrong room' }

  const expiration = cred.tags.find((t) => t[0] === 'expiration')?.[1]
  if (!expiration) return { ok: false, reason: 'no expiration' }
  if (Number(expiration) <= opts.now) return { ok: false, reason: 'expired' }

  const device = cred.tags.find((t) => t[0] === 'device')?.[1]
  if (!device) return { ok: false, reason: 'no device' }

  // Signature last: it is the most expensive check, and tampering with any tag
  // above invalidates it anyway.
  //
  // verifyEvent caches its result on the event object under `verifiedSymbol`.
  // That property is an own enumerable symbol, so a shallow copy (eg. `{ ...cred }`,
  // which is exactly how a caller might rebuild an event after editing a tag)
  // carries the cached flag along with it - verifyEvent would then return the
  // stale result without re-checking anything. Strip it from a copy first so
  // every credential gets a fresh check, never a trusted-by-accident one.
  const unverified = { ...cred }
  delete unverified[verifiedSymbol]
  if (!verifyEvent(unverified)) return { ok: false, reason: 'bad signature' }

  return { ok: true, participant: cred.pubkey, device }
}
