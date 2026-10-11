// Run npm run build:lib first. Fixture keys and rooms are synthetic.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from '../dist/src/room.js'
import { localIdentity } from '../dist/src/identity.js'
import { createDeviceCredential } from '../dist/src/credential.js'
import { encodeChatEvent, decodeChatEvent, deriveChannel } from '../dist/src/chat.js'
import { roomLogoOp } from '../dist/src/room-logo.js'
import { encodeControl } from '../dist/src/control.js'

const now = 1_800_000_000, id = 'a'.repeat(32)
const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(33))
const deviceSk = new Uint8Array(32).fill(2), participantSk = new Uint8Array(32).fill(1)
const device = getPublicKey(deviceSk), participant = getPublicKey(participantSk)
const credential = await createDeviceCredential({ identity: localIdentity(participantSk), devicePubkey: device, roomId, expiresAt: now + 3600 })
const image = JSON.parse(readFileSync(new URL('./logo-images-v1.json', import.meta.url), 'utf8')).vectors[0].payload
const base = { id, participant, device, credential, text: encodeControl(roomLogoOp(image, now * 1000, id)), sentAt: now, roomLogo: image }
const cases = []
function add(name, message, channel = 'control', accepted = false) {
  const address = deriveChannel(roomId, roomKey, channel)
  const event = finalizeEvent({ kind: 1460, created_at: now, tags: [['d', address.id]],
    content: nip44.v2.encrypt(JSON.stringify(message), address.key) }, deviceSk)
  const decoded = decodeChatEvent(event, { roomId, roomKey, channel, now })
  if (!!decoded !== accepted) throw new Error(`Unexpected reference acceptance: ${name}`)
  const expected = decoded ? Object.fromEntries(['id', 'participant', 'device', 'text', 'sentAt', 'roomLogo'].map(key => [key, decoded[key]])) : null
  cases.push({ name, channel, accepted, event, expected })
}
// Exercise the real public encoder as well as independently assembled ciphertext.
for (const logo of [image, null]) {
  const message = { ...base, text: encodeControl(roomLogoOp(logo, now * 1000, id)), roomLogo: logo }
  const encoded = encodeChatEvent(message, { roomId, roomKey, deviceSk, channel: 'control' })
  if (!decodeChatEvent(encoded, { roomId, roomKey, channel: 'control', now })) throw new Error('Encoder did not round-trip')
  add(logo ? 'inline-image' : 'explicit-removal', message, 'control', true)
}
add('carried-image', { ...base, text: JSON.stringify({ ...roomLogoOp(image, now * 1000, id), carried: true }) }, 'control', true)
for (const [name, extra] of [
  ['extra-url', { roomLogo: { ...image, url: 'https://tracker.invalid/logo.png' } }],
  ['tampered-image', { roomLogo: { ...image, sha256: '0'.repeat(64) } }],
  ['unexpected-removal', { roomLogo: null }],
  ['wrong-op', { text: 'Hello room' }],
  ['unmatched-removal', { text: encodeControl(roomLogoOp(null, now * 1000, id)) }],
  ['borrowed-participant', { participant: getPublicKey(new Uint8Array(32).fill(3)) }],
  ['wrong-device', { device: getPublicKey(new Uint8Array(32).fill(4)) }],
  ['attachments', { attachments: [] }], ['artwork', { artwork: [] }],
  ['reply', { reply: { id } }], ['thread', { thread: { id } }], ['mentions', { mentions: [] }],
  ['edit', { replaces: id }], ['retraction', { retracts: id }],
  ['reaction', { reaction: { target: id, emoji: '👍' } }], ['kind', { kind: 'transcript' }],
]) add(name, { ...base, ...extra })
add('ordinary-channel', base, 'main')
const sourceHashes = Object.fromEntries(['chat.ts', 'room-logo.ts'].map(name =>
  [`src/${name}`, createHash('sha256').update(readFileSync(new URL(`../src/${name}`, import.meta.url))).digest('hex')]))
const result = { format: 'kithmoot.room-logo-chat.v1', source: 'forgesworn/kithmoot', sourceHashes, roomId,
  roomKey: Buffer.from(roomKey).toString('hex'), now, vectors: cases }
writeFileSync(new URL('./room-logo-chat-v1.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(`${cases.length} credential-bound encrypted chat vectors`)
