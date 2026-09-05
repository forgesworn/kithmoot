import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { decodeChatEvent, encodeChatEvent, type ChatMessage } from './chat.js'
import { normaliseReaction, reactionsFor, toggleReaction } from './reactions.js'

async function fixture() {
  const room = deriveRoom(new Uint8Array(32).fill(17)), deviceSk = generateSecretKey(), identity = localIdentity(generateSecretKey())
  const credential = await createDeviceCredential({ identity, devicePubkey: getPublicKey(deviceSk), roomId: room.roomId, expiresAt: 1800003600 })
  const target: ChatMessage = { id: 'target', participant: credential.pubkey, device: getPublicKey(deviceSk), credential, text: 'Hello', sentAt: 1800000000 }
  return { ...room, deviceSk, target }
}

describe('encrypted reactions', () => {
  it('authenticates the reacting sender and refuses replay into a different room or channel', async () => {
    const { roomId, roomKey, deviceSk, target } = await fixture()
    const reaction = toggleReaction([], target, target.participant, '❤️')
    const message = { ...target, id: 'reaction', text: 'Reacted ❤️', reaction }
    const event = encodeChatEvent(message, { roomId, roomKey, deviceSk })
    expect(JSON.stringify(event)).not.toContain('❤️')
    expect(event.tags).toEqual([['d', roomId]])
    expect(decodeChatEvent(event, { roomId, roomKey, now: target.sentAt })?.reaction).toEqual(reaction)
    expect(decodeChatEvent(event, { roomId, roomKey, now: target.sentAt, channel: 'agents' })).toBeNull()
    expect(decodeChatEvent(event, { ...deriveRoom(new Uint8Array(32).fill(18)), now: target.sentAt })).toBeNull()
    const forged = encodeChatEvent(message, { roomId, roomKey, deviceSk: generateSecretKey() })
    expect(decodeChatEvent(forged, { roomId, roomKey, now: target.sentAt })).toBeNull()
  })
  it('rejects malformed reaction metadata rather than changing a vote or showing control text', async () => {
    const { roomId, roomKey, deviceSk, target } = await fixture()
    const reaction = toggleReaction([], target, target.participant, '👍')
    for (const bad of [null, { ...reaction, revision: 0 }, { ...reaction, revision: 2147483648 }, { ...reaction, active: 'true' }, { ...reaction, emoji: '<img>' }, { ...reaction, participant: 'wrong' }, { ...reaction, messageId: '' }]) {
      const event = finalizeEvent({ kind: 1460, created_at: target.sentAt, tags: [['d', roomId]], content: nip44.v2.encrypt(JSON.stringify({ ...target, reaction: bad }), roomKey) }, deviceSk)
      expect(decodeChatEvent(event, { roomId, roomKey, now: target.sentAt })).toBeNull()
      expect(normaliseReaction(bad)).toBeNull()
    }
  })
  it('converges out-of-order toggles, deduplicates devices and isolates each participant and target', async () => {
    const { target } = await fixture()
    const add = { ...target, id: 'z', reaction: toggleReaction([], target, target.participant, '👍') }
    const remove = { ...target, id: 'a', reaction: toggleReaction([add], target, target.participant, '👍') }
    const other = { ...add, id: 'other', participant: 'ab'.repeat(32) }
    const updates = reactionsFor([remove, other, add, add], target).get('👍')!
    expect(updates.filter(m => m.reaction!.active).map(m => m.participant)).toEqual([other.participant])
    expect(toggleReaction([remove, add], target, target.participant, '👍')).toMatchObject({ active: true, revision: 3 })
    expect(reactionsFor([add], { ...target, participant: other.participant }).get('👍')).toEqual([])
    expect(reactionsFor([add], { ...target, id: 'different' }).get('👍')).toEqual([])
  })
})
