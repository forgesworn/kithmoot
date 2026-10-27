// Public synthetic conformance data only. No roster encoder/digest is imported:
// the literal wire contract is assembled independently for other implementations.
import { writeFileSync } from 'node:fs'
import { getPublicKey, getEventHash } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { createDeviceCredential, localIdentity } from '@forgesworn/fold-kit'

const now = 1_800_000_000
const roomId = 'a1'.repeat(32)
const roomKey = new Uint8Array(32).fill(17)
const participantSk = new Uint8Array(32).fill(1)
const deviceSk = new Uint8Array(32).fill(2)
const auxiliary = new Uint8Array(32)
function signEvent(event, key) {
  const id = getEventHash(event)
  return { ...event, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), key, auxiliary)) }
}
const oldClock = Date.now
let credential
try {
  Date.now = () => now * 1000
  const minted = await createDeviceCredential({ identity: localIdentity(participantSk),
    devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: now + 3600 })
  credential = signEvent({ kind: minted.kind, created_at: minted.created_at,
    pubkey: minted.pubkey, tags: minted.tags, content: minted.content }, participantSk)
} finally { Date.now = oldClock }
const entry = { participant: getPublicKey(participantSk), device: getPublicKey(deviceSk), credential,
  tracks: [{ trackId: 'synthetic-camera', role: 'camera' }], claims: { mic: now }, updatedAt: now,
  sid: '01234567', call: { id: 'b1'.repeat(16), since: now - 10 } }
// Preserve whitespace in the signed body to catch accidental reserialisation.
const body = JSON.stringify(entry, null, 1)
const cases = []
for (const [index, epoch] of [undefined, { id: 'c1'.repeat(32), key: new Uint8Array(32).fill(34) }].entries()) {
  const root = epoch ?? { id: roomId, key: roomKey }
  const outerSk = new Uint8Array(32).fill(index + 3)
  const outer = getPublicKey(outerSk)
  const digest = sha256(new TextEncoder().encode(`kithmoot/v1/roster-envelope-2:${roomId}:${root.id}:${outer}:${now}:${body}`))
  const signature = bytesToHex(schnorr.sign(digest, deviceSk, auxiliary))
  const envelope = { v: 2, body, sig: signature }
  const event = signEvent({ kind: 20461, created_at: now, pubkey: outer,
    tags: [['d', root.id], ['expiration', String(now + 600)]],
    content: nip44.v2.encrypt(JSON.stringify(envelope), root.key, new Uint8Array(32).fill(index + 51)) }, outerSk)
  cases.push({ name: epoch ? 'epoch-with-raw-body-whitespace' : 'root-with-raw-body-whitespace',
    decode: { roomId, roomKey: bytesToHex(roomKey), now, ...(epoch ? { epoch: { id: epoch.id, key: bytesToHex(epoch.key) } } : {}) },
    digest: bytesToHex(digest), body, signature, event, expected: entry })
}
writeFileSync(new URL('./roster-envelope-2.json', import.meta.url), `${JSON.stringify({
  schema: 1, purpose: 'Public synthetic test data. Contains no real endpoint, identity or production secret.',
  writerActivation: 'disabled in RoomSession and production apps; reader-first compatibility evidence only', cases,
}, null, 2)}\n`)
console.log('Wrote two independent synthetic roster envelope-2 vectors.')
