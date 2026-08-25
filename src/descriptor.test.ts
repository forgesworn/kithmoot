import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { base64 } from '@scure/base'
import { deriveRoom } from './room.js'
import { createDeviceCredential } from './credential.js'
import { KINDS } from './kinds.js'
import { encodeDescriptorEvent, decodeDescriptorEvent } from './descriptor.js'
import { selectForwarder } from './forwarder.js'
import type { RoomDescriptor } from './types.js'
import { localIdentity } from './identity.js'

const NOW = 1_800_000_000

async function fixture(over: Partial<RoomDescriptor> = {}) {
  const secret = new Uint8Array(32).fill(3)
  const { roomId, roomKey } = deriveRoom(secret)
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const credential = await createDeviceCredential({
    identity: localIdentity(participantSk),
    devicePubkey: device,
    roomId,
    expiresAt: NOW + 3600,
  })
  const descriptor: RoomDescriptor = {
    participant: getPublicKey(participantSk),
    device,
    credential,
    forwarders: [],
    iceServers: [{ urls: ['stun:stun.example:3478'] }],
    updatedAt: NOW,
    ...over,
  }
  return { roomId, roomKey, deviceSk, descriptor, secret }
}

const decrypted = (event: Event, roomKey: Uint8Array): string => nip44.v2.decrypt(event.content, roomKey)

describe('room descriptor events', () => {
  it('is an ephemeral kind, so no relay keeps a record that the room existed', async () => {
    expect(KINDS.DESCRIPTOR).toBeGreaterThanOrEqual(20000)
    expect(KINDS.DESCRIPTOR).toBeLessThan(30000)
  })

  it('round-trips a room that names no forwarder', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture()
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    expect(decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })).toEqual(
      JSON.parse(JSON.stringify(descriptor)),
    )
  })

  it('round-trips a room that names one forwarder', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture({
      forwarders: [{ url: 'wss://fwd.example/one', pubkey: 'ab'.repeat(32), label: 'The box' }],
    })
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual(descriptor.forwarders)
  })

  it('round-trips a room that names several forwarders, in order', async () => {
    const forwarders = [
      { url: 'wss://fwd-a.example/fwd', pubkey: 'aa'.repeat(32) },
      { url: 'wss://fwd-b.example/fwd', label: 'Community box' },
      { url: 'ws://fwd-c.local:7788' },
    ]
    const { roomId, roomKey, deviceSk, descriptor } = await fixture({ forwarders })
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual(forwarders)
    // And the whole room agrees on one of them without negotiating.
    expect(selectForwarder(decoded!.forwarders)).toEqual(forwarders[0])
  })

  it('never lets a forwarder entry carry the room key', async () => {
    // This is the claim the entire stage exists for: a forwarder is given the
    // room id and nothing else. Encoding projects every entry onto exactly
    // url/pubkey/label, so a key cannot ride along even by accident.
    const { roomId, roomKey, deviceSk, descriptor } = await fixture()
    const event = encodeDescriptorEvent(
      {
        ...descriptor,
        forwarders: [
          {
            url: 'wss://fwd.example/one',
            pubkey: 'ab'.repeat(32),
            // Not part of ForwarderRef; a buggy or hostile publisher's doing.
            roomKey: bytesToHex(roomKey),
            secret: base64.encode(roomKey),
          } as never,
        ],
      },
      { roomId, roomKey, deviceSk },
    )

    const plaintext = decrypted(event, roomKey)
    expect(plaintext).not.toContain(bytesToHex(roomKey))
    expect(plaintext).not.toContain(base64.encode(roomKey))

    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual([{ url: 'wss://fwd.example/one', pubkey: 'ab'.repeat(32) }])
  })

  it('strips an unknown field a second implementation added to a forwarder entry', async () => {
    // Decoding projects too, not just encoding: the entry may have been
    // written by something that is not this implementation.
    const { roomId, roomKey, deviceSk, descriptor } = await fixture()
    const smuggled = {
      ...descriptor,
      forwarders: [{ url: 'wss://fwd.example/one', roomKey: bytesToHex(roomKey), label: 'x' }],
    }
    const event = finalizeEvent(
      {
        kind: KINDS.DESCRIPTOR,
        created_at: NOW,
        tags: [['d', roomId]],
        content: nip44.v2.encrypt(JSON.stringify(smuggled), roomKey),
      },
      deviceSk,
    )
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual([{ url: 'wss://fwd.example/one', label: 'x' }])
  })

  it('projects ice servers onto their known fields', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture({
      iceServers: [
        { urls: ['turn:turn.example:3478'], username: '1800003600:kithmoot', credential: 'abc', junk: 1 } as never,
      ],
    })
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.iceServers).toEqual([
      { urls: ['turn:turn.example:3478'], username: '1800003600:kithmoot', credential: 'abc' },
    ])
  })

  it('normalises a forwarder pubkey to lower case at the boundary', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture({
      forwarders: [{ url: 'wss://fwd.example/one', pubkey: 'AB'.repeat(32) }],
    })
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders[0].pubkey).toBe('ab'.repeat(32))
  })

  it('leaves the room id the only thing a relay can read', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture({
      forwarders: [{ url: 'wss://fwd.example/one' }],
    })
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk })
    const wire = JSON.stringify(event)
    expect(wire).not.toContain('wss://fwd.example/one')
    expect(wire).not.toContain(descriptor.participant)
    expect(wire).toContain(roomId)
  })

  it('drops a malformed forwarder entry rather than the whole descriptor', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture()
    const mixed = {
      ...descriptor,
      forwarders: [{ url: 'wss://good.example/fwd' }, { label: 'no url' }, null, 'not an object', 42],
    }
    const event = finalizeEvent(
      {
        kind: KINDS.DESCRIPTOR,
        created_at: NOW,
        tags: [['d', roomId]],
        content: nip44.v2.encrypt(JSON.stringify(mixed), roomKey),
      },
      deviceSk,
    )
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual([{ url: 'wss://good.example/fwd' }])
  })

  it('treats a missing forwarder list as an empty one', async () => {
    const { roomId, roomKey, deviceSk, descriptor } = await fixture()
    const { forwarders: _omitted, ...withoutForwarders } = descriptor
    const event = finalizeEvent(
      {
        kind: KINDS.DESCRIPTOR,
        created_at: NOW,
        tags: [['d', roomId]],
        content: nip44.v2.encrypt(JSON.stringify(withoutForwarders), roomKey),
      },
      deviceSk,
    )
    const decoded = decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })
    expect(decoded!.forwarders).toEqual([])
  })
})

