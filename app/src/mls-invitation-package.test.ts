import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { invitationRegistrationRequest, readInvitationRegistrationRequest, verifyInvitationRegistrationReceipt } from './mls-invitation-package.js'
const vector = JSON.parse(readFileSync(new URL('../../vectors/vmls/package-registration-receipt.json', import.meta.url), 'utf8'))
const expected = { node: vector.node, installation: vector.installation, packageId: vector.package, welcomeMailbox: vector.mailbox, expiresAt: vector.expiry }
const now = vector.expiry - 3600
describe('private keeper registration receipt', () => {
  it('verifies the independent Python Ed25519/hashlib reference and exact 137-byte request', () => {
    const receipt = hexToBytes(vector.receiptHex), request = invitationRegistrationRequest(expected)
    expect(request).toHaveLength(137); expect(receipt).toHaveLength(201)
    expect(request).toEqual(receipt.slice(0, 137))
    expect(readInvitationRegistrationRequest(request, now)).toEqual(expected)
    expect(verifyInvitationRegistrationReceipt(receipt, expected, now)).toEqual(expected)
  })
  it('refuses every substituted node, installation, package, mailbox, expiry or signature', () => {
    for (const offset of [0, 1, 33, 65, 97, 129, 136, 137, 200]) {
      const receipt = hexToBytes(vector.receiptHex); receipt[offset] ^= 1
      expect(() => verifyInvitationRegistrationReceipt(receipt, expected, now), `byte ${offset}`).toThrow()
    }
    for (const key of ['node', 'installation', 'packageId', 'welcomeMailbox'] as const) expect(() => verifyInvitationRegistrationReceipt(hexToBytes(vector.receiptHex), { ...expected, [key]: '11'.repeat(32) }, now)).toThrow()
    expect(() => verifyInvitationRegistrationReceipt(hexToBytes(vector.receiptHex), { ...expected, expiresAt: expected.expiresAt + 1 }, now)).toThrow()
  })
  it('requires exact bounded request/receipt bytes and a still-current expiry', () => {
    const receipt = hexToBytes(vector.receiptHex), request = receipt.slice(0, 137)
    for (const input of [receipt.slice(0, -1), concatBytes(receipt, Uint8Array.of(0)), request]) expect(() => verifyInvitationRegistrationReceipt(input, expected, now)).toThrow()
    for (const input of [request.slice(0, -1), concatBytes(request, Uint8Array.of(0))]) expect(() => readInvitationRegistrationRequest(input, now)).toThrow()
    expect(() => verifyInvitationRegistrationReceipt(receipt, expected, expected.expiresAt)).toThrow()
    expect(() => readInvitationRegistrationRequest(request, expected.expiresAt - 7 * 86400 - 1)).toThrow()
  })
})
