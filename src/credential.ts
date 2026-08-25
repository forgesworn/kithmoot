import { KINDS } from './kinds.js'
import { verifyEventUncached } from './verify.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { ParticipantIdentity, UnsignedEvent } from './identity.js'
import type { DeviceCredential } from './types.js'

export interface CreateCredentialOptions {
  /**
   * The participant. A locally held key (`localIdentity`) or an external
   * signer - see `ParticipantIdentity`. Either way the secret itself never
   * reaches this function.
   */
  identity: ParticipantIdentity
  /** The pubkey of the device being authorised. */
  devicePubkey: string
  roomId: string
  /** Unix seconds. */
  expiresAt: number
  /** Injectable clock, in unix seconds. Defaults to the real one. */
  now?: () => number
}

/**
 * Authorise a device to act for a participant in one room, until an expiry.
 *
 * The credential is signed by the participant key but is never published to a
 * relay - it travels inside the room-key-encrypted roster, so relays never
 * learn the participant pubkey.
 *
 * Asynchronous because the signer may not be here: an extension has to
 * prompt, a bunker has to be reached over a relay, a phone has to be
 * unlocked. See `ParticipantIdentity`.
 */
export async function createDeviceCredential(opts: CreateCredentialOptions): Promise<DeviceCredential> {
  const unsigned: UnsignedEvent = {
    kind: KINDS.CREDENTIAL,
    created_at: (opts.now ?? (() => Math.floor(Date.now() / 1000)))(),
    tags: [
      ['d', opts.roomId],
      ['device', opts.devicePubkey],
      ['expiration', String(opts.expiresAt)],
    ],
    content: '',
  }

  const signed = await opts.identity.signEvent(unsigned)

  // A signer is not part of this codebase: it is a browser extension, a
  // bunker on somebody else's machine, or an app on a phone. It is trusted
  // to hold the key, not to be correct - and a credential is the one thing
  // in this protocol that says who a device speaks for. So what comes back
  // is checked against what was asked for, rather than returned on faith.
  //
  // `created_at` is deliberately NOT compared: some signers stamp their own,
  // it is inside the signature either way, and nothing here decides anything
  // on it - the `expiration` tag is what bounds the credential, and that IS
  // compared.
  if (!hexEquals(signed.pubkey, opts.identity.pubkey)) {
    throw new Error('the signer returned a credential signed by a different key')
  }
  if (signed.kind !== unsigned.kind || signed.content !== unsigned.content) {
    throw new Error('the signer returned a credential for something else')
  }
  if (JSON.stringify(signed.tags) !== JSON.stringify(unsigned.tags)) {
    throw new Error('the signer returned a credential on different terms than it was asked for')
  }
  if (!verifyEventUncached(signed)) {
    throw new Error('the signer returned a credential that does not verify')
  }

  return signed
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
  if (room === undefined || !hexEquals(room, opts.roomId)) return { ok: false, reason: 'wrong room' }

  const expiration = cred.tags.find((t) => t[0] === 'expiration')?.[1]
  // A missing tag and a present-but-non-numeric one are the same failure:
  // there is no usable expiry to check against. Folding them into one
  // `Number.isFinite` guard matters because `Number(expiration)` on
  // anything non-numeric is NaN, and every comparison with NaN - including
  // `NaN <= now` - is false, so the naive check below would treat a
  // corrupted tag as never expiring: a fail-open default in a security
  // check, even though the tag sits inside the signed content today and so
  // is not exploitable while the signature check below still runs.
  const expiresAt = expiration === undefined ? NaN : Number(expiration)
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'no expiration' }
  if (expiresAt <= opts.now) return { ok: false, reason: 'expired' }

  const device = cred.tags.find((t) => t[0] === 'device')?.[1]
  if (!device) return { ok: false, reason: 'no device' }

  // Signature last: it is the most expensive check, and tampering with any tag
  // above invalidates it anyway. Via `verifyEventUncached` so a credential
  // that arrives carrying a cached verdict still gets a real check - see
  // `verify.ts` for why that matters.
  if (!verifyEventUncached(cred)) return { ok: false, reason: 'bad signature' }

  // A credential is one of the places a device/participant pubkey enters
  // the system - the `device` tag in particular is free text set by
  // whoever minted the credential. Canonicalise both here so every caller
  // (roster decode, secondary-device adoption) compares against something
  // already lower-case, rather than each having to know to.
  return { ok: true, participant: normaliseHex(cred.pubkey), device: normaliseHex(device) }
}
