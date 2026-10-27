import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { deriveRoom } from './room.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { KINDS } from './kinds.js'
import { decodeRosterEvent, encodeRosterEvent, MAX_ROSTER_EVENT_BYTES, rosterEnvelope2Digest } from './roster.js'
import * as verification from './verify.js'
import type { RosterEntry } from './types.js'

const NOW = 1_800_000_000

async function fixture() {
  const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(9))
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  const credential = await createDeviceCredential({ identity: localIdentity(participantSk),
    devicePubkey: getPublicKey(deviceSk), roomId, expiresAt: NOW + 3600 })
  const entry: RosterEntry = { participant: getPublicKey(participantSk), device: getPublicKey(deviceSk),
    credential, tracks: [{ trackId: 'screen-1', role: 'screen' }], claims: { mic: NOW }, updatedAt: NOW,
    sid: '01234567', call: { id: 'a'.repeat(32), since: NOW - 30 }, proof: undefined }
  return { roomId, roomKey, deviceSk, entry, now: NOW }
}

/** Independent hostile publisher: signs exactly the supplied bytes, without encoder sanitisation. */
function wrap(f: Awaited<ReturnType<typeof fixture>>, opts: {
  entry?: RosterEntry; signer?: Uint8Array; body?: string; outerSk?: Uint8Array;
  roomId?: string; d?: string; createdAt?: number; wrapper?: Record<string, unknown>;
} = {}): Event {
  const body = opts.body ?? JSON.stringify(opts.entry ?? f.entry)
  const outerSk = opts.outerSk ?? generateSecretKey()
  const createdAt = opts.createdAt ?? NOW
  const d = opts.d ?? f.roomId
  const sig = bytesToHex(schnorr.sign(rosterEnvelope2Digest(opts.roomId ?? f.roomId, d,
    getPublicKey(outerSk), createdAt, body), opts.signer ?? f.deviceSk))
  return finalizeEvent({ kind: KINDS.ROSTER, created_at: createdAt, tags: [['d', d]],
    content: nip44.v2.encrypt(JSON.stringify(opts.wrapper ?? { v: 2, body, sig }), f.roomKey) }, outerSk)
}

