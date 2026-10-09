import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { pairedWitnessIdentity, personaWriter } from './mls-writer-identity.js'
import { pairingFixture } from '../../test/mls-pairing-fixture.js'

describe('sealed persona identity checks', () => {
  it('uses the raw Link transport seed as an Ed25519 identity', () => {
    const seed = new Uint8Array(32).fill(7)
    expect(personaWriter(bytesToHex(seed))).toBe(bytesToHex(ed25519.getPublicKey(seed)))
    expect(seed[0]).toBe(7)
  })
  it('authenticates the paired card at its saved verification time', () => {
    const f = pairingFixture()
    expect(pairedWitnessIdentity(f.route)).toBe(f.witness)
    expect(() => pairedWitnessIdentity({ ...f.route, cardSerial: '2' })).toThrow('could not be verified')
    expect(() => pairedWitnessIdentity({ ...f.route, cardVerifiedAt: '0' })).toThrow('could not be verified')
    expect(() => pairedWitnessIdentity({ ...f.route, cardVerifiedAt: String(BigInt(f.route.cardVerifiedAt) + 7200n) })).toThrow('could not be verified')
    expect(() => pairedWitnessIdentity({ ...f.route, cardVerifiedAt: '-1' })).toThrow('could not be verified')
  })
  it.each([0, 4, 5, 37, 45, 53, 61, 63, 66, -1])('rejects a stored card changed at byte %i', offset => {
    const f = pairingFixture(), bytes = hexToBytes(f.route.card)
    bytes[offset < 0 ? bytes.length - 1 : offset] ^= 1
    expect(() => pairedWitnessIdentity({ ...f.route, card: bytesToHex(bytes) })).toThrow('could not be verified')
  })
  it.each([0, 125, 4097])('rejects a card of %i bytes before reading or verifying it', length => {
    const f = pairingFixture()
    expect(() => pairedWitnessIdentity({ ...f.route, card: '00'.repeat(length) })).toThrow('could not be verified')
  })
})
