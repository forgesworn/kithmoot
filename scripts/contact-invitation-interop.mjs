// Run after npm run build. Test identities here are public fixtures only.
// Generate once: node scripts/contact-invitation-interop.mjs generate <file>
// Verify native output: node scripts/contact-invitation-interop.mjs verify <file>
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { localPeerCrypt, dmPolicy } from '../dist/src/dm.js'
import { deriveRoom } from '../dist/src/room.js'
import { createRoomInvitation } from '../dist/src/invitation.js'
import { encodeRoomLink } from '../dist/src/link.js'
import { contactInvitationRumor, wrapContactInvitation, unwrapContactInvitation } from '../dist/src/contact-invitation.js'
const now = 1_800_000_000
const key = byte => new Uint8Array(32).fill(byte)
const identity = secret => ({ pubkey: getPublicKey(secret), ...localPeerCrypt(secret), signEvent: async e => finalizeEvent(e, secret) })
const sender = identity(key(1)), receiver = identity(key(2))
const [command, path] = process.argv.slice(2)
if (command === 'generate') {
  const { invitation } = createRoomInvitation(true)
  const { roomId: room } = deriveRoom(key(3))
  const link = encodeRoomLink('https://kithmoot.example/j/', { invitation, relays: ['wss://relay.example'], iceUrls: [], policy: dmPolicy(sender.pubkey, receiver.pubkey) })
  const rumor = contactInvitationRumor(sender.pubkey, receiver.pubkey, room, link, now)
  const other = await wrapContactInvitation(rumor, sender, receiver.pubkey, now, () => true)
  const own = await wrapContactInvitation(rumor, sender, sender.pubkey, now, () => true)
  writeFileSync(path, JSON.stringify({ note: 'Public test identities: sender key 01 repeated, receiver 02 repeated. Never use for real accounts.', now, room, link, rumor, other, own }, null, 2) + '\n')
} else if (command === 'verify') {
  const fixture = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(await unwrapContactInvitation(fixture.other, receiver, now), fixture.rumor)
  assert.deepEqual(await unwrapContactInvitation(fixture.own, sender, now), fixture.rumor)
  console.log('Browser opened both Android invitation envelopes and verified the authenticated rumor.')
} else throw Error('Expected generate or verify and a fixture path')
