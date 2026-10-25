/** Independent strict reader for the experimental invitation vault purpose.
 * This module never chooses an inviter trust pin or conveys storage authority. */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { Reader, BindingError, bindingDigest, readUnsignedBinding, checkUnsignedBinding } from './binding.js'

export const INVITATION_SIGN_METHOD = 'signInvitationV1/1' as const
const fail = (): never => { throw new BindingError('Malformed') }
export interface InvitationContext {
  invitationId: string; inviterPersona: string; inviterDevice: string; inviterRz: string
  joinerPersona: string; joinerDevice: string; joinerRz: string; groupId: string
  groupHome: string; groupInstallation: string; joinerHome: string
  returnRoute: { type: 'PrivateOob' } | { type: 'LinkMailbox'; node: string }; expiresAt: number
}
export function readInvitationContext(bytes: Uint8Array): InvitationContext {
  if (bytes.length > 1024) fail()
  const r = new Reader(bytes)
  r.map(16); r.key(1); if (r.head(0) !== 1n) fail()
  r.key(2); if (r.text(64) !== 'Vennel/invitation/1') fail()
  r.key(3); if (r.head(0) !== 1n) fail()
  const fields = ['invitationId', 'inviterPersona', 'inviterDevice', 'inviterRz', 'joinerPersona', 'joinerDevice', 'joinerRz', 'groupId', 'groupHome', 'groupInstallation', 'joinerHome'] as const
  const c = {} as InvitationContext
  fields.forEach((field, i) => { r.key(i + 4); c[field] = bytesToHex(r.fixed(32)) })
  r.key(15); const count = r.head(5); r.key(1); const type = r.head(0)
  if (count === 1n && type === 1n) c.returnRoute = { type: 'PrivateOob' }
  else if (count === 2n && type === 2n) { r.key(2); c.returnRoute = { type: 'LinkMailbox', node: bytesToHex(r.fixed(32)) } }
  else fail()
  r.key(16); c.expiresAt = r.timestamp(); if (c.expiresAt === 0) fail(); r.finish()
  return c
}
export function invitationDigest(body: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes('Vennel invitation/1 authorization\0'), body))
}
export function invitationContextCommitment(bytes: Uint8Array): Uint8Array {
  readInvitationContext(bytes)
  return sha256(concatBytes(utf8ToBytes('Vennel invitation/1 context\0'), bytes))
}
/** Verify the embedded signed original leaf binding, not a replacement credential. */
export function readInvitationSignBody(body: Uint8Array, now: number, persona: string, revoked: ReadonlySet<string> = new Set()) {
  if (body.length > 12288) fail()
  const r = new Reader(body)
  r.map(3); r.key(1); if (r.head(0) !== 1n) fail()
  r.key(2); const contextBytes = r.take(r.bounded(2, 1024)).slice()
  const context = readInvitationContext(contextBytes)
  r.key(3); const signed = r.take(r.bounded(2, 8192)); r.finish()
  if (signed.length < 68 || signed[0] !== 0xa8 || signed[signed.length - 67] !== 8 || signed[signed.length - 66] !== 0x58 || signed[signed.length - 65] !== 0x40) fail()
  const unsigned = signed.slice(0, -67); unsigned[0] = 0xa7
  const binding = readUnsignedBinding(unsigned)
  const credential = checkUnsignedBinding(binding, now, persona, revoked)
  if (!schnorr.verify(signed.subarray(-64), bindingDigest(unsigned), binding.device)) fail()
  if (context.inviterPersona !== persona || context.inviterDevice !== bytesToHex(binding.device) || context.groupHome !== bytesToHex(binding.homeBox) || context.expiresAt <= now || context.expiresAt > binding.expiresAt) fail()
  return { context, contextBytes, binding, credential }
}