describe('room descriptor rejection', () => {
  const encoded = async (over: Partial<RoomDescriptor> = {}) => {
    const f = await fixture(over)
    return { ...f, event: encodeDescriptorEvent(f.descriptor, f) }
  }

  it('refuses a descriptor encrypted to another room key', async () => {
    const { roomId, event } = await encoded()
    const other = deriveRoom(new Uint8Array(32).fill(4))
    expect(decodeDescriptorEvent(event, { roomId, roomKey: other.roomKey, now: NOW })).toBeNull()
  })

  it('refuses a descriptor tagged for another room', async () => {
    const { roomKey, event } = await encoded()
    const other = deriveRoom(new Uint8Array(32).fill(4))
    expect(decodeDescriptorEvent(event, { roomId: other.roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a tampered signature', async () => {
    const { roomId, roomKey, event } = await encoded()
    expect(decodeDescriptorEvent({ ...event, sig: '00'.repeat(64) }, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a descriptor signed by a device the credential does not name', async () => {
    const { roomId, roomKey, descriptor } = await fixture({ forwarders: [{ url: 'wss://mine.example/fwd' }] })
    // A member of the room - it holds the key - repointing the room at its
    // own forwarder while wearing somebody else's credential.
    const event = encodeDescriptorEvent(descriptor, { roomId, roomKey, deviceSk: generateSecretKey() })
    expect(decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses a descriptor whose credential has expired', async () => {
    const { roomId, roomKey, event } = await encoded()
    expect(decodeDescriptorEvent(event, { roomId, roomKey, now: NOW + 7200 })).toBeNull()
  })

  it('refuses a descriptor stamped beyond clock skew', async () => {
    // updatedAt decides which of two descriptors wins, so a device stamping
    // the year 3000 would pin its own forwarder list in for good.
    const { roomId, roomKey, event } = await encoded({ updatedAt: NOW + 86_400 })
    expect(decodeDescriptorEvent(event, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('refuses the wrong kind', async () => {
    const { roomId, roomKey, event } = await encoded()
    expect(decodeDescriptorEvent({ ...event, kind: KINDS.ROSTER }, { roomId, roomKey, now: NOW })).toBeNull()
  })

  it('never throws on garbage, because it runs inside a subscription handler', async () => {
    const { roomId, roomKey, deviceSk } = await fixture()
    const junk = finalizeEvent(
      { kind: KINDS.DESCRIPTOR, created_at: NOW, tags: [['d', roomId]], content: 'not ciphertext' },
      deviceSk,
    )
    expect(decodeDescriptorEvent(junk, { roomId, roomKey, now: NOW })).toBeNull()
  })
})
