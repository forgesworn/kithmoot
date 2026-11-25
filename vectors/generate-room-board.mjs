// Public synthetic conformance data only. The board codec and log are NOT
// imported: every derivation, envelope and event below is assembled by hand
// from the wire contract in docs/room-board.md, so the vectors check the
// codec rather than echo it. Deterministic: fixed keys, fixed BIP-340
// auxiliary randomness, fixed NIP-44 nonces and fixed Yjs client ids.
import { writeFileSync } from 'node:fs'
import { getPublicKey, getEventHash } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { base64 } from '@scure/base'
import * as Y from 'yjs'
import { createDeviceCredential, deriveChannel, localIdentity } from '@forgesworn/fold-kit'

const enc = (s) => new TextEncoder().encode(s)
const now = 1_800_000_000
const roomId = 'a1'.repeat(32)
const roomKey = new Uint8Array(32).fill(17)
const epoch = { id: 'c1'.repeat(32), key: new Uint8Array(32).fill(34) }
const participantSk = new Uint8Array(32).fill(1)
const deviceSk = new Uint8Array(32).fill(2)
const strangerSk = new Uint8Array(32).fill(10)
const participant = getPublicKey(participantSk)
const device = getPublicKey(deviceSk)
const auxiliary = new Uint8Array(32)
const CHANNEL = 'board'
const PART_BYTES = 22 * 1024

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
const strangerCredential = await credentialFor(strangerSk, roomId, now + 3600)

const stream0 = deriveChannel(roomId, roomKey, CHANNEL)
const stream1 = deriveChannel(epoch.id, epoch.key, CHANNEL)
const chat0 = deriveChannel(roomId, roomKey)

// ---- the starting state -------------------------------------------------
// Three columns and the board view, written as Yjs client 1 with fixed ids
// and no clock reading. Girnel's `roomBoardGenesis()` builds the same bytes
// through its board model; here they are written straight into the maps.
function genesis() {
  const doc = new Y.Doc()
  doc.clientID = 1
  const meta = doc.getMap('meta'), columns = doc.getMap('columns'), views = doc.getMap('views')
  doc.getMap('labels'); doc.getMap('records')
  doc.transact(() => { meta.set('boardId', 'room'); meta.set('name', 'Board'); meta.set('createdAt', 0) })
  for (const [id, name, order, isDone] of [['todo', 'To do', '5', false], ['doing', 'Doing', '55', false], ['done', 'Done', '555', true]]) {
    doc.transact(() => {
      const column = new Y.Map()
      column.set('id', id); column.set('name', name); column.set('order', order); column.set('isDone', isDone); column.set('archived', false)
      columns.set(id, column)
    })
  }
  doc.transact(() => {
    const view = new Y.Map()
    view.set('id', 'board'); view.set('type', 'board'); view.set('name', 'Board')
    views.set('board', view)
  })
  return Y.encodeStateAsUpdate(doc)
}
const genesisBytes = genesis()

// ---- two members' changes, and what they merge to -----------------------
function member(clientID, id, title) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  Y.applyUpdate(doc, genesisBytes)
  const before = Y.encodeStateVector(doc)
  doc.transact(() => {
    const card = new Y.Map()
    card.set('title', title); card.set('status', 'todo')
    doc.getMap('records').set(id, card)
  })
  return Y.encodeStateAsUpdate(doc, before)
}
const updateA = member(1001, 'card-a', 'Book the hall')
const updateB = member(1002, 'card-b', 'Order the tea')
const merged = new Y.Doc()
merged.clientID = 9
for (const update of [genesisBytes, updateB, updateA, updateA]) Y.applyUpdate(merged, update)
const mergedState = Y.encodeStateAsUpdate(merged)

// ---- parts and envelopes -------------------------------------------------
function split(kind, bytes, blob) {
  const count = Math.ceil(bytes.byteLength / PART_BYTES)
  return Array.from({ length: count }, (_, index) => ({ v: 1, kind, blob, index, count,
    data: base64.encode(bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES)) }))
}
let nonceSeed = 90
let messageSeed = 0
/** One board envelope, built from its parts so a refusal can change exactly one. */
function envelope(board, { stream = stream0, sentAt = now, signer = deviceSk, fields = {}, cred = credential, kind = 1460 } = {}) {
  const message = { id: (messageSeed++).toString(16).padStart(32, '0'), participant, device, credential: cred,
    text: 'Board update', sentAt, board, ...fields }
  for (const key of Object.keys(message)) if (message[key] === undefined) delete message[key]
  const content = nip44.v2.encrypt(JSON.stringify(message), stream.key, new Uint8Array(32).fill(nonceSeed++ % 256))
  return signEvent({ kind, created_at: sentAt, pubkey: getPublicKey(signer), tags: [['d', stream.id]], content }, signer)
}

const blobA = '000102030405060708090a0b0c0d0e0f'
const blobBig = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'
const single = split('update', updateA, blobA)
// A whole board long enough to need three parts: one long card title.
const bigDoc = new Y.Doc()
bigDoc.clientID = 2002
Y.applyUpdate(bigDoc, genesisBytes)
bigDoc.transact(() => {
  const card = new Y.Map()
  card.set('title', Array.from({ length: 6_000 }, (_, i) => (i % 97).toString(36).padStart(2, '0')).join('').repeat(5)); card.set('status', 'todo')
  bigDoc.getMap('records').set('card-long', card)
})
const bigBytes = Y.encodeStateAsUpdate(bigDoc)
const bigParts = split('snapshot', bigBytes, blobBig)
if (bigParts.length !== 3) throw new Error(`expected three parts, got ${bigParts.length}`)