describe('roster envelope 2 reader-first privacy codec', () => {
  it('keeps the legacy default wire shape and mandatory outer device binding', async () => {
    const f = await fixture()
    const event = encodeRosterEvent(f.entry, f)
    expect(event.pubkey).toBe(f.entry.device)
    expect(event.kind).toBe(20461)
    expect(event.tags).toEqual([['d', f.roomId]])
    expect(JSON.parse(nip44.v2.decrypt(event.content, f.roomKey))).toEqual(JSON.parse(JSON.stringify(f.entry)))
    expect(decodeRosterEvent(event, f)).toEqual(JSON.parse(JSON.stringify(f.entry)))
    const impostor = finalizeEvent({ kind: event.kind, created_at: event.created_at,
      tags: event.tags, content: event.content }, generateSecretKey())
    expect(decodeRosterEvent(impostor, f)).toBeNull()
  })

  it('refuses unsupported explicit writer options instead of exposing a legacy author', async () => {
    const f = await fixture()
    for (const envelope of [null, 1, 3, '2', true, {}]) {
      expect(() => encodeRosterEvent(f.entry, { ...f, envelope: envelope as 2 })).toThrow(/unsupported roster envelope/)
    }
  })

  it('uses a fresh outer author for every publication and preserves authenticated state', async () => {
    const f = await fixture()
    const one = encodeRosterEvent(f.entry, { ...f, envelope: 2 })
    const two = encodeRosterEvent(f.entry, { ...f, envelope: 2 })
    expect(one.pubkey).not.toBe(f.entry.device)
    expect(two.pubkey).not.toBe(one.pubkey)
    expect(one.kind).toBe(KINDS.ROSTER)
    expect(one.tags).toEqual([['d', f.roomId]])
    expect(JSON.stringify(one)).not.toContain(f.entry.device)
    expect(JSON.stringify(one)).not.toContain(f.entry.participant)
    expect(decodeRosterEvent(one, f)).toEqual(JSON.parse(JSON.stringify(f.entry)))
    expect(decodeRosterEvent(two, f)?.credential[verifiedSymbol]).toBeUndefined()
  })

  it('preserves epochs and conference expiration while rejecting a wrong epoch, key or room', async () => {
    const f = await fixture()
    const epoch = { id: 'b'.repeat(64), key: new Uint8Array(32).fill(8) }
    const event = encodeRosterEvent(f.entry, { ...f, envelope: 2, epoch, expiresAt: NOW + 1800 })
    expect(event.tags).toEqual([['d', epoch.id], ['expiration', String(NOW + 1800)]])
    expect(decodeRosterEvent(event, { ...f, epoch })?.device).toBe(f.entry.device)
    expect(decodeRosterEvent(event, f)).toBeNull()
    expect(decodeRosterEvent(event, { ...f, epoch: { ...epoch, key: f.roomKey } })).toBeNull()
    expect(decodeRosterEvent(event, { ...f, roomId: 'c'.repeat(64), epoch })).toBeNull()
  })

  it('requires the inner device signature even with a stolen valid credential and room key', async () => {
    const f = await fixture()
    const attacker = generateSecretKey()
    expect(decodeRosterEvent(wrap(f, { signer: attacker }), f)).toBeNull()
    expect(decodeRosterEvent(wrap(f, { signer: attacker,
      entry: { ...f.entry, device: getPublicKey(attacker) } }), f)).toBeNull()
    expect(() => encodeRosterEvent(f.entry, { ...f, deviceSk: attacker, envelope: 2 })).toThrow(/device/)
  })

  it('binds the raw body, outer author, timestamp, room and selector', async () => {
    const f = await fixture()
    const outerSk = generateSecretKey()
    const event = wrap(f, { outerSk })
    const payload = JSON.parse(nip44.v2.decrypt(event.content, f.roomKey))
    for (const changed of [
      { ...payload, body: JSON.stringify({ ...f.entry, left: true }) },
      { ...payload, body: `${payload.body} ` },
      { ...payload, sig: '00'.repeat(64) },
    ]) {
      const forged = finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags,
        content: nip44.v2.encrypt(JSON.stringify(changed), f.roomKey) }, outerSk)
      expect(decodeRosterEvent(forged, f)).toBeNull()
    }
    const rewrapped = finalizeEvent({ kind: event.kind, created_at: event.created_at,
      tags: event.tags, content: event.content }, generateSecretKey())
    expect(decodeRosterEvent(rewrapped, f)).toBeNull()
    expect(decodeRosterEvent(wrap(f, { createdAt: NOW + 1 }), f)).toBeNull()
    expect(decodeRosterEvent(wrap(f, { roomId: 'c'.repeat(64) }), f)).toBeNull()
    const differentSelector = 'd'.repeat(64)
    expect(decodeRosterEvent(wrap(f, { d: differentSelector }),
      { ...f, epoch: { id: differentSelector, key: f.roomKey } })?.device).toBe(f.entry.device)
    const retagged = finalizeEvent({ kind: event.kind, created_at: event.created_at,
      tags: [['d', differentSelector]], content: event.content }, outerSk)
    expect(decodeRosterEvent(retagged, { ...f, epoch: { id: differentSelector, key: f.roomKey } })).toBeNull()
  })

  it('refuses expired credentials at receive time and a participant substitution', async () => {
    const f = await fixture()
    const event = encodeRosterEvent(f.entry, { ...f, envelope: 2 })
    expect(decodeRosterEvent(event, { ...f, now: NOW + 3601 })).toBeNull()
    expect(decodeRosterEvent(wrap(f, { entry: { ...f.entry,
      participant: getPublicKey(generateSecretKey()) } }), f)).toBeNull()
  })

  it('does not trust cached outer or credential signature verdicts', async () => {
    const f = await fixture()
    const event = encodeRosterEvent(f.entry, { ...f, envelope: 2 })
    const forged = { ...event, sig: '00'.repeat(64), [verifiedSymbol]: true }
    expect(decodeRosterEvent(forged, f)).toBeNull()
    const credential = { ...f.entry.credential, sig: '00'.repeat(64), [verifiedSymbol]: true }
    expect(decodeRosterEvent(wrap(f, { entry: { ...f.entry, credential } }), f)).toBeNull()
  })

  it('retains future timestamp and individual claim bounds', async () => {
    const f = await fixture()
    const late = { ...f.entry, updatedAt: NOW + 61 }
    expect(decodeRosterEvent(wrap(f, { entry: late, createdAt: late.updatedAt }), f)).toBeNull()
    const fast = { ...f.entry, updatedAt: NOW + 60, claims: { mic: NOW + 61, screen: NOW + 60 } }
    expect(decodeRosterEvent(wrap(f, { entry: fast, createdAt: fast.updatedAt }), f)?.claims).toEqual({ screen: NOW + 60 })
  })

  it('strictly rejects malformed and unknown envelopes instead of trying a legacy fallback', async () => {
    const f = await fixture()
    const valid = JSON.parse(nip44.v2.decrypt(wrap(f).content, f.roomKey))
    for (const wrapper of [{ ...valid, v: 3 }, { ...valid, v: '2' }, { ...valid, extra: true },
      { ...valid, body: f.entry }, { ...valid, sig: 'bad' }, { v: 2 }, { ...f.entry, v: 3 }]) {
      expect(decodeRosterEvent(wrap(f, { wrapper }), f)).toBeNull()
    }
  })

  it('rejects duplicate and malformed routing or expiration tags', async () => {
    const f = await fixture()
    const event = wrap(f)
    for (const tags of [[], [['d', f.roomId], ['d', f.roomId]], [['d', f.roomId, 'extra']],
      [['d', f.roomId], ['expiration', '1'], ['expiration', '2']],
      [['d', f.roomId], ['expiration', 'NaN']], [['d', f.roomId], ['expiration', '-1']],
      [['d', f.roomId], ['expiration', '9007199254740992']], [['d', f.roomId], ['bad']]]) {
      const malformed = finalizeEvent({ kind: event.kind, created_at: event.created_at, tags, content: event.content }, generateSecretKey())
      expect(decodeRosterEvent(malformed, f)).toBeNull()
    }
  })

  it('rejects excessive content and tags before signature verification or decryption', async () => {
    const f = await fixture()
    const event = wrap(f)
    const verify = vi.spyOn(verification, 'verifyEventUncached')
    const decrypt = vi.spyOn(nip44.v2, 'decrypt')
    try {
      for (const hostile of [{ ...event, content: 'a'.repeat(MAX_ROSTER_EVENT_BYTES + 1) },
        { ...event, tags: [...event.tags, ['x', 'x'.repeat(MAX_ROSTER_EVENT_BYTES)]] },
        { ...event, tags: Array.from({ length: 33 }, (_, i) => [`x${i}`, 'x']) }]) {
        expect(decodeRosterEvent(hostile, f)).toBeNull()
      }
      expect(verify).not.toHaveBeenCalled()
      expect(decrypt).not.toHaveBeenCalled()
    } finally {
      verify.mockRestore()
      decrypt.mockRestore()
    }
  })
})
