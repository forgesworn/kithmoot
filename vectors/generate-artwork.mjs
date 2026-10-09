// Regenerate after npm run build:lib. Keys are public test fixtures only.
import { readFileSync, writeFileSync } from 'node:fs'
import { getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential, localIdentity, deriveRoom, encodeChatEvent } from '../dist/src/index.js'
const path = new URL('./artwork-references.json', import.meta.url)
const vectors = JSON.parse(readFileSync(path, 'utf8'))
const secret = new Uint8Array(32).fill(7)
const { roomId, roomKey } = deriveRoom(secret)
const deviceSk = new Uint8Array(32).fill(9)
const identity = localIdentity(new Uint8Array(32).fill(11))
const now = 1_800_000_000
const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: now + 3600 })
const message = {
  id: 'artwork-vector-1', participant: identity.pubkey, device: getPublicKey(deviceSk), credential,
  text: 'GIF: Coffee', sentAt: now,
  artwork: [{ pack: 'kithmoot-original-v1', id: 'coffee', kind: 'gif', sha256: '1ec70ce57a315e6dd13e8d451543eb529786a792f218121c9bfd67db718a61f1', label: 'Coffee' }],
}
vectors.encryptedMessage = {
  roomId, roomKey: Buffer.from(roomKey).toString('hex'), now,
  message: JSON.parse(JSON.stringify(message)),
  event: encodeChatEvent(message, { roomId, roomKey, deviceSk }),
}
writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`)
