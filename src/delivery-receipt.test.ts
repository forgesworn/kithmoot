import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { issueKindredProof } from './access.js'
import { chatStreamsOf, type ChatStream } from './chat.js'
import { KINDS } from './kinds.js'
import {
  DELIVERY_RECEIPT_TTL_SECONDS,
  MAX_DELIVERY_RECEIPT_EVENT_BYTES,
  MAX_DELIVERY_RECEIPT_IDS,
  decodeDeliveryReceipt,
  deliveryReceiptDigest,
  deliveryReceiptIdHash,
  deliveryReceiptKey,
  deliveryReceiptOuterSecretKey,
  encodeDeliveryReceipt,
  ownDeliveryReceipts,
} from './delivery-receipt.js'

const NOW = 1_800_000_000
const { roomId, roomKey } = deriveRoom(new Uint8Array(32).fill(7))
const other = deriveRoom(new Uint8Array(32).fill(8))
const [stream, channel] = chatStreamsOf([{ id: roomId, key: roomKey }], [undefined, 'general']) as [ChatStream, ChatStream]
const streams = [stream, channel]
const deviceSk = generateSecretKey()
const device = getPublicKey(deviceSk)
const participantSk = generateSecretKey()
const participant = getPublicKey(participantSk)

async function credentialFor(sk: Uint8Array, room = roomId, expiresAt = NOW + 3600, participantKey = participantSk) {
  return createDeviceCredential({ identity: localIdentity(participantKey), devicePubkey: getPublicKey(sk), roomId: room, expiresAt, now: () => NOW - 60 })
}
const credential = await credentialFor(deviceSk)

type EncodeOpts = Parameters<typeof encodeDeliveryReceipt>[0]
function receipt(overrides: Partial<EncodeOpts> = {}): Event {
  return encodeDeliveryReceipt({ roomId, stream, deviceSk, credential, messageIds: ['m1', 'm2'], createdAt: NOW, ...overrides })
}
const read = (event: Event, extra: Partial<Parameters<typeof decodeDeliveryReceipt>[1]> = {}) =>
  decodeDeliveryReceipt(event, { roomId, streams, now: NOW, ...extra })

/** Seal `body` with a valid inner signature under a fresh outer key, so the
 *  checks behind decryption can be reached with any body. */
function seal(body: Record<string, unknown> | string, opts: { tags?: string[][]; createdAt?: number; signer?: Uint8Array; envelope?: (b: string, sig: string) => unknown; s?: ChatStream } = {}): Event {
  const createdAt = opts.createdAt ?? NOW
  const s = opts.s ?? stream
  const outerSk = generateSecretKey()
  const outer = getPublicKey(outerSk)
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const sig = bytesToHex(schnorr.sign(deliveryReceiptDigest(roomId, s.d, outer, createdAt, text), opts.signer ?? deviceSk))
  const envelope = opts.envelope ? opts.envelope(text, sig) : { v: 1, body: text, sig }
  return finalizeEvent({
    kind: KINDS.DELIVERY_RECEIPT,
    created_at: createdAt,
    tags: opts.tags ?? [['d', s.d], ['expiration', String(createdAt + DELIVERY_RECEIPT_TTL_SECONDS)]],
    content: nip44.v2.encrypt(JSON.stringify(envelope), deliveryReceiptKey(s.key)),
  }, outerSk)
}
function goodBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, room: roomId, participant, device, credential, got: [deliveryReceiptIdHash('m1')], ...overrides }
}

