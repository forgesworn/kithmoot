import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { localIdentity } from './identity.js'
import {
  encodeReadPositions,
  encodeReadPositionsLocal,
  decodeReadPositions,
  localSelfCrypt,
  mergeReadPositions,
  readPositionId,
  READ_POSITION_KIND,
  READ_POSITION_LABEL,
} from './read-position.js'

const NOW = 1_800_000_000

describe('read positions', () => {
  const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(3))
  const sk = generateSecretKey()
  const participant = getPublicKey(sk)
  const read = { '': { at: NOW - 10, id: 'm9' }, minutes: { at: NOW - 100 } }

  it('round-trips through the identity path and the local path alike', async () => {
    const viaIdentity = await encodeReadPositions(read, { roomId, roomKey, identity: localIdentity(sk), crypt: localSelfCrypt(sk), createdAt: NOW })
    const viaLocal = encodeReadPositionsLocal(read, { roomId, roomKey, participantSk: sk, createdAt: NOW })
    for (const event of [viaIdentity, viaLocal]) {
      expect(event.kind).toBe(READ_POSITION_KIND)
      expect(event.tags).toContainEqual(['d', readPositionId(roomKey)])
      expect(event.tags).toContainEqual(['l', READ_POSITION_LABEL])
      expect(JSON.stringify(event)).not.toContain(roomId)
      const decoded = await decodeReadPositions(event, { participant, roomId, roomKey, crypt: localSelfCrypt(sk) })
      expect(decoded).toEqual({ room: roomId, read })
    }
  })

  it('is refused under the wrong key, for the wrong room, and from somebody else', async () => {
    const event = encodeReadPositionsLocal(read, { roomId, roomKey, participantSk: sk, createdAt: NOW })
    const other = deriveRoom(new Uint8Array(32).fill(4))
    expect(await decodeReadPositions(event, { participant, roomId: other.roomId, roomKey: other.roomKey, crypt: localSelfCrypt(sk) })).toBeNull()
    expect(await decodeReadPositions(event, { participant, roomId: other.roomId, roomKey, crypt: localSelfCrypt(sk) })).toBeNull()
    expect(await decodeReadPositions(event, { participant: getPublicKey(generateSecretKey()), roomId, roomKey, crypt: localSelfCrypt(sk) })).toBeNull()
    expect(await decodeReadPositions(event, { participant, roomId, roomKey, crypt: localSelfCrypt(generateSecretKey()) })).toBeNull()
  })

  it('drops a malformed channel entry and keeps the rest', async () => {
    const crypt = localSelfCrypt(sk)
    const content = await crypt.encrypt(JSON.stringify({ v: 1, room: roomId, read: { '': { at: 5 }, bad: { at: -1 }, worse: 'x', ['n'.repeat(65)]: { at: 1 } } }))
    const event = await localIdentity(sk).signEvent({ kind: READ_POSITION_KIND, created_at: NOW, tags: [['d', readPositionId(roomKey)], ['l', READ_POSITION_LABEL]], content })
    expect(await decodeReadPositions(event, { participant, roomId, roomKey, crypt })).toEqual({ room: roomId, read: { '': { at: 5 } } })
  })

  it('merges by the greater position and says who was ahead', () => {
    const local = { '': { at: 10, id: 'b' }, minutes: { at: 3 } }
    const remote = { '': { at: 10, id: 'a' }, transcript: { at: 7 } }
    const { merged, localAhead, remoteAhead } = mergeReadPositions(local, remote)
    expect(merged).toEqual({ '': { at: 10, id: 'b' }, minutes: { at: 3 }, transcript: { at: 7 } })
    expect(localAhead).toBe(true)
    expect(remoteAhead).toBe(true)
    expect(mergeReadPositions(remote, remote)).toEqual({ merged: remote, localAhead: false, remoteAhead: false })
  })
})
