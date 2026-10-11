// G16 sizing/crypto experiment only; no resolver or application route is shipped.
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const origin = 'https://z1p.app'
const expires = 1_800_003_600
const encode = bytes => Buffer.from(bytes).toString('base64url')
const decode = text => Buffer.from(text, 'base64url')
const aad = (id, end) => Buffer.from(`kithmoot-short-invite/v1:${id}:${end}`)

function seal(url) {
  const id = encode(randomBytes(16))
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(id, expires))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ v: 1, url })), cipher.final(), cipher.getAuthTag()])
  return { id, key, link: `${origin}/k/${id}#${encode(key)}`, envelope: { v: 1, expires, nonce: encode(nonce), ciphertext: encode(ciphertext) } }
}

function open(id, key, envelope, now = expires - 1) {
  assert.equal(envelope.v, 1)
  assert.ok(now < envelope.expires, 'expired envelope')
  const encrypted = decode(envelope.ciphertext)
  const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.nonce))
  decipher.setAAD(aad(id, envelope.expires))
  decipher.setAuthTag(encrypted.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString()).url
}

// Serialisation of these already-valid synthetic values follows the pinned
// fold-kit encoder cited in the report. This is not a second room-link parser.
const invitation = { v: 2, j: encode(Buffer.alloc(32, 5)), h: 'ab'.repeat(32), r: [], i: [] }
const fixtures = [
  ['minimal invitation', invitation],
  ['named room with two relays and STUN', { ...invitation, r: ['wss://a.example', 'wss://b.example'], i: ['stun:stun.example:3478'], n: 'Workshop' }],
  ['persistent project room', { ...invitation, v: 3, r: ['wss://a.example', 'wss://b.example'], i: ['stun:stun.example:3478'], n: 'Build room', a: { tier: 'kith', admitted: ['cd'.repeat(32)] } }],
]
const rows = []
for (const [fixture, payload] of fixtures) {
  const full = `https://kithmoot.app/j/#${encode(JSON.stringify(payload))}`
  const sealed = seal(full)
  assert.equal(open(sealed.id, sealed.key, sealed.envelope), full)
  assert.equal(new URL(sealed.link).pathname, `/k/${sealed.id}`)
  assert.equal(new URL(sealed.link).hash, `#${encode(sealed.key)}`)
  assert.equal(sealed.id.length, 22)
  assert.equal(encode(sealed.key).length, 43)
  const stored = JSON.stringify(sealed.envelope)
  assert.ok(!stored.includes(full) && !stored.includes(payload.j) && !stored.includes(payload.h))
  assert.throws(() => open(sealed.id, randomBytes(32), sealed.envelope))
  assert.throws(() => open(encode(randomBytes(16)), sealed.key, sealed.envelope))
  assert.throws(() => open(sealed.id, sealed.key, { ...sealed.envelope, expires: expires + 1 }))
  const changed = decode(sealed.envelope.ciphertext)
  changed[0] ^= 1
  assert.throws(() => open(sealed.id, sealed.key, { ...sealed.envelope, ciphertext: encode(changed) }))
  assert.throws(() => open(sealed.id, sealed.key, sealed.envelope, expires))
  rows.push({ fixture, fullCharacters: full.length, proposedCharacters: sealed.link.length,
    reductionPercent: Math.round((1 - sealed.link.length / full.length) * 100), storedBytes: Buffer.byteLength(stored) })
  sealed.key.fill(0)
}
console.log(JSON.stringify({ experiment: 'G16 synthetic sizing and authenticated envelope',
  publiclyShipped: false, resolverImplemented: false, nativeParity: false,
  pinnedFoldKitRevision: 'dc51766b7e6a141d5ba8aa0e5421df86432a7412',
  lookupEntropyBits: 128, fragmentKeyBits: 256,
  authenticatedEnvelopeChecks: ['exact full-link recovery', 'wrong key rejected', 'different lookup ID rejected',
    'altered expiry rejected', 'altered ciphertext rejected', 'expired envelope rejected'], rows }, null, 2))