const decodeBase = { roomId, roomKey: bytesToHex(roomKey), now }
const valid = [
  { name: 'one-part-update', decode: decodeBase, event: envelope(single[0]), expected: { participant, device, sentAt: now, board: single[0] } },
  { name: 'one-part-update-in-a-later-epoch', decode: { ...decodeBase, epoch: { id: epoch.id, key: bytesToHex(epoch.key) } },
    event: envelope(single[0], { stream: stream1 }), expected: { participant, device, sentAt: now, board: single[0] } },
  ...bigParts.map((part, index) => ({ name: `snapshot-part-${index + 1}-of-3`, decode: decodeBase,
    event: envelope(part, { sentAt: now + index }), expected: { participant, device, sentAt: now + index, board: part } })),
]

const refused = []
function refuse(name, board, options = {}, decode = {}, mutate) {
  const event = envelope(board, options)
  refused.push({ name, decode: { ...decodeBase, ...decode }, event: mutate ? mutate(event) : event })
}
const part = single[0]
refuse('board-part-in-the-main-chat', part, { stream: chat0 }, { channel: null })
refuse('read-as-conversation', part, {}, { channel: null })
refuse('read-in-another-epoch', part, {}, { epoch: { id: epoch.id, key: bytesToHex(epoch.key) } })
refuse('unknown-part-field', { ...part, later: 1 })
refuse('part-version-2', { ...part, v: 2 })
refuse('unknown-kind', { ...part, kind: 'replace' })
refuse('blob-id-upper-case', { ...part, blob: blobA.toUpperCase() })
refuse('blob-id-short', { ...part, blob: blobA.slice(2) })
refuse('count-zero', { ...part, count: 0 })
refuse('count-97', { ...part, count: 97 })
refuse('index-not-below-count', { ...part, index: 1 })
refuse('index-negative', { ...part, index: -1 })
refuse('data-empty', { ...part, data: '' })
refuse('data-not-base64', { ...part, data: '!!!!' })
refuse('data-unpadded', { ...part, data: part.data.replace(/=+$/, '') + (part.data.endsWith('=') ? '' : 'A') })
refuse('data-over-one-part', { ...part, data: 'A'.repeat(30_044) })
refuse('with-a-reaction-too', part, { fields: { reaction: { messageId: '1'.repeat(32), participant, emoji: '+', on: true } } })
refuse('with-mentions-too', part, { fields: { mentions: ['everyone'] } })
refuse('with-a-reply-too', part, { fields: { reply: { messageId: '1'.repeat(32), participant } } })
refuse('signed-by-a-device-the-message-does-not-name', part, { signer: strangerSk })
refuse('credential-for-another-device', part, { cred: strangerCredential })
refuse('credential-for-another-room', part, { cred: otherRoomCredential })
refuse('sent-after-the-credential-ran-out', part, { sentAt: now + 3601 }, { now: now + 3601 })
refuse('sent-more-than-five-minutes-ahead', part, { sentAt: now + 301 })
refuse('wrong-kind', part, { kind: 1465 })
refuse('bad-signature', part, {}, {}, (e) => ({ ...e, sig: (e.sig[0] === '0' ? '1' : '0') + e.sig.slice(1) }))

const out = {
  schema: 1,
  purpose: 'Public synthetic test data. Contains no real endpoint, identity or production secret.',
  contract: 'docs/room-board.md',
  inputs: { roomId, roomKey: bytesToHex(roomKey), epoch: { id: epoch.id, key: bytesToHex(epoch.key) },
    participantSecretKey: bytesToHex(participantSk), deviceSecretKey: bytesToHex(deviceSk), now, credential },
  channel: CHANNEL,
  streams: [
    { name: 'epoch-0', d: stream0.id, key: bytesToHex(stream0.key) },
    { name: 'later-epoch', d: stream1.id, key: bytesToHex(stream1.key) },
  ],
  cacheKey: bytesToHex(hkdf(sha256, roomKey, undefined, enc(`kithmoot/v1/room-board-cache:${roomId}`), 32)),
  limits: { partBytes: PART_BYTES, maxParts: 96 },
  genesis: { base64: base64.encode(genesisBytes), bytes: genesisBytes.byteLength, sha256: bytesToHex(sha256(genesisBytes)),
    columns: ['todo', 'doing', 'done'], views: ['board'] },
  merge: {
    note: 'Apply the genesis and both updates in any order, any number of times: the records are these.',
    updates: [base64.encode(updateA), base64.encode(updateB)],
    records: { 'card-a': 'Book the hall', 'card-b': 'Order the tea' },
    columns: ['todo', 'doing', 'done'],
    stateVector: base64.encode(Y.encodeStateVector(merged)),
    stateBytes: mergedState.byteLength,
  },
  blobs: [
    { name: 'one-part-update', kind: 'update', blob: blobA, base64: base64.encode(updateA), parts: single },
    { name: 'three-part-snapshot', kind: 'snapshot', blob: blobBig, bytes: bigBytes.byteLength, sha256: bytesToHex(sha256(bigBytes)),
      partData: bigParts.map((p) => ({ index: p.index, count: p.count, bytes: base64.decode(p.data).byteLength, sha256: bytesToHex(sha256(base64.decode(p.data))) })) },
  ],
  valid,
  refused,
}
writeFileSync(new URL('./room-board-v1.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`room-board-v1.json: ${valid.length} valid, ${refused.length} refused`)
