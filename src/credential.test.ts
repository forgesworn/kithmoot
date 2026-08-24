import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'

const ROOM = 'a'.repeat(64)
const NOW = 1_800_000_000

function setup() {
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  return {
    participantSk,
    participant: getPublicKey(participantSk),
    device: getPublicKey(deviceSk),
  }
}

describe('device credentials', () => {
  it('accepts a credential signed by the participant for this room', () => {
    const { participantSk, participant, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW + 3600,
    })
    const result = verifyDeviceCredential(cred, { roomId: ROOM, now: NOW })
    expect(result).toEqual({ ok: true, participant, device })
  })

  it('rejects a credential for a different room', () => {
    const { participantSk, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW + 3600,
    })
    const result = verifyDeviceCredential(cred, { roomId: 'b'.repeat(64), now: NOW })
    expect(result).toEqual({ ok: false, reason: 'wrong room' })
  })

  it('rejects an expired credential', () => {
    const { participantSk, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW - 1,
    })
    const result = verifyDeviceCredential(cred, { roomId: ROOM, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a credential whose signature has been tampered with', () => {
    const { participantSk, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW + 3600,
    })
    const tampered = { ...cred, tags: [...cred.tags.map((t) => [...t])] }
    tampered.tags[1][1] = 'c'.repeat(64) // swap the delegated device
    const result = verifyDeviceCredential(tampered, { roomId: ROOM, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'bad signature' })
  })

  it('uses the NIP-40 expiration tag, never "expiry"', () => {
    const { participantSk, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW + 3600,
    })
    const names = cred.tags.map((t) => t[0])
    expect(names).toContain('expiration')
    expect(names).not.toContain('expiry')
  })

  it('rejects a credential with no expiration tag', () => {
    const { participantSk, device } = setup()
    const cred = createDeviceCredential({
      participantSk,
      devicePubkey: device,
      roomId: ROOM,
      expiresAt: NOW + 3600,
    })
    const stripped = { ...cred, tags: cred.tags.filter((t) => t[0] !== 'expiration') }
    const result = verifyDeviceCredential(stripped, { roomId: ROOM, now: NOW })
    expect(result.ok).toBe(false)
  })
})
