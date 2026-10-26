import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { adminInvitationContextCommitment, adminInvitationDigest, readAdminInvitationContext, readAdminInvitationSignBody } from './admin-invitation.js'
import { bindingDigest } from './binding.js'
const reference = JSON.parse(readFileSync(new URL('../../vectors/vmls/admin-invitation-reference.json', import.meta.url), 'utf8'))
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
  const valid = bindings.cases.find((c: any) => c.name === 'valid')
  const fields = ['invitation_id', 'inviter_persona', 'inviter_device', 'inviter_rz', 'joiner_persona', 'joiner_device', 'joiner_rz', 'group_id', 'group_home', 'group_installation', 'joiner_home']
  const context = encode([[1, 2], [2, 'Vennel/invitation-admins/2'], [3, 1], ...fields.map((key, i) => [i + 4, hexToBytes(key === 'inviter_persona' ? valid.expect.identityHex : key === 'inviter_device' ? valid.expect.deviceHex : key === 'group_home' ? valid.expect.homeBoxHex : '11'.repeat(32))]), [15, [[1, 1]]], [16, bindings.now + 600], [17, hexToBytes(reference.policy_commitment)]])
  const binding = hexToBytes(valid.bindingHex)
  return { valid, context, binding, body: encode([[1, 1], [2, context], [3, binding]]) }
}
describe('independent experimental invitation vault reader', () => {
  it('agrees with independent manual Python CBOR/hash context vectors', () => {
    for (const v of reference.vectors.filter((v: any) => v.profile === 'Vennel/invitation-admins/2')) {
      const bytes = hexToBytes(v.context_hex), parsed = readAdminInvitationContext(bytes)
      expect(parsed.inviterPersona).toBe('11'.repeat(32))
      expect(parsed.adminSetCommitment).toBe(v.context_hex.slice(-64))
      expect(parsed.joinerHome).toBe('1a'.repeat(32))
      expect(parsed.groupHome).toBe('18'.repeat(32))
      expect(bytesToHex(adminInvitationContextCommitment(bytes))).toBe(v.commitment)
    }
  })
  it('authenticates the original signed leaf and person credential under its own domain', () => {
    const s = sample(), parsed = readAdminInvitationSignBody(s.body, bindings.now, s.valid.expect.identityHex)
    expect(parsed.credential.id).toBe(s.valid.expect.credentialIdHex)
    expect(bytesToHex(adminInvitationDigest(s.body))).not.toBe(bytesToHex(bindingDigest(s.body)))
    expect(parsed.context.returnRoute).toEqual({ type: 'PrivateOob' })
  })
  it('refuses substituted persona, revoked original credential and expired context', () => {
    const s = sample()
    expect(() => readAdminInvitationSignBody(s.body, bindings.now, '00'.repeat(32))).toThrow()
    expect(() => readAdminInvitationSignBody(s.body, bindings.now, s.valid.expect.identityHex, new Set([s.valid.expect.credentialIdHex]))).toThrow()
    expect(() => readAdminInvitationSignBody(s.body, bindings.now + 600, s.valid.expect.identityHex)).toThrow()
  })
  it('refuses tampered leaf signature, trailing bytes, missing/reordered/noncanonical keys', () => {
    const s = sample(), tampered = s.binding.slice(); tampered[tampered.length - 1] ^= 1
    for (const body of [encode([[1, 1], [2, s.context], [3, tampered]]), concatBytes(s.body, Uint8Array.of(0)), encode([[2, s.context], [1, 1], [3, s.binding]])]) expect(() => readAdminInvitationSignBody(body, bindings.now, s.valid.expect.identityHex)).toThrow()
    const bytes = hexToBytes(reference.vectors[0].context_hex)
    for (const changed of [bytes.slice(0, -1), concatBytes(bytes, Uint8Array.of(0)), concatBytes(Uint8Array.of(0xb8, 17), bytes.slice(1)), concatBytes(bytes.slice(0, 1), Uint8Array.of(2), bytes.slice(2))]) expect(() => readAdminInvitationContext(changed)).toThrow()
  })
})

it('rejects legacy contexts and is rejected by the unchanged legacy reader', async () => {
  const legacy = await import('./invitation.js')
  const old = JSON.parse(readFileSync(new URL('../../vectors/vmls/invitation-profile-reference.json', import.meta.url), 'utf8'))
  expect(() => readAdminInvitationContext(hexToBytes(old.vectors[0].context_hex))).toThrow()
  expect(() => legacy.readInvitationContext(hexToBytes(reference.vectors[0].context_hex))).toThrow()
  const s = sample()
  expect(bytesToHex(adminInvitationDigest(s.body))).not.toBe(bytesToHex(legacy.invitationDigest(s.body)))
  const changed = s.context.slice(); changed[changed.length - 1] ^= 1
  expect(bytesToHex(adminInvitationContextCommitment(changed))).not.toBe(bytesToHex(adminInvitationContextCommitment(s.context)))
})
