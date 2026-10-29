/**
 * The Spry signing key a device uses in one room, kept apart from the HTTP
 * client in `spry.ts` so the session can announce it without importing that.
 *
 * Web device keys are per room, so this key is per room per device. Members
 * learn nothing new from its public half: it is a one-way derivation of a
 * key whose public half they already see.
 */
import { getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const encoder = new TextEncoder()

/** The secret Spry key, 64 hex, for a room device key. */
export const spryDeviceKey = (key: Uint8Array): string => bytesToHex(hmac(sha256, key, encoder.encode('spry-device-v1')))

/** Its x-only public key, 64 lowercase hex: what a roster entry announces as `spryKey`. */
export function spryDevicePublicKey(deviceSk: Uint8Array): string {
  return getPublicKey(hexToBytes(spryDeviceKey(deviceSk)))
}

/** A roster `spryKey` claim: 64 hex that is an x-only point on the curve,
 *  lower-cased, or undefined. The node refuses a whole registration that
 *  names an invalid point, so one is dropped here, at the boundary. */
export function sanitiseSpryKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) return undefined
  const key = value.toLowerCase()
  try { schnorr.utils.lift_x(BigInt('0x' + key)) } catch { return undefined }
  return key
}
