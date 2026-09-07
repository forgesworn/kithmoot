import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { decodeMemberPass, decodeServicePolicy, deriveServiceKey, deriveServiceRoom, encodeMemberPass, encodeServicePolicy, normaliseServiceAudience, type MemberPass, type ServicePolicy } from './service-admission.js'

const authority = generateSecretKey()
const device = generateSecretKey()
const traffic = new Uint8Array(32).fill(3)
const room = 'ab'.repeat(32)
const audience = { type: 'blossom' as const, id: 'https://files.example' }
const now = 1_800_000_000
const pass: MemberPass = { v: 1, audience, room, device: getPublicKey(device), epoch: 2, expiresAt: now + 60, permissions: ['upload'] }
const policy: ServicePolicy = { v: 1, audience, room, enforcementEpoch: 2, activateAt: now, graceEnd: now + 30 }

describe('reserved service admission codecs', () => {
  it('round-trips signed passes and restart-persistent policies without enabling a service', () => {
    expect(decodeMemberPass(encodeMemberPass(pass, authority, now))).toEqual(pass)
    expect(decodeServicePolicy(encodeServicePolicy(policy, authority, now))).toEqual(policy)
  })
  it('rejects mutations even when the signing library cached a valid signature', () => {
    const event = encodeMemberPass(pass, authority, now)
    event.content = JSON.stringify({ ...pass, permissions: ['relay'] })
    expect(decodeMemberPass(event)).toBeNull()
  })
  it('requires canonical audiences without credentials, queries or fragments', () => {
    expect(normaliseServiceAudience({ type: { toString: 'blossom' }, id: 'https://files.example' })).toBeNull()
    for (const id of ['https://files.example/', 'http://files.example', 'https://me:secret@files.example', 'https://files.example?key=x', 'https://files.example#x']) {
      expect(normaliseServiceAudience({ type: 'blossom', id })).toBeNull()
    }
    expect(normaliseServiceAudience({ type: 'nudger', id: 'https://notify.example/rooms' })).toEqual({ type: 'nudger', id: 'https://notify.example/rooms' })
  })
  it('separates room, audience and role keys and pseudonyms', () => {
    const other = { ...audience, id: 'https://other.example' }
    const key = deriveServiceKey(authority, room, audience, 'authority')
    expect(key).not.toEqual(deriveServiceKey(authority, room, other, 'authority'))
    expect(key).not.toEqual(deriveServiceKey(authority, 'cd'.repeat(32), audience, 'authority'))
    expect(key).not.toEqual(deriveServiceKey(authority, room, audience, 'device'))
    expect(deriveServiceRoom(traffic, room, audience)).not.toBe(deriveServiceRoom(traffic, room, other))
    expect(deriveServiceRoom(traffic, room, audience)).not.toBe(room)
  })
  it('preserves the forwarder signalling key and the nudger room selector', () => {
    const forwarder = { type: 'forwarder' as const, id: getPublicKey(generateSecretKey()) }
    expect(deriveServiceKey(device, room, forwarder, 'device')).toEqual(device)
    expect(deriveServiceRoom(traffic, room, forwarder)).toBe(room)
    expect(deriveServiceRoom(traffic, room, { type: 'nudger', id: 'https://notify.example/rooms' })).toBe(room)
  })
  it('rejects impossible expiry and grace intervals', () => {
    expect(() => encodeMemberPass({ ...pass, expiresAt: now }, authority, now)).toThrow()
    expect(() => encodeServicePolicy({ ...policy, graceEnd: now - 1 }, authority, now)).toThrow()
  })
})
