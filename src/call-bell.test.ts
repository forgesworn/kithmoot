import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { deriveRoom } from './room.js'
import { KINDS } from './kinds.js'
import {
  CALL_BELL_TTL_SECONDS,
  callBellContentKey,
  callBellDay,
  callBellListenTags,
  callBellTag,
  decodeCallBellEvent,
  encodeCallBellEvent,
} from './call-bell.js'

const room = deriveRoom(new Uint8Array(32).fill(7))
const other = deriveRoom(new Uint8Array(32).fill(8))
const deviceSk = generateSecretKey()
const device = getPublicKey(deviceSk)
const participantSk = generateSecretKey()
const NOW = 1_800_000_000
const call = { id: 'ab'.repeat(16), since: NOW }

function ring(overrides: Partial<Parameters<typeof encodeCallBellEvent>[0]> = {}): Event {
  return encodeCallBellEvent({ roomId: room.roomId, key: room.roomKey, deviceSk, state: 'start', call, createdAt: NOW, ...overrides })
}
const read = (event: Event, now = NOW, r = room) => decodeCallBellEvent(event, { roomId: r.roomId, key: r.roomKey, now })

/** Re-seal a body under the right key with a fresh throwaway, to test the
 *  checks behind decryption. */
function reseal(body: unknown, createdAt = NOW): Event {
  return finalizeEvent({
    kind: KINDS.CALL_BELL,
    created_at: createdAt,
    tags: [['d', callBellTag(room.roomKey, createdAt)], ['expiration', String(createdAt + 120)]],
    content: nip44.v2.encrypt(JSON.stringify(body), callBellContentKey(room.roomKey)),
  }, generateSecretKey())
}
function bodyOf(event: Event): Record<string, unknown> {
  return JSON.parse(nip44.v2.decrypt(event.content, callBellContentKey(room.roomKey)))
}

describe('call bell', () => {
  it('round-trips a start and an end', () => {
    expect(read(ring())).toEqual({ state: 'start', call, device, createdAt: NOW })
    const end = ring({ state: 'end', createdAt: NOW + 3600 })
    expect(read(end, NOW + 3600)).toEqual({ state: 'end', call, device, createdAt: NOW + 3600 })
  })

  it('carries only d and expiration, signed by neither the device nor the participant, and not the roster tag', () => {
    const a = ring()
    const b = ring()
    expect(a.tags).toEqual([['d', callBellTag(room.roomKey, NOW)], ['expiration', String(NOW + CALL_BELL_TTL_SECONDS)]])
    expect(a.pubkey).not.toBe(device)
    expect(a.pubkey).not.toBe(getPublicKey(participantSk))
    expect(a.pubkey).not.toBe(b.pubkey)
    const wire = JSON.stringify(a)
    expect(wire).not.toContain(device)
    expect(wire).not.toContain(room.roomId)
    expect(a.tags[0][1]).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes its tag at UTC midnight and not before', () => {
    const midnight = Date.UTC(2027, 0, 15) / 1000
    expect(callBellDay(midnight)).toBe('2027-01-15')
    expect(callBellDay(midnight - 1)).toBe('2027-01-14')
    expect(callBellTag(room.roomKey, midnight)).toBe(callBellTag(room.roomKey, midnight + 86_399))
    expect(callBellTag(room.roomKey, midnight)).not.toBe(callBellTag(room.roomKey, midnight - 1))
    expect(callBellTag(room.roomKey, midnight)).not.toBe(callBellTag(other.roomKey, midnight))
    expect(callBellListenTags(room.roomKey, midnight + 43_200)).toHaveLength(1)
    expect(callBellListenTags(room.roomKey, midnight + 30)).toEqual([callBellTag(room.roomKey, midnight - 1), callBellTag(room.roomKey, midnight)])
  })

  it('refuses the wrong room key, and a replay into another room', () => {
    expect(read(ring(), NOW, other)).toBeNull()
    // Same key, another room id: the device signature binds the room.
    expect(decodeCallBellEvent(ring(), { roomId: other.roomId, key: room.roomKey, now: NOW })).toBeNull()
  })

  it('refuses stale and future bells', () => {
    expect(read(ring(), NOW + CALL_BELL_TTL_SECONDS)).not.toBeNull()
    expect(read(ring(), NOW + CALL_BELL_TTL_SECONDS + 1)).toBeNull()
    expect(read(ring({ createdAt: NOW + 61, call: { id: call.id, since: NOW + 61 } }))).toBeNull()
  })

  it('refuses a bad device signature, a moved created_at, and a tampered outer event', () => {
    const body = bodyOf(ring())
    expect(read(reseal(body))).not.toBeNull()
    expect(read(reseal({ ...body, sig: '00'.repeat(64) }))).toBeNull()
    expect(read(reseal(body, NOW + 5))).toBeNull()
    expect(read(reseal({ ...body, state: 'end' }))).toBeNull()
    const tampered = { ...ring(), content: ring().content }
    expect(read(tampered)).toBeNull()
  })

  it('refuses a wrong version, an unknown state, a malformed id and an impossible since', () => {
    const body = bodyOf(ring())
    expect(read(reseal({ ...body, v: 2 }))).toBeNull()
    expect(read(reseal({ ...body, state: 'ring' }))).toBeNull()
    expect(read(reseal({ ...body, call: { id: 'AB'.repeat(16), since: NOW } }))).toBeNull()
    expect(read(reseal({ ...body, call: { id: 'ab'.repeat(15), since: NOW } }))).toBeNull()
    expect(() => ring({ call: { id: 'nope', since: NOW } })).toThrow()
    expect(read(ring({ call: { id: call.id, since: NOW - 3600 } }))).toBeNull()
    expect(read(ring({ state: 'end', call: { id: call.id, since: NOW - 3600 } }))).not.toBeNull()
    expect(read(ring({ state: 'end', call: { id: call.id, since: NOW + 3600 } }))).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(read({ ...ring(), content: 'x' })).toBeNull()
    expect(read({ ...ring(), tags: [] })).toBeNull()
    expect(read({ ...ring(), kind: KINDS.ROSTER })).toBeNull()
  })
})
