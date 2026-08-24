import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { encodeRosterEvent, decodeRosterEvent } from './roster.js'
import type { RosterEntry } from './types.js'

const NOW = 1_800_000_000

function fixture() {
  const secret = new Uint8Array(32).fill(9)
  const { roomId, roomKey } = deriveRoom(secret)
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const credential = createDeviceCredential({
    participantSk,
    devicePubkey: device,
    roomId,
    expiresAt: NOW + 3600,
  })
  const entry: RosterEntry = {
    participant: getPublicKey(participantSk),
    device,
    credential,
    tracks: [{ trackId: 't1', role: 'screen' }],
    claims: { mic: NOW },
    updatedAt: NOW,
  }
  return { roomId, roomKey, deviceSk, entry }
}

describe('roster events', () => {
  it('round-trips an entry through encryption', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const decoded = decodeRosterEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded).toEqual(entry)
  })

  it('leaves no participant pubkey readable on the wire', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const wire = JSON.stringify(event)
    expect(wire).not.toContain(entry.participant)
  })

  it('tags the event with the room id so it is subscribable', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    expect(event.tags).toContainEqual(['d', roomId])
  })

  it('returns null when the room key is wrong', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    const wrongKey = new Uint8Array(32).fill(1)
    expect(decodeRosterEvent(event, { roomId, roomKey: wrongKey, now: NOW })).toBeNull()
  })

  it('returns null when the credential does not authorise the signing device', () => {
    const { roomId, roomKey, entry } = fixture()
    const impostorSk = generateSecretKey()
    // The impostor signs the event, but the credential names a different device.
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk: impostorSk })
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('returns null when the credential has expired', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = encodeRosterEvent(entry, { roomId, roomKey, deviceSk })
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW + 999_999 })).toBeNull()
  })

  it('returns null for malformed ciphertext rather than throwing', () => {
    const { roomId, roomKey, deviceSk, entry } = fixture()
    const event = { ...encodeRosterEvent(entry, { roomId, roomKey, deviceSk }), content: 'rubbish' }
    expect(() => decodeRosterEvent(event, { roomId, roomKey, now: NOW })).not.toThrow()
    expect(decodeRosterEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })
})
