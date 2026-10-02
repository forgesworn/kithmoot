import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential } from '../credential.js'
import {
  BindingError, bindingDigest, checkUnsignedBinding, MAX_UNSIGNED_BODY_BYTES, readUnsignedBinding,
  verifyPersonCredential, type BindingErrorCode,
} from './binding.js'
import { encodeUnsignedBinding } from '../../test/vmls-encode.js'

interface Case { name: string; bindingHex: string; expectedIdentityHex?: string; revoked?: boolean; expect: { ok: boolean; error?: string } }
const suite = JSON.parse(readFileSync(new URL('../../vectors/vmls/vmls-binding-v1.json', import.meta.url), 'utf8')) as {
  now: number; revokedCredentialIds: string[]; cases: Case[]
}
const revoked = new Set(suite.revokedCredentialIds)

function code(fn: () => unknown): string {
  try { fn(); return 'ok' } catch (error) {
    if (error instanceof BindingError) return error.code
    throw error
  }
}

// The vectors are signed eight-key bindings. The unsigned body is the same
// map with header 0xa7 and without its last field, key 8 (`08 58 40` and a
// 64-byte signature). Cases that malform that framing are covered below.
const SIGNATURE_FIELD = '085840'
const framed = suite.cases.filter(c => c.bindingHex.length > 134 && c.bindingHex.slice(-134, -128) === SIGNATURE_FIELD && c.bindingHex.startsWith('a8'))
const unsignedOf = (hex: string): Uint8Array => hexToBytes('a7' + hex.slice(2, -134))
// What a signer, which sees neither the carrying leaf nor the signature,
// should say for each vector outcome.
const signerSees = (c: Case): string => {
  if (c.expect.ok) return 'ok'
  if (c.expect.error === 'BindingLeafMismatch' || c.expect.error === 'BindingSignatureInvalid') return 'ok'
  return c.expect.error!
}

describe('VMLS/1 unsigned leaf-binding reader', () => {
  it('derives every framed vector body exactly: valid signatures verify over its digest', () => {
    const valid = framed.filter(c => c.expect.ok)
    expect(valid.length).toBeGreaterThanOrEqual(4)
    for (const c of valid) {
      const body = unsignedOf(c.bindingHex)
      const binding = readUnsignedBinding(body)
      const signature = hexToBytes(c.bindingHex.slice(-128))
      expect(schnorr.verify(signature, bindingDigest(body), binding.device), c.name).toBe(true)
    }
  })

  for (const c of framed) {
    it(`agrees with the Rust and JS readers: ${c.name}`, () => {
      const body = unsignedOf(c.bindingHex)
      // A signer always knows the selected person; a case without one
      // expects whoever signed the credential.
      const actual = code(() => {
        const binding = readUnsignedBinding(body)
        checkUnsignedBinding(binding, suite.now, c.expectedIdentityHex ?? binding.event.pubkey, c.revoked ? revoked : new Set())
      })
      expect(actual).toBe(signerSees(c))
    })
  }

  it('covers most of the suite through the framed cases', () => {
    expect(framed.length).toBeGreaterThanOrEqual(suite.cases.length - 6)
  })

  it('refuses a signed eight-key binding, a trailing byte, truncation, an indefinite map and oversize', () => {
    const valid = suite.cases.find(c => c.name === 'valid')!
    const body = unsignedOf(valid.bindingHex)
    expect(code(() => readUnsignedBinding(hexToBytes(valid.bindingHex)))).toBe('NonCanonical')
    expect(code(() => readUnsignedBinding(Uint8Array.from([...body, 0])))).toBe('NonCanonical')
    expect(code(() => readUnsignedBinding(body.subarray(0, body.length - 1)))).toBe('Malformed')
    expect(code(() => readUnsignedBinding(Uint8Array.from([0xbf, ...body.subarray(1)])))).toBe('NonCanonical')
    expect(code(() => readUnsignedBinding(new Uint8Array(MAX_UNSIGNED_BODY_BYTES + 1)))).toBe('TooLarge')
    expect(code(() => readUnsignedBinding(new Uint8Array()))).toBe('Malformed')
  })

  it('round-trips the test encoder', () => {
    const valid = suite.cases.find(c => c.name === 'valid')!
    const body = unsignedOf(valid.bindingHex)
    const b = readUnsignedBinding(body)
    const again = encodeUnsignedBinding({
      leafId: b.leafId, signatureKey: b.signatureKey, credential: b.event,
      device: bytesToHex(b.device), expiresAt: b.expiresAt, homeBox: b.homeBox,
    })
    expect(bytesToHex(again)).toBe(bytesToHex(body))
  })
})


describe('a fold-kit person credential meets the engine rules', () => {
  const secret = generateSecretKey()
  const identity = { pubkey: getPublicKey(secret), signEvent: async (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, secret) }
  const device = getPublicKey(generateSecretKey())
  const now = Math.floor(Date.now() / 1000)

  it('accepts the person form', async () => {
    const event = await createDeviceCredential({ identity, devicePubkey: device, expiresAt: now + 7 * 86_400, scope: 'person', now: () => now })
    expect(verifyPersonCredential(event, now, identity.pubkey)).toMatchObject({ identity: identity.pubkey, device })
  })

  it('refuses the room form (S18)', async () => {
    const event = await createDeviceCredential({ identity, devicePubkey: device, expiresAt: now + 3600, roomId: 'a'.repeat(64), now: () => now })
    expect(code(() => verifyPersonCredential(event, now, identity.pubkey))).toBe<BindingErrorCode>('CredentialNotPersonScoped')
  })
})
