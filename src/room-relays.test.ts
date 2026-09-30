import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { canonicalRoomRelays, signRoomRelays, verifyRoomRelays, MAX_ROOM_RELAYS } from './room-relays.js'
import { decodeControl, encodeControl } from './control.js'

const roomId = 'ab'.repeat(32)
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)

describe('room relays', () => {
  it('canonicalises: normalised, deduplicated, sorted', () => {
    expect(canonicalRoomRelays(['wss://Relay.Example.org', 'wss://nos.lol', 'wss://relay.example.org/'])).toEqual(['wss://nos.lol/', 'wss://relay.example.org/'])
  })

  it('refuses what could not be a relay, and more than the cap', () => {
    expect(() => canonicalRoomRelays(['https://relay.example.org'])).toThrow()
    expect(() => canonicalRoomRelays(['ws://relay.example.org'])).toThrow()
    expect(() => canonicalRoomRelays([])).toThrow()
    expect(() => canonicalRoomRelays(Array.from({ length: MAX_ROOM_RELAYS + 1 }, (_, i) => `wss://r${i}.example.org`))).toThrow()
  })

  it('is believed on the authority signature, for exactly that room, version and list', () => {
    const relays = canonicalRoomRelays(['wss://relay.example.org', 'wss://nos.lol'])
    const sig = signRoomRelays({ roomId, version: 100, relays, authoritySk })
    expect(verifyRoomRelays({ roomId, version: 100, relays, sig, authority })).toBe(true)
    expect(verifyRoomRelays({ roomId, version: 101, relays, sig, authority })).toBe(false)
    expect(verifyRoomRelays({ roomId: 'cd'.repeat(32), version: 100, relays, sig, authority })).toBe(false)
    expect(verifyRoomRelays({ roomId, version: 100, relays: relays.slice(0, 1), sig, authority })).toBe(false)
    expect(verifyRoomRelays({ roomId, version: 100, relays, sig, authority: getPublicKey(generateSecretKey()) })).toBe(false)
    expect(verifyRoomRelays({ roomId, version: 100, relays: ['not a url'], sig, authority })).toBe(false)
  })

  it('travels as a control op anybody may repost', () => {
    const relays = canonicalRoomRelays(['wss://relay.example.org'])
    const op = { op: 'relays' as const, relays, version: 7, sig: signRoomRelays({ roomId, version: 7, relays, authoritySk }) }
    expect(decodeControl(encodeControl(op))).toEqual(op)
    expect(decodeControl(JSON.stringify({ ...op, relays: [] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, version: -1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, sig: 'x' }))).toBeNull()
  })
})
