import { describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools/pure'
import vectors from '../vectors/cadence-v1.json'
import {
  CADENCE_BUCKET_BYTES,
  CADENCE_COUNTERS_PER_DEVICE,
  CADENCE_DEVICE_SLOTS,
  CADENCE_EPOCH_SECONDS,
  CADENCE_SLOT_SECONDS,
  buildCadenceLease,
  buildCadenceRekey,
  buildCadenceQueue,
  cadenceLeasePath,
  cadencePayloadSha256,
  cadenceQueuePath,
  cadenceRekeyPath,
  deriveCadenceDropPublicKeys,
  serialiseCadenceBody,
  signCadenceRequest,
  type CadenceLeaseRequest,
  type CadenceQueueRequest,
  type CadenceMutationRequest,
} from './box-cadence.js'
import type { ParticipantIdentity, UnsignedEvent } from './identity.js'

type WireVector = {
  node_id: string
  now: number
  lease: { body: string; path: string; method: 'PUT'; payload_sha256: string; authorization: string; authorization_event: Event }
  queue: { body: string; path: string; method: 'POST'; payload_sha256: string; authorization: string; authorization_event: Event }
  rekey: { body: string; path: string; method: 'PUT'; payload_sha256: string; authorization: string; authorization_event: Event }
}
const vector = vectors as WireVector

function vectorSigner(event: Event): ParticipantIdentity {
  return {
    pubkey: event.pubkey,
    async signEvent(unsigned: UnsignedEvent): Promise<Event> {
      expect(unsigned).toEqual({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: event.content })
      return event
    },
  }
}

describe('Bothy cadence v1 wire compatibility', () => {
  for (const name of ['lease', 'queue', 'rekey'] as const) {
    it(`reproduces the frozen Rust ${name} bytes, hash and NIP-98 header`, async () => {
      const wire = vector[name]
      const value = JSON.parse(wire.body) as CadenceLeaseRequest | CadenceQueueRequest | CadenceMutationRequest
      expect(serialiseCadenceBody(value)).toBe(wire.body)
      expect(cadencePayloadSha256(wire.body)).toBe(wire.payload_sha256)
      const signed = await signCadenceRequest({ nodeId: vector.node_id, method: wire.method, path: wire.path, value, signer: vectorSigner(wire.authorization_event), now: vector.now })
      expect(signed.authorizationEvent).toEqual(wire.authorization_event)
      expect(signed.authorization).toBe(wire.authorization)
      expect(signed.contentType).toBe('application/json')
    })
  }

  it('rejects a signer that changes any authorization term', async () => {
    const wire = vector.lease
    const signer: ParticipantIdentity = {
      pubkey: wire.authorization_event.pubkey,
      async signEvent(): Promise<Event> { return { ...wire.authorization_event, tags: [['method', 'POST']] } },
    }
    await expect(signCadenceRequest({ nodeId: vector.node_id, method: wire.method, path: wire.path, value: JSON.parse(wire.body), signer, now: vector.now })).rejects.toThrow(/different bytes/)
  })
})

describe('a phone delegates only a finite public key range', () => {
  const lease = JSON.parse(vector.lease.body) as CadenceLeaseRequest

  it('rebuilds the frozen queue body from an acknowledged lease and signed room event', () => {
    const queue = JSON.parse(vector.queue.body) as CadenceQueueRequest
    expect(serialiseCadenceBody(buildCadenceQueue(lease, queue.request_id, queue.event))).toBe(vector.queue.body)
    expect(() => buildCadenceQueue(lease, queue.request_id, { ...queue.event, kind: 1 })).toThrow(/queue event/)
    const stableTagged = { ...queue.event, tags: [['d', lease.room]] }
    expect(() => buildCadenceQueue(lease, queue.request_id, stableTagged)).toThrow(/queue event/)
  })

  it('rebuilds the frozen immediate room-generation retirement', () => {
    const rekey = JSON.parse(vector.rekey.body) as CadenceMutationRequest
    expect(serialiseCadenceBody(buildCadenceRekey(lease, rekey.request_id, rekey.next_room_generation!))).toBe(vector.rekey.body)
    expect(cadenceRekeyPath(lease.lease_id)).toBe(vector.rekey.path)
    expect(() => buildCadenceRekey(lease, rekey.request_id, lease.room_generation)).toThrow(/next room generation/)
  })

  it('derives exactly one device half for every future epoch and exposes no scalar', () => {
    const keys = deriveCadenceDropPublicKeys(new Uint8Array(32).fill(7), lease.persona, 500002, 500004, 1)
    expect(keys).toHaveLength(2 * CADENCE_COUNTERS_PER_DEVICE)
    expect(keys[0]).toMatchObject({ epoch: 500002, counter: 8, pubkey: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(keys.at(-1)).toMatchObject({ epoch: 500003, counter: 15 })
    expect(new Set(keys.map(key => key.pubkey)).size).toBe(keys.length)
    expect(JSON.stringify(keys)).not.toContain('private')
  })

  it('builds the exact fixed profile and refuses current, overlong or third-device ranges', () => {
    const common = {
      nodeId: vector.node_id, requestId: lease.request_id, leaseId: lease.lease_id, generation: 1,
      trafficRoom: lease.traffic_room, roomGeneration: lease.room_generation,
      deviceSlot: 0, currentEpoch: 500000, startEpoch: 500002, endEpoch: 500004,
      roomKey: new Uint8Array(32).fill(9), publicRelays: lease.public_relays, circleBoxes: lease.circle_boxes,
      room: lease.room, persona: lease.persona, device: lease.device, credential: lease.credential,
      grantId: lease.grant_id, now: vector.now,
    }
    const built = buildCadenceLease(common)
    expect(built).toMatchObject({ epoch_seconds: CADENCE_EPOCH_SECONDS, slot_seconds: CADENCE_SLOT_SECONDS, bucket_bytes: CADENCE_BUCKET_BYTES, device_slots: CADENCE_DEVICE_SLOTS, counter_lo: 0, counter_hi: 8 })
    expect(built.drop_keys).toHaveLength(16)
    expect(cadenceLeasePath(built.lease_id)).toBe(vector.lease.path)
    expect(cadenceQueuePath(built.lease_id)).toBe(vector.queue.path)
    expect(() => buildCadenceLease({ ...common, startEpoch: 500001 })).toThrow(/future start/)
    expect(() => buildCadenceLease({ ...common, endEpoch: 500171 })).toThrow(/lease window/)
    expect(() => buildCadenceLease({ ...common, deviceSlot: 2 })).toThrow(/device slot/)
  })
})
