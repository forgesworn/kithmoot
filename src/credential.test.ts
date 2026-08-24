import { describe, it, expect } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { KINDS } from './kinds.js'

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

  it('rejects a credential whose expiration tag is not a number, rather than treating it as never expiring', () => {
    const { participantSk, device } = setup()
    // Built (and genuinely signed) directly, rather than via
    // createDeviceCredential + post-hoc tampering: tampering the tag after
    // signing would fail on the signature check first and never reach the
    // expiry comparison this test exists to exercise.
    const cred = finalizeEvent(
      {
        kind: KINDS.CREDENTIAL,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', ROOM],
          ['device', device],
          // `Number('not-a-number')` is NaN, and every comparison with NaN
          // is false - so a naive `Number(expiration) <= now` treats this
          // as unexpired forever. That is a fail-open default in a
          // security check.
          ['expiration', 'not-a-number'],
        ],
        content: '',
      },
      participantSk,
    )
    const result = verifyDeviceCredential(cred, { roomId: ROOM, now: NOW })
    expect(result).toEqual({ ok: false, reason: 'no expiration' })
  })
})
