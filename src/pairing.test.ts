import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { deriveRoom } from './room.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import {
  createPairingCode,
  encodePairingRequest,
  decodePairingRequest,
  encodePairingGrant,
  decodePairingGrant,
  hostPairing,
  requestPairing,
} from './pairing.js'

const NOW = 1_800_000_000
const now = () => NOW

function room() {
  return deriveRoom(new Uint8Array(32).fill(23))
}

describe('pairing codes and envelopes', () => {
  it('binds a request to the code and to the requesting device', async () => {
    const { roomId, roomKey } = room()
    const code = createPairingCode()
    const phoneSk = generateSecretKey()

    const event = encodePairingRequest({ code, roomId, roomKey, deviceSk: phoneSk, now: NOW })

    expect(decodePairingRequest(event, { code, roomId, roomKey })).toEqual({
      device: getPublicKey(phoneSk),
    })
  })

  it('rejects a request that does not know the code', async () => {
    const { roomId, roomKey } = room()
    const phoneSk = generateSecretKey()
    const event = encodePairingRequest({
      code: createPairingCode(),
      roomId,
      roomKey,
      deviceSk: phoneSk,
      now: NOW,
    })

    // Everyone in the room holds the room key, so everyone can publish a
    // well-formed request. The code is what separates "my own second device"
    // from "any member who fancies being me".
    expect(decodePairingRequest(event, { code: createPairingCode(), roomId, roomKey })).toBeNull()
  })

  it('rejects a request replayed by another device under the same code', async () => {
    const { roomId, roomKey } = room()
    const code = createPairingCode()
    const phoneSk = generateSecretKey()
    const genuine = encodePairingRequest({ code, roomId, roomKey, deviceSk: phoneSk, now: NOW })

    // A room member who sees the ciphertext learns only a hash, so they
    // cannot compute the binding for their own device pubkey.
    const attackerSk = generateSecretKey()
    const replayed = encodePairingRequest({
      code: createPairingCode(),
      roomId,
      roomKey,
      deviceSk: attackerSk,
      now: NOW,
    })

    expect(decodePairingRequest(genuine, { code, roomId, roomKey })).not.toBeNull()
    expect(decodePairingRequest(replayed, { code, roomId, roomKey })).toBeNull()
  })

  it('rejects a request for a different room', async () => {
    const { roomId, roomKey } = room()
    const code = createPairingCode()
    const event = encodePairingRequest({
      code,
      roomId: 'somewhere-else',
      roomKey,
      deviceSk: generateSecretKey(),
      now: NOW,
    })
    expect(decodePairingRequest(event, { code, roomId, roomKey })).toBeNull()
  })

  it('carries a credential to the requesting device and nothing else', async () => {
    const { roomId, roomKey } = room()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const credential = await createDeviceCredential({
      identity: localIdentity(participantSk),
      devicePubkey: getPublicKey(phoneSk),
      roomId,
      expiresAt: NOW + 3600,
    })
    const event = encodePairingGrant(credential, { roomId, roomKey, deviceSk: laptopSk })

    // The participant secret must not be anywhere on the wire, in any
    // encoding - this is the property the old pairing link broke.
    const wire = JSON.stringify(event)
    expect(wire).not.toContain(bytesToHex(participantSk))
    expect(wire).not.toContain(getPublicKey(participantSk))

    const decoded = decodePairingGrant(event, {
      roomId,
      roomKey,
      device: getPublicKey(phoneSk),
      now: NOW,
    })
    expect(decoded).not.toBeNull()
    expect(verifyDeviceCredential(decoded!, { roomId, now: NOW })).toMatchObject({
      ok: true,
      participant: getPublicKey(participantSk),
      device: getPublicKey(phoneSk),
    })
  })

  it('ignores a grant addressed to a different device', async () => {
    const { roomId, roomKey } = room()
    const credential = await createDeviceCredential({
      identity: localIdentity(generateSecretKey()),
      devicePubkey: getPublicKey(generateSecretKey()),
      roomId,
      expiresAt: NOW + 3600,
    })
    const event = encodePairingGrant(credential, { roomId, roomKey, deviceSk: generateSecretKey() })
    expect(
      decodePairingGrant(event, { roomId, roomKey, device: getPublicKey(generateSecretKey()), now: NOW }),
    ).toBeNull()
  })
})

describe('the pairing exchange', () => {
  it('gets the second device a credential without ever moving the participant key', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = room()
    const participantSk = generateSecretKey()
    const laptopSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const code = createPairingCode()

    const host = hostPairing({
      transport: new SimTransport(relay),
      roomId,
      roomKey,
      code,
      identity: localIdentity(participantSk),
      deviceSk: laptopSk,
      now,
    })

    const credential = await requestPairing({
      transport: new SimTransport(relay),
      roomId,
      roomKey,
      code,
      deviceSk: phoneSk,
      now,
    })
    host.close()

    expect(verifyDeviceCredential(credential, { roomId, now: NOW })).toMatchObject({
      ok: true,
      participant: getPublicKey(participantSk),
      device: getPublicKey(phoneSk),
    })
    // Nothing published during the whole exchange may contain the
    // participant secret key.
    const wire = JSON.stringify(relay.published)
    expect(wire).not.toContain(bytesToHex(participantSk))
  })

  it('mints a credential that expires, scoped to this room only', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = room()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const code = createPairingCode()

    const host = hostPairing({
      transport: new SimTransport(relay),
      roomId,
      roomKey,
      code,
      identity: localIdentity(participantSk),
      deviceSk: generateSecretKey(),
      ttlSeconds: 900,
      now,
    })
    const credential = await requestPairing({
      transport: new SimTransport(relay),
      roomId,
      roomKey,
      code,
      deviceSk: phoneSk,
      now,
    })
    host.close()

    expect(credential.tags).toContainEqual(['expiration', String(NOW + 900)])
    expect(credential.tags).toContainEqual(['d', roomId])
    expect(verifyDeviceCredential(credential, { roomId, now: NOW + 901 })).toMatchObject({
      ok: false,
      reason: 'expired',
    })
    expect(verifyDeviceCredential(credential, { roomId: 'another-room', now: NOW })).toMatchObject({
      ok: false,
      reason: 'wrong room',
    })
  })

  it('never answers a request that does not carry the code', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = room()
    const transport = new SimTransport(relay)

    const host = hostPairing({
      transport,
      roomId,
      roomKey,
      code: createPairingCode(),
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
    })

    await expect(
      requestPairing({
        transport,
        roomId,
        roomKey,
        code: createPairingCode(),
        deviceSk: generateSecretKey(),
        now,
        timeoutMs: 30,
        retryMs: 10,
      }),
    ).rejects.toThrow('pairing timed out')
    host.close()
  })

  it('lets the primary device refuse a request it did not expect', async () => {
    const relay = new SimRelay()
    const { roomId, roomKey } = room()
    const transport = new SimTransport(relay)
    const code = createPairingCode()
    const asked: string[] = []

    const host = hostPairing({
      transport,
      roomId,
      roomKey,
      code,
      identity: localIdentity(generateSecretKey()),
      deviceSk: generateSecretKey(),
      now,
      approve: (device) => {
        asked.push(device)
        return false
      },
    })

    const phoneSk = generateSecretKey()
    await expect(
      requestPairing({ transport, roomId, roomKey, code, deviceSk: phoneSk, now, timeoutMs: 30, retryMs: 10 }),
    ).rejects.toThrow('pairing timed out')
    host.close()

    expect(asked).toContain(getPublicKey(phoneSk))
  })
})