describe('delivery receipts', () => {
  it('round-trips, naming the receiving person and the hashed messages', () => {
    expect(read(receipt())).toEqual({
      d: stream.d, createdAt: NOW, participant, device, agent: false,
      got: [deliveryReceiptIdHash('m1'), deliveryReceiptIdHash('m2')],
    })
  })

  it('carries only d and expiration, signed by a key that is neither the device nor the participant', () => {
    const event = receipt()
    expect(event.kind).toBe(1465)
    expect(event.tags).toEqual([['d', stream.d], ['expiration', String(NOW + DELIVERY_RECEIPT_TTL_SECONDS)]])
    expect(event.pubkey).not.toBe(device)
    expect(event.pubkey).not.toBe(participant)
    expect(event.content).not.toContain(device)
  })

  it('derives a different outer key per stream, second and index, and the device can re-derive it', () => {
    const a = receipt()
    const b = receipt({ index: 1 })
    const c = receipt({ createdAt: NOW + 1 })
    const d = receipt({ stream: channel })
    expect(new Set([a.pubkey, b.pubkey, c.pubkey, d.pubkey]).size).toBe(4)
    const sk = deliveryReceiptOuterSecretKey(deviceSk, stream.d, NOW, 1)
    expect(getPublicKey(sk)).toBe(b.pubkey)
    expect(getPublicKey(deliveryReceiptOuterSecretKey(generateSecretKey(), stream.d, NOW, 0))).not.toBe(a.pubkey)
  })

  it('reads a named channel under its own key, and refuses a stream it does not follow', () => {
    expect(read(receipt({ stream: channel }))?.d).toBe(channel.d)
    expect(read(receipt({ stream: channel }), { streams: [stream] })).toBeNull()
  })

  it('keeps receipts apart from chat: the chat key does not open one', () => {
    const event = receipt()
    expect(() => nip44.v2.decrypt(event.content, stream.key)).toThrow()
  })

  it('lowers the expiration to a conference room end, and never past seven days', () => {
    expect(receipt({ expiresAt: NOW + 100 }).tags).toEqual([['d', stream.d], ['expiration', String(NOW + 100)]])
    expect(receipt({ expiresAt: NOW + 30 * 86_400 }).tags[1]).toEqual(['expiration', String(NOW + DELIVERY_RECEIPT_TTL_SECONDS)])
  })

  it('marks an agent only for exactly true', () => {
    expect(read(receipt({ agent: true }))?.agent).toBe(true)
    expect(read(seal(goodBody({ agent: 'true' })))?.agent).toBe(false)
    expect(read(seal(goodBody({ agent: 1 })))?.agent).toBe(false)
  })

  it('collapses duplicate ids and refuses none or too many', () => {
    expect(read(receipt({ messageIds: ['a', 'a', 'b'] }))?.got).toHaveLength(2)
    expect(() => receipt({ messageIds: [] })).toThrow()
    const many = Array.from({ length: MAX_DELIVERY_RECEIPT_IDS + 1 }, (_, i) => `m${i}`)
    expect(() => receipt({ messageIds: many })).toThrow()
  })

  it('fits 256 ids with a proof under the size cap', () => {
    const hostSk = generateSecretKey()
    const proof = issueKindredProof({ hostSk, participant, tier: 'kith', roomId, expiresAt: NOW + 3600 })
    const ids = Array.from({ length: MAX_DELIVERY_RECEIPT_IDS }, () => bytesToHex(generateSecretKey()).slice(0, 32))
    const event = receipt({ messageIds: ids, proof, agent: true })
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(MAX_DELIVERY_RECEIPT_EVENT_BYTES)
    expect(read(event, { policy: { tier: 'kith', admitted: [getPublicKey(hostSk)] } })?.got).toHaveLength(256)
  })

  it('will not write a receipt its readers would refuse', async () => {
    const stranger = await credentialFor(generateSecretKey())
    const elsewhere = await credentialFor(deviceSk, other.roomId)
    expect(() => receipt({ credential: stranger })).toThrow()
    expect(() => receipt({ credential: elsewhere })).toThrow()
    expect(() => receipt({ createdAt: NOW + 7200 })).toThrow()
  })

  describe('refuses', () => {
    it('another kind', () => {
      const e = receipt()
      expect(read(finalizeEvent({ kind: KINDS.CHAT, created_at: e.created_at, tags: e.tags, content: e.content }, generateSecretKey()))).toBeNull()
    })

    it('a missing, duplicated or malformed d', () => {
      const exp = ['expiration', String(NOW + 600)]
      expect(read(seal(goodBody(), { tags: [exp] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [['d', stream.d], ['d', stream.d], exp] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [['d', stream.d, 'extra'], exp] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [['d', 'abc'], exp] }))).toBeNull()
    })

    it('a missing, non-canonical, past or over-long expiration', () => {
      const d = ['d', stream.d]
      expect(read(seal(goodBody(), { tags: [d] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [d, ['expiration', `0${NOW + 600}`]] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [d, ['expiration', String(NOW)]] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [d, ['expiration', String(NOW + DELIVERY_RECEIPT_TTL_SECONDS + 61)]] }))).toBeNull()
      expect(read(seal(goodBody(), { tags: [d, ['expiration', String(NOW + DELIVERY_RECEIPT_TTL_SECONDS + 60)]] }))).not.toBeNull()
    })

    it('one past its expiration at the reader', () => {
      const event = receipt({ expiresAt: NOW + 100 })
      expect(read(event, { now: NOW + 99 })).not.toBeNull()
      expect(read(event, { now: NOW + 100 })).toBeNull()
    })

    it('more than four tags, but tolerates an unknown one within them', () => {
      const base = [['d', stream.d], ['expiration', String(NOW + 600)]]
      expect(read(seal(goodBody(), { tags: [...base, ['x', '1']] }))).not.toBeNull()
      expect(read(seal(goodBody(), { tags: [...base, ['x', '1'], ['y', '1'], ['z', '1']] }))).toBeNull()
    })

    it('an oversized event before decrypting it', () => {
      const e = receipt()
      const big = { ...e, content: 'A'.repeat(MAX_DELIVERY_RECEIPT_EVENT_BYTES) }
      expect(read(big)).toBeNull()
    })

    it('a bad outer signature, and a ciphertext re-signed under a new outer key', () => {
      const e = receipt()
      expect(read({ ...e, sig: e.sig.replace(/^./, e.sig[0] === '0' ? '1' : '0') })).toBeNull()
      const lifted = finalizeEvent({ kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content }, generateSecretKey())
      expect(read(lifted)).toBeNull()
    })

    it('a body lifted into another stream', () => {
      const e = receipt()
      const body = JSON.parse(nip44.v2.decrypt(e.content, deliveryReceiptKey(stream.key))) as { body: string; sig: string }
      const outerSk = generateSecretKey()
      const moved = finalizeEvent({
        kind: KINDS.DELIVERY_RECEIPT, created_at: NOW,
        tags: [['d', channel.d], ['expiration', String(NOW + 600)]],
        content: nip44.v2.encrypt(JSON.stringify(body), deliveryReceiptKey(channel.key)),
      }, outerSk)
      expect(read(moved)).toBeNull()
    })

    it('the wrong key', () => {
      const e = seal(goodBody(), { s: { d: stream.d, key: other.roomKey } })
      expect(read(e)).toBeNull()
    })

    it('an envelope or body version other than 1, or a malformed envelope', () => {
      expect(read(seal(goodBody(), { envelope: (body, sig) => ({ v: 2, body, sig }) }))).toBeNull()
      expect(read(seal(goodBody(), { envelope: (body, sig) => ({ v: 1, body, sig, extra: 1 }) }))).toBeNull()
      expect(read(seal(goodBody(), { envelope: (body, sig) => ({ v: 1, body, sig: sig.toUpperCase() }) }))).toBeNull()
      expect(read(seal(goodBody({ v: 2 })))).toBeNull()
      expect(read(seal('[1]'))).toBeNull()
    })

    it('a body for another room', async () => {
      expect(read(seal(goodBody({ room: other.roomId })))).toBeNull()
    })

    it('an inner signature by another device, or over another outer key', () => {
      expect(read(seal(goodBody(), { signer: generateSecretKey() }))).toBeNull()
    })

    it('upper-case or malformed hex in the body', () => {
      expect(read(seal(goodBody({ device: device.toUpperCase() })))).toBeNull()
      expect(read(seal(goodBody({ participant: 'nope' })))).toBeNull()
    })

    it('a credential for another device, another room, another person, or expired at created_at', async () => {
      const otherSk = generateSecretKey()
      expect(read(seal(goodBody({ credential: await credentialFor(otherSk) })))).toBeNull()
      expect(read(seal(goodBody({ credential: await credentialFor(deviceSk, other.roomId) })))).toBeNull()
      expect(read(seal(goodBody({ participant: getPublicKey(generateSecretKey()) })))).toBeNull()
      expect(read(seal(goodBody({ credential: await credentialFor(deviceSk, roomId, NOW) })))).toBeNull()
      expect(read(seal(goodBody({ credential: null })))).toBeNull()
    })

    it('a participant the room policy does not admit, unless the proof admits them', () => {
      const hostSk = generateSecretKey()
      const policy = { tier: 'kith' as const, admitted: [getPublicKey(hostSk)] }
      expect(read(receipt(), { policy })).toBeNull()
      const proof = issueKindredProof({ hostSk, participant, tier: 'kith', roomId, expiresAt: NOW + 3600 })
      expect(read(receipt({ proof }), { policy })).not.toBeNull()
    })

    it('one stamped more than 60 s ahead, or older than seven days', () => {
      expect(read(receipt(), { now: NOW - 60 })).not.toBeNull()
      expect(read(receipt(), { now: NOW - 61 })).toBeNull()
      // Expiration still ahead of the reader, so only the age rule refuses it.
      const old = seal(goodBody(), { tags: [['d', stream.d], ['expiration', String(NOW + DELIVERY_RECEIPT_TTL_SECONDS + 60)]] })
      expect(read(old, { now: NOW + DELIVERY_RECEIPT_TTL_SECONDS - 1 })).not.toBeNull()
      expect(read(old, { now: NOW + DELIVERY_RECEIPT_TTL_SECONDS + 1 })).toBeNull()
    })

    it('a got list that is empty, too long, duplicated or malformed', () => {
      const h = deliveryReceiptIdHash('m1')
      expect(read(seal(goodBody({ got: [] })))).toBeNull()
      expect(read(seal(goodBody({ got: [h, h] })))).toBeNull()
      expect(read(seal(goodBody({ got: [h.toUpperCase()] })))).toBeNull()
      expect(read(seal(goodBody({ got: [h.slice(0, 15)] })))).toBeNull()
      expect(read(seal(goodBody({ got: 'x' })))).toBeNull()
      const many = Array.from({ length: 257 }, (_, i) => deliveryReceiptIdHash(`m${i}`))
      expect(read(seal(goodBody({ got: many })))).toBeNull()
    })
  })

  it('finds this device\'s own receipts with the keys that signed them, and nobody else\'s', async () => {
    const otherSk = generateSecretKey()
    const theirs = encodeDeliveryReceipt({ roomId, stream, deviceSk: otherSk, credential: await credentialFor(otherSk), messageIds: ['m1'], createdAt: NOW })
    const mine = [receipt(), receipt({ index: 3 }), receipt({ stream: channel })]
    const found = ownDeliveryReceipts([...mine, theirs, { ...theirs, kind: 1 }], streams, deviceSk)
    expect(found.map((f) => f.event.id)).toEqual(mine.map((e) => e.id))
    for (const { event, sk } of found) expect(getPublicKey(sk)).toBe(event.pubkey)
    expect(ownDeliveryReceipts(mine, [stream], deviceSk)).toHaveLength(2)
  })

  it('hashes message ids to 16 hex characters of a domain-separated SHA-256', () => {
    expect(deliveryReceiptIdHash('m1')).toMatch(/^[0-9a-f]{16}$/)
    expect(deliveryReceiptIdHash('m1')).not.toBe(deliveryReceiptIdHash('m2'))
    expect(deliveryReceiptIdHash('x'.repeat(128))).toHaveLength(16)
  })

  it('never throws on junk', () => {
    for (const junk of [{}, { kind: 1465 }, { kind: 1465, tags: 'x' }, { kind: 1465, tags: [[1, 2]], content: 1 }]) {
      expect(read(junk as unknown as Event)).toBeNull()
    }
  })
})
