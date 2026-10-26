import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { invitationContextCommitment, invitationDigest, readInvitationContext, readInvitationSignBody } from './invitation.js'
import { bindingDigest } from './binding.js'
const reference = JSON.parse(readFileSync(new URL('../../vectors/vmls/invitation-profile-reference.json', import.meta.url), 'utf8'))
const bindings = JSON.parse(readFileSync(new URL('../../vectors/vmls/vmls-binding-v1.json', import.meta.url), 'utf8'))
// Manual test-only canonical CBOR, independent of the Rust encoder.
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of(major * 32 + n)
  const width = n <= 255 ? 1 : n <= 65535 ? 2 : 4
  const out = new Uint8Array(width + 1); out[0] = major * 32 + (width === 1 ? 24 : width === 2 ? 25 : 26)
  for (let i = 0; i < width; i++) out[width - i] = (n / 2 ** (8 * i)) & 255
  return out
}
function encode(v: any): Uint8Array {
  if (v instanceof Uint8Array) return concatBytes(head(2, v.length), v)
  if (typeof v === 'number') return head(0, v)
  if (typeof v === 'string') { const b = new TextEncoder().encode(v); return concatBytes(head(3, b.length), b) }
  return concatBytes(head(5, v.length), ...v.flatMap(([k, val]: any) => [encode(k), encode(val)]))
}
function sample() {
  const valid = bindings.cases.find((c: any) => c.name === 'valid'), c = reference.vectors[0].context
  const fields = ['invitation_id', 'inviter_persona', 'inviter_device', 'inviter_rz', 'joiner_persona', 'joiner_device', 'joiner_rz', 'group_id', 'group_home', 'group_installation', 'joiner_home']
  const context = encode([[1, 1], [2, 'Vennel/invitation/1'], [3, 1], ...fields.map((key, i) => [i + 4, hexToBytes(key === 'inviter_persona' ? valid.expect.identityHex : key === 'inviter_device' ? valid.expect.deviceHex : key === 'group_home' ? valid.expect.homeBoxHex : c[key])]), [15, [[1, 1]]], [16, bindings.now + 600]])
  const binding = hexToBytes(valid.bindingHex)
  return { valid, context, binding, body: encode([[1, 1], [2, context], [3, binding]]) }
}
describe('independent experimental invitation vault reader', () => {
  it('agrees with independent manual Python CBOR/hash context vectors', () => {
    for (const v of reference.vectors) {
      const bytes = hexToBytes(v.context_hex), parsed = readInvitationContext(bytes)
      expect(parsed.inviterPersona).toBe(v.context.inviter_persona)
      expect(parsed.joinerHome).toBe(v.context.joiner_home)
      expect(parsed.groupHome).toBe(v.context.group_home)
      expect(bytesToHex(invitationContextCommitment(bytes))).toBe(v.commitment)
    }
  })
  it('authenticates the original signed leaf and person credential under its own domain', () => {
    const s = sample(), parsed = readInvitationSignBody(s.body, bindings.now, s.valid.expect.identityHex)
    expect(parsed.credential.id).toBe(s.valid.expect.credentialIdHex)
    expect(bytesToHex(invitationDigest(s.body))).not.toBe(bytesToHex(bindingDigest(s.body)))
    expect(parsed.context.returnRoute).toEqual({ type: 'PrivateOob' })
  })
  it('refuses substituted persona, revoked original credential and expired context', () => {
    const s = sample()
    expect(() => readInvitationSignBody(s.body, bindings.now, '00'.repeat(32))).toThrow()
    expect(() => readInvitationSignBody(s.body, bindings.now, s.valid.expect.identityHex, new Set([s.valid.expect.credentialIdHex]))).toThrow()
    expect(() => readInvitationSignBody(s.body, bindings.now + 600, s.valid.expect.identityHex)).toThrow()
  })
  it('refuses tampered leaf signature, trailing bytes, missing/reordered/noncanonical keys', () => {
    const s = sample(), tampered = s.binding.slice(); tampered[tampered.length - 1] ^= 1
    for (const body of [encode([[1, 1], [2, s.context], [3, tampered]]), concatBytes(s.body, Uint8Array.of(0)), encode([[2, s.context], [1, 1], [3, s.binding]])]) expect(() => readInvitationSignBody(body, bindings.now, s.valid.expect.identityHex)).toThrow()
    const bytes = hexToBytes(reference.vectors[0].context_hex)
    for (const changed of [bytes.slice(0, -1), concatBytes(bytes, Uint8Array.of(0)), concatBytes(Uint8Array.of(0xb8, 16), bytes.slice(1)), concatBytes(bytes.slice(0, 1), Uint8Array.of(2), bytes.slice(2))]) expect(() => readInvitationContext(changed)).toThrow()
  })
})
