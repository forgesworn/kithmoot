import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  decodeDeliveryReceipt,
  deliveryReceiptDigest,
  deliveryReceiptIdHash,
  deliveryReceiptKey,
  deliveryReceiptOuterSecretKey,
  encodeDeliveryReceipt,
} from '../src/delivery-receipt.js'
import type { RoomPolicy } from '../src/types.js'

interface DecodeVector { roomId: string; streams: Array<{ d: string; key: string }>; now: number; policy?: RoomPolicy }
const vectors = JSON.parse(readFileSync(new URL('./delivery-receipt-v1.json', import.meta.url), 'utf8'))
const decodeOpts = (d: DecodeVector) => ({ ...d, streams: d.streams.map((s) => ({ d: s.d, key: hexToBytes(s.key) })) })
const deviceSk = hexToBytes(vectors.inputs.deviceSecretKey)
const allStreams = decodeOpts(vectors.valid[0].decode).streams

describe('independently assembled delivery receipt vectors', () => {
  it('message id hashes', () => {
    for (const { id, hash } of vectors.idHashes) expect(deliveryReceiptIdHash(id)).toBe(hash)
  })

  for (const vector of vectors.valid) {
    it(`accepts ${vector.name}`, () => {
      const event = vector.event as Event
      const d = event.tags.find((t) => t[0] === 'd')![1]!
      const stream = allStreams.find((s) => s.d === d)!
      const index = vector.name === 'second-receipt-in-the-same-second' ? 1 : 0
      expect(bytesToHex(deliveryReceiptKey(stream.key))).toBe(vector.receiptKey)
      const outerSk = deliveryReceiptOuterSecretKey(deviceSk, d, event.created_at, index)
      expect(bytesToHex(outerSk)).toBe(vector.outerSecretKey)
      expect(getPublicKey(outerSk)).toBe(event.pubkey)
      expect(bytesToHex(deliveryReceiptDigest(vectors.inputs.roomId, d, event.pubkey, event.created_at, vector.body))).toBe(vector.digest)
      expect(decodeDeliveryReceipt(event, decodeOpts(vector.decode))).toEqual(vector.expected)
    })
  }

  it('the writer produces the canonical body byte for byte', () => {
    for (const name of ['root-stream', 'agent', 'with-proof-under-a-kith-policy']) {
      const vector = vectors.valid.find((v: { name: string }) => v.name === name)
      const parsed = JSON.parse(vector.body)
      const stream = allStreams.find((s) => s.d === vector.expected.d)!
      const event = encodeDeliveryReceipt({
        roomId: vectors.inputs.roomId, stream, deviceSk, credential: parsed.credential,
        proof: parsed.proof, agent: parsed.agent, createdAt: vector.event.created_at,
        messageIds: vectors.idHashes.map((h: { id: string }) => h.id),
      })
      expect(event.pubkey).toBe(vector.event.pubkey)
      const envelope = JSON.parse(nip44.v2.decrypt(event.content, deliveryReceiptKey(stream.key)))
      expect(envelope.body).toBe(vector.body)
      // BIP-340 auxiliary randomness is fresh in production, so the
      // signature is checked rather than compared.
      expect(schnorr.verify(hexToBytes(envelope.sig), hexToBytes(vector.digest), hexToBytes(getPublicKey(deviceSk)))).toBe(true)
    }
  })

  for (const vector of vectors.refused) {
    it(`refuses ${vector.name}`, () => {
      expect(decodeDeliveryReceipt(vector.event as Event, decodeOpts(vector.decode))).toBeNull()
    })
  }
})
