// Public synthetic conformance data only. The delivery receipt codec is NOT
// imported: every derivation, digest, signature and event below is assembled
// by hand from the wire contract in docs/protocol.md ("Delivery receipts"), so
// the vectors check the codec rather than echo it. Deterministic: fixed keys,
// fixed BIP-340 auxiliary randomness and fixed NIP-44 nonces.
import { writeFileSync } from 'node:fs'
import { getPublicKey, getEventHash } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { createDeviceCredential, deriveChannel, localIdentity } from '@forgesworn/fold-kit'

const enc = (s) => new TextEncoder().encode(s)
const now = 1_800_000_000
const TTL = 604_800
const roomId = 'a1'.repeat(32)
const roomKey = new Uint8Array(32).fill(17)
const epoch = { id: 'c1'.repeat(32), key: new Uint8Array(32).fill(34) }
const participantSk = new Uint8Array(32).fill(1)
const deviceSk = new Uint8Array(32).fill(2)
const hostSk = new Uint8Array(32).fill(9)
const strangerSk = new Uint8Array(32).fill(10)
const participant = getPublicKey(participantSk)
const device = getPublicKey(deviceSk)
const auxiliary = new Uint8Array(32)

function signEvent(event, key) {
  const id = getEventHash(event)
  return { ...event, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), key, auxiliary)) }
}
async function credentialFor(sk, room, expiresAt) {
  const minted = await createDeviceCredential({ identity: localIdentity(participantSk),
    devicePubkey: getPublicKey(sk), roomId: room, expiresAt, now: () => now - 60 })
  // Re-signed with fixed auxiliary randomness so the file is reproducible.
  return signEvent({ kind: minted.kind, created_at: minted.created_at, pubkey: minted.pubkey,
    tags: minted.tags, content: minted.content }, participantSk)
}
const credential = await credentialFor(deviceSk, roomId, now + 3600)
const otherRoomCredential = await credentialFor(deviceSk, 'b2'.repeat(32), now + 3600)
const expiredCredential = await credentialFor(deviceSk, roomId, now)
const strangerCredential = await credentialFor(strangerSk, roomId, now + 3600)

const proofNonce = 'd4'.repeat(32)
const proofExpires = now + 3600
const proof = { tier: 'kith', participant, issuer: getPublicKey(hostSk), room: roomId, nonce: proofNonce,
  sig: bytesToHex(schnorr.sign(sha256(enc(`kithmoot/v1/kindred:kith:${participant}:${roomId}:${proofNonce}:${proofExpires}`)), hostSk, auxiliary)),
  expiresAt: proofExpires }
const policy = { tier: 'kith', admitted: [getPublicKey(hostSk)] }

const receiptKey = (streamKey) => hkdf(sha256, streamKey, undefined, enc('kithmoot/v1/delivery-receipt-key'), 32)
const outerKey = (d, createdAt, n) => hkdf(sha256, deviceSk, undefined, enc(`kithmoot/v1/delivery-receipt-outer:${d}:${createdAt}:${n}`), 32)
const idHash = (id) => bytesToHex(sha256(enc(`kithmoot/v1/delivery-receipt-id:${id}`))).slice(0, 16)
const digestOf = (d, outer, createdAt, body) => sha256(enc(`kithmoot/v1/delivery-receipt:${roomId}:${d}:${outer}:${createdAt}:${body}`))

const root = deriveChannel(roomId, roomKey)
const general = deriveChannel(roomId, roomKey, 'general')
const later = deriveChannel(epoch.id, epoch.key)
const streams = [root, general, later].map((s) => ({ d: s.id, key: bytesToHex(s.key) }))

const id32 = '0123456789abcdef0123456789abcdef'
const id128 = 'm'.repeat(128)
let nonceSeed = 60

/** Build one receipt from its parts, so a refusal can change exactly one. */
function build({ stream = root, createdAt = now, n = 0, bodyFields = {}, bodyText, tags, signer = deviceSk,
  envelope, kind = 1465, outerOverride, digestD, sealKey } = {}) {
  const d = stream.id
  const outerSk = outerOverride ?? outerKey(d, createdAt, n)
  const outer = getPublicKey(outerSk)
  // The canonical key order: v, room, participant, device, credential,
  // proof, agent, got; anything unknown after.
  const defaults = { v: 1, room: roomId, participant, device, credential, proof: undefined, agent: undefined, got: [idHash(id32), idHash(id128)] }
  const fields = {}
  for (const key of Object.keys(defaults)) fields[key] = key in bodyFields ? bodyFields[key] : defaults[key]
  for (const key of Object.keys(bodyFields)) if (!(key in defaults)) fields[key] = bodyFields[key]
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key]
  const body = bodyText ?? JSON.stringify(fields)
  const digest = digestOf(digestD ?? d, outer, createdAt, body)
  const sig = bytesToHex(schnorr.sign(digest, signer, auxiliary))
  const plaintext = JSON.stringify(envelope ? envelope(body, sig) : { v: 1, body, sig })
  const key = sealKey ?? receiptKey(stream.key)
  const content = nip44.v2.encrypt(plaintext, key, new Uint8Array(32).fill(nonceSeed++ % 256))
  const event = signEvent({ kind, created_at: createdAt, pubkey: outer,
    tags: tags ?? [['d', d], ['expiration', String(createdAt + TTL)]], content }, outerSk)
  return { event, body, digest: bytesToHex(digest), signature: sig, outerSecretKey: bytesToHex(outerSk), receiptKey: bytesToHex(key) }
}

