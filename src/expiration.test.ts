import { describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { withExpiration } from './expiration.js'
import { wrapSignal, SIGNAL_EXPIRATION_SECONDS } from './signal.js'
import { encodeCallBellEvent, CALL_BELL_TTL_SECONDS } from './call-bell.js'
import { deriveRoom } from './room.js'
import { createPairingCode, encodePairingGrant, encodePairingRequest } from './pairing.js'

// The rule every event signed for a conference room follows. The rule
// itself is fold-kit's; this checks it as the encoders here meet it.
const NOW = Math.floor(Date.now() / 1000)

describe('withExpiration', () => {
  it('adds the end, keeps an earlier expiration, lowers a later one, never two', () => {
    const ends = NOW + 3_600
    expect(withExpiration([['d', 'x']], ends)).toEqual([['d', 'x'], ['expiration', String(ends)]])
    expect(withExpiration([['d', 'x'], ['expiration', String(NOW + 60)]], ends)).toEqual([['d', 'x'], ['expiration', String(NOW + 60)]])
    expect(withExpiration([['d', 'x'], ['expiration', String(ends + 60)]], ends)).toEqual([['d', 'x'], ['expiration', String(ends)]])
    expect(withExpiration([['expiration', String(ends + 1)], ['expiration', String(ends + 2)]], ends)).toEqual([['expiration', String(ends)]])
  })

  it('hands back the very same tags for a room with no end', () => {
    const tags = [['d', 'x']]
    expect(withExpiration(tags, undefined)).toBe(tags)
  })

  it('a signal wrap and a call bell keep their own short life unless the room ends sooner', () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(5))
    const body = { type: 'ack', roomId } as unknown as Parameters<typeof wrapSignal>[0]
    const recipient = 'ab'.repeat(32)
    const far = wrapSignal(body, { senderSk: generateSecretKey(), recipientPubkey: recipient, expiresAt: NOW + 86_400 })
    const own = Number(far.tags.find((t) => t[0] === 'expiration')![1])
    expect(own - far.created_at).toBe(SIGNAL_EXPIRATION_SECONDS)
    const soon = wrapSignal(body, { senderSk: generateSecretKey(), recipientPubkey: recipient, expiresAt: NOW + 5 })
    expect(soon.tags.filter((t) => t[0] === 'expiration')).toEqual([['expiration', String(NOW + 5)]])

    const call = { id: 'c'.repeat(32), since: NOW }
    const bell = encodeCallBellEvent({ roomId, key: roomKey, deviceSk: generateSecretKey(), state: 'start', call, createdAt: NOW, expiresAt: NOW + 86_400 })
    expect(bell.tags.filter((t) => t[0] === 'expiration')).toEqual([['expiration', String(NOW + CALL_BELL_TTL_SECONDS)]])
    const late = encodeCallBellEvent({ roomId, key: roomKey, deviceSk: generateSecretKey(), state: 'start', call, createdAt: NOW, expiresAt: NOW + 10 })
    expect(late.tags.filter((t) => t[0] === 'expiration')).toEqual([['expiration', String(NOW + 10)]])
  })

  it('a pairing request and grant for a conference room lapse with it; the credential inside keeps its own expiry', () => {
    const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(6))
    const ends = NOW + 86_400
    const request = encodePairingRequest({ code: createPairingCode(), roomId, roomKey, deviceSk: generateSecretKey(), now: NOW, expiresAt: ends })
    expect(request.tags).toEqual([['d', roomId], ['expiration', String(ends)]])
    const credential = { kind: 20460, created_at: NOW, tags: [['device', 'ab'.repeat(32)], ['expiration', String(NOW + 43_200)]], content: '', pubkey: '', id: '', sig: '' }
    const grant = encodePairingGrant(credential, { roomId, roomKey, deviceSk: generateSecretKey(), expiresAt: ends })
    expect(grant.tags).toEqual([['d', roomId], ['p', 'ab'.repeat(32)], ['expiration', String(ends)]])
  })
})
