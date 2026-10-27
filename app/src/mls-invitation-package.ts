import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
export interface InvitationPackageRegistration { node: string; installation: string; packageId: string; welcomeMailbox: string; expiresAt: number }
const hex = (v: string) => /^[0-9a-f]{64}$/.test(v)
const DOMAIN = new TextEncoder().encode('Vennel/invitation/1 package registration\0')
export function invitationRegistrationRequest(value: InvitationPackageRegistration): Uint8Array {
  if (![value.node, value.installation, value.packageId, value.welcomeMailbox].every(hex) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error('Invalid private package registration request.')
  const out = new Uint8Array(137); out[0] = 1
  for (const [i, field] of [value.node, value.installation, value.packageId, value.welcomeMailbox].entries()) out.set(hexToBytes(field), 1 + i * 32)
  new DataView(out.buffer).setBigUint64(129, BigInt(value.expiresAt))
  return out
}
export function readInvitationRegistrationRequest(bytes: Uint8Array, now: number): InvitationPackageRegistration {
  if (bytes.length !== 137 || bytes[0] !== 1 || !Number.isSafeInteger(now) || now < 0) throw new Error('Malformed private package registration request.')
  const expires = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(129)
  if (expires > BigInt(Number.MAX_SAFE_INTEGER) || expires <= BigInt(now) || expires > BigInt(now + 7 * 86400)) throw new Error('The package registration request expired or exceeds seven days.')
  return { node: bytesToHex(bytes.subarray(1, 33)), installation: bytesToHex(bytes.subarray(33, 65)), packageId: bytesToHex(bytes.subarray(65, 97)),
    welcomeMailbox: bytesToHex(bytes.subarray(97, 129)), expiresAt: Number(expires) }
}
/** Observed node registration only. No membership, grant or retention claim. */
export function verifyInvitationRegistrationReceipt(receipt: Uint8Array, expected: InvitationPackageRegistration, now: number): InvitationPackageRegistration {
  if (receipt.length !== 201) throw new Error('The experimental node must return its signed registration receipt.')
  const parsed = readInvitationRegistrationRequest(receipt.subarray(0, 137), now), request = invitationRegistrationRequest(expected)
  try {
    if (!request.every((v, i) => receipt[i] === v) || !ed25519.verify(receipt.subarray(137), sha256(concatBytes(DOMAIN, receipt.subarray(0, 137))), hexToBytes(expected.node), { zip215: false })) throw new Error('The node registration receipt signature or exact package context differs.')
    return parsed
  } finally { request.fill(0) }
}