const decodeBase = { roomId, streams, now }
const valid = []
function accept(name, parts, expected, decode = {}) {
  const built = build(parts)
  valid.push({ name, decode: { ...decodeBase, ...decode }, ...built,
    expected: { d: (parts.stream ?? root).id, createdAt: parts.createdAt ?? now, participant, device,
      agent: false, got: [idHash(id32), idHash(id128)], ...expected } })
}
accept('root-stream', {}, {})
accept('named-channel', { stream: general }, { d: general.id })
accept('later-epoch-stream', { stream: later }, { d: later.id })
accept('second-receipt-in-the-same-second', { n: 1 }, {})
accept('agent', { bodyFields: { agent: true } }, { agent: true })
accept('with-proof-under-a-kith-policy', { bodyFields: { proof } }, {}, { policy })
accept('conference-room-expiration-lowered', { tags: [['d', root.id], ['expiration', String(now + 100)]] }, {})
accept('agent-string-reads-as-absent', { bodyFields: { agent: 'true' } }, { agent: false })
accept('unknown-body-field-ignored', { bodyFields: { later: 1 } }, {})
accept('unknown-tag-within-four', { tags: [['d', root.id], ['expiration', String(now + 600)], ['x', '1']] }, {})
accept('stamped-60-seconds-ahead', { createdAt: now + 60 }, { createdAt: now + 60 })
accept('expiration-at-the-slack-limit', { tags: [['d', root.id], ['expiration', String(now + TTL + 60)]] }, {})

const refused = []
function refuse(name, parts, decode = {}, mutate) {
  const built = build(parts)
  const event = mutate ? mutate(built.event) : built.event
  refused.push({ name, decode: { ...decodeBase, ...decode }, event })
}
const exp = ['expiration', String(now + 600)]
refuse('wrong-kind', { kind: 1460 })
refuse('missing-d', { tags: [exp] })
refuse('duplicate-d', { tags: [['d', root.id], ['d', root.id], exp] })
refuse('d-with-extra-value', { tags: [['d', root.id, 'x'], exp] })
refuse('unknown-d', {}, { streams: streams.slice(1) })
refuse('missing-expiration', { tags: [['d', root.id]] })
refuse('non-canonical-expiration', { tags: [['d', root.id], ['expiration', `0${now + 600}`]] })
refuse('expiration-not-after-created-at', { tags: [['d', root.id], ['expiration', String(now)]] })
refuse('expiration-beyond-seven-days-and-slack', { tags: [['d', root.id], ['expiration', String(now + TTL + 61)]] })
refuse('expired-at-the-reader', { tags: [['d', root.id], ['expiration', String(now + 100)]] }, { now: now + 100 })
refuse('five-tags', { tags: [['d', root.id], exp, ['x', '1'], ['y', '1'], ['z', '1']] })
refuse('oversize-event', {}, {}, (e) => ({ ...e, content: 'A'.repeat(16_384) }))
refuse('bad-outer-signature', {}, {}, (e) => ({ ...e, sig: (e.sig[0] === '0' ? '1' : '0') + e.sig.slice(1) }))
refuse('ciphertext-re-signed-by-another-outer-key', {}, {}, (e) => signEvent({ kind: e.kind, created_at: e.created_at,
  pubkey: getPublicKey(new Uint8Array(32).fill(77)), tags: e.tags, content: e.content }, new Uint8Array(32).fill(77)))
refuse('sealed-under-the-chat-key-not-the-receipt-key', { sealKey: root.key })
refuse('envelope-version-2', { envelope: (body, sig) => ({ v: 2, body, sig }) })
refuse('envelope-extra-field', { envelope: (body, sig) => ({ v: 1, body, sig, x: 1 }) })
refuse('body-version-2', { bodyFields: { v: 2 } })
refuse('room-mismatch', { bodyFields: { room: 'b2'.repeat(32) } })
refuse('inner-signature-by-another-device', { signer: strangerSk })
refuse('inner-signature-over-another-stream', { digestD: general.id })
refuse('device-not-in-credential', { bodyFields: { credential: strangerCredential } })
refuse('credential-for-another-room', { bodyFields: { credential: otherRoomCredential } })
refuse('credential-expired-at-created-at', { bodyFields: { credential: expiredCredential } })
refuse('participant-not-in-credential', { bodyFields: { participant: getPublicKey(strangerSk) } })
refuse('upper-case-device', { bodyFields: { device: device.toUpperCase() } })
refuse('policy-without-proof', {}, { policy })
refuse('more-than-60-seconds-ahead', { createdAt: now + 61 })
// Expiration still ahead of the reader, so only the age rule refuses it.
refuse('older-than-seven-days', { tags: [['d', root.id], ['expiration', String(now + TTL + 60)]] }, { now: now + TTL + 1 })
refuse('got-empty', { bodyFields: { got: [] } })
refuse('got-over-256', { bodyFields: { got: Array.from({ length: 257 }, (_, i) => idHash(`m${i}`)) } })
refuse('got-duplicates', { bodyFields: { got: [idHash(id32), idHash(id32)] } })
refuse('got-malformed-entry', { bodyFields: { got: [idHash(id32).toUpperCase()] } })

writeFileSync(new URL('./delivery-receipt-v1.json', import.meta.url), `${JSON.stringify({
  schema: 1,
  purpose: 'Public synthetic test data. Contains no real endpoint, identity or production secret.',
  contract: 'docs/protocol.md, "Delivery receipts" (kind 1465)',
  inputs: { roomId, roomKey: bytesToHex(roomKey), epoch: { id: epoch.id, key: bytesToHex(epoch.key) },
    participantSecretKey: bytesToHex(participantSk), deviceSecretKey: bytesToHex(deviceSk), now, credential, proof, policy },
  idHashes: [{ id: id32, hash: idHash(id32) }, { id: id128, hash: idHash(id128) }],
  valid,
  refused,
}, null, 2)}\n`)
console.log(`Wrote ${valid.length} valid and ${refused.length} refused delivery receipt vectors.`)
