import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { createDeviceCredential } from './credential.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { encodeRosterEvent } from './roster.js'
import { deriveRoom } from './room.js'
import { RoomSession } from './session.js'
import { spryDevicePublicKey } from './spry-key.js'

const NOW = 1_800_000_000
const SECRET = new Uint8Array(32).fill(95)
const ROOT = deriveRoom(SECRET)
const opened: RoomSession[] = []
const relays: SimRelay[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(session => session.leave()))
  for (const relay of relays.splice(0)) relay.close()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('spryKey in the own roster entry and spryRoster()', () => {
  it('announces the device\'s room Spry key and lists every present device with or without one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const relay = new SimRelay()
    relays.push(relay)
    const deviceSk = generateSecretKey()
    const session = new RoomSession({ transport: new SimTransport(relay), secret: SECRET,
      identity: localIdentity(generateSecretKey()), deviceSk, factory: createFakeFactory(),
      now: () => Math.floor(Date.now() / 1000), announceJitterMs: 0,
      timing: { heartbeatIntervalMs: 1000, sweepIntervalMs: 1000 } })
    opened.push(session)
    await session.join([], {})
    await vi.advanceTimersByTimeAsync(50)
    const own = spryDevicePublicKey(deviceSk)
    expect(session.spryRoster()).toContainEqual(expect.objectContaining({ device: getPublicKey(deviceSk), spryKey: own, agent: false }))

    // An older client: an entry with no spryKey.
    const oldIdentity = localIdentity(generateSecretKey()), oldSk = generateSecretKey()
    const credential = await createDeviceCredential({ identity: oldIdentity, devicePubkey: getPublicKey(oldSk), roomId: ROOT.roomId, expiresAt: NOW + 3600 })
    const event = encodeRosterEvent({ participant: oldIdentity.pubkey, device: getPublicKey(oldSk), credential, tracks: [], claims: {}, updatedAt: NOW },
      { roomId: ROOT.roomId, roomKey: ROOT.roomKey, deviceSk: oldSk })
    expect(nip44.v2.decrypt(event.content, ROOT.roomKey)).not.toContain('spryKey')
    await new SimTransport(relay).publish(event)
    await vi.advanceTimersByTimeAsync(50)
    const old = session.spryRoster().find(row => row.device === getPublicKey(oldSk))
    expect(old).toEqual({ device: getPublicKey(oldSk), participant: oldIdentity.pubkey, agent: false })

    // Removed participants are not listed.
    session.forgetParticipants([oldIdentity.pubkey])
    expect(session.spryRoster().some(row => row.participant === oldIdentity.pubkey)).toBe(false)
  })
})
