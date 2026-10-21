import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signRoomStorage, verifyRoomStorage, MAX_ROOM_STORAGE_NODES, ROOM_STORAGE_LABELS } from './room-storage.js'
import { decodeControl, encodeControl } from './control.js'

const roomId = 'ab'.repeat(32)
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)
const nodes = ['https://grove.example.net', 'https://example.org:8443/wb/one', 'http://127.0.0.1:3742']

describe('room storage', () => {
  it('is believed on the authority signature, for exactly that room, version and list', () => {
    const sig = signRoomStorage({ roomId, version: 100, nodes, authoritySk })
    expect(sig).toMatch(/^[0-9a-f]{128}$/)
    expect(verifyRoomStorage({ roomId, version: 100, nodes, sig, authority })).toBe(true)
    expect(verifyRoomStorage({ roomId, version: 101, nodes, sig, authority })).toBe(false)
    expect(verifyRoomStorage({ roomId: 'cd'.repeat(32), version: 100, nodes, sig, authority })).toBe(false)
    expect(verifyRoomStorage({ roomId, version: 100, nodes: nodes.slice(0, 2), sig, authority })).toBe(false)
    expect(verifyRoomStorage({ roomId, version: 100, nodes, sig, authority: getPublicKey(generateSecretKey()) })).toBe(false)
    expect(verifyRoomStorage({ roomId, version: 100, nodes, sig: sig.slice(2), authority })).toBe(false)
  })

  it('signs the list in the order given: a preference order is not sorted', () => {
    const reversed = [...nodes].reverse()
    const a = signRoomStorage({ roomId, version: 5, nodes, authoritySk })
    const b = signRoomStorage({ roomId, version: 5, nodes: reversed, authoritySk })
    expect(a).not.toBe(b)
    expect(verifyRoomStorage({ roomId, version: 5, nodes: reversed, sig: b, authority })).toBe(true)
    expect(verifyRoomStorage({ roomId, version: 5, nodes: reversed, sig: a, authority })).toBe(false)
  })

  it('signs the withdrawal: an empty list is valid', () => {
    const sig = signRoomStorage({ roomId, version: 9, nodes: [], authoritySk })
    expect(verifyRoomStorage({ roomId, version: 9, nodes: [], sig, authority })).toBe(true)
  })

  it('refuses to sign, and fails to verify, a list that is not canonical', () => {
    for (const bad of [['https://grove.example.net/'], ['https://Grove.example.net'], ['https://grove.example.net:443'], ['http://grove.example.net'], ['https://a.example.net', 'https://a.example.net:8443'],
      Array.from({ length: MAX_ROOM_STORAGE_NODES + 1 }, (_, i) => `https://n${i}.example.net`)]) {
      expect(() => signRoomStorage({ roomId, version: 1, nodes: bad, authoritySk }), bad.join()).toThrow()
      // A signature over the same message, made by hand, still fails: canonicality is checked, not mended.
      expect(verifyRoomStorage({ roomId, version: 1, nodes: bad, sig: signRoomStorage({ roomId, version: 1, nodes: [], authoritySk }), authority }), bad.join()).toBe(false)
    }
    expect(() => signRoomStorage({ roomId: 'xyz', version: 1, nodes, authoritySk })).toThrow()
    expect(() => signRoomStorage({ roomId, version: -1, nodes, authoritySk })).toThrow()
    expect(verifyRoomStorage({ roomId: 'xyz', version: 1, nodes, sig: 'zz', authority })).toBe(false)
  })

  it('exactly eight nodes are allowed', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `https://n${i}.example.net`)
    const sig = signRoomStorage({ roomId, version: 1, nodes: eight, authoritySk })
    expect(verifyRoomStorage({ roomId, version: 1, nodes: eight, sig, authority })).toBe(true)
  })

  it('names its label', () => {
    expect(ROOM_STORAGE_LABELS).toEqual(['kithmoot/v1/storage:'])
  })

  it('travels as a control op anybody may repost, decoded exactly as sent', () => {
    const sig = signRoomStorage({ roomId, version: 7, nodes, authoritySk })
    const op = { op: 'storage' as const, nodes, version: 7, sig }
    expect(decodeControl(encodeControl(op))).toEqual(op)
    expect(decodeControl(encodeControl({ ...op, nodes: [], sig: signRoomStorage({ roomId, version: 7, nodes: [], authoritySk }) }))).toMatchObject({ op: 'storage', nodes: [] })
    // Upper-case signature hex is lower-cased; the list is kept as sent, even when it is not canonical.
    expect(decodeControl(JSON.stringify({ ...op, sig: sig.toUpperCase() }))).toEqual(op)
    expect(decodeControl(JSON.stringify({ ...op, nodes: ['https://Grove.example.net/'] }))).toMatchObject({ nodes: ['https://Grove.example.net/'] })
  })

  it('the control decoder refuses an extra key, nine nodes, a long entry, a bad version and a bad signature', () => {
    const sig = signRoomStorage({ roomId, version: 7, nodes, authoritySk })
    const op = { op: 'storage', nodes, version: 7, sig }
    expect(decodeControl(JSON.stringify({ ...op, extra: 1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ op: 'storage', nodes, version: 7 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, nodes: Array.from({ length: 9 }, (_, i) => `https://n${i}.example.net`) }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, nodes: ['https://x.example.net/' + 'a'.repeat(300)] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, nodes: [1] }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, nodes: 'https://grove.example.net' }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, version: -1 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, version: 1.5 }))).toBeNull()
    expect(decodeControl(JSON.stringify({ ...op, sig: 'x' }))).toBeNull()
  })
})
