import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { createDeviceCredential } from './credential.js'
import { decodeRekeyEvent, deriveEpoch } from './epoch.js'
import { credentialSeal, generateSealKey } from './seal.js'
import { encodeRosterEvent } from './roster.js'
import { deriveRoom } from './room.js'
import { KINDS } from './kinds.js'
import type { DeviceCredential } from './types.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(23)
const { roomId, roomKey } = deriveRoom(SECRET)

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

function member(relay: SimRelay, opts: { participantSk?: Uint8Array; deviceSk?: Uint8Array; authority?: string; extra?: Record<string, unknown> } = {}) {
  return new RoomSession({
    transport: new SimTransport(relay),
    secret: SECRET,
    identity: localIdentity(opts.participantSk ?? generateSecretKey()),
    deviceSk: opts.deviceSk ?? generateSecretKey(),
    now,
    announceJitterMs: 0,
    authority: opts.authority,
    epochSettleMs: 0,
    ...opts.extra,
  } as ConstructorParameters<typeof RoomSession>[0])
}

describe('seal keys in the room session', () => {
  it('names a fresh seal key in its own credential, and hands its secret to keep', async () => {
    const minted: { credential: DeviceCredential; sealSk?: Uint8Array }[] = []
    const mine = member(new SimRelay(), { extra: { onCredential: (credential: DeviceCredential, sealSk?: Uint8Array) => minted.push({ credential, sealSk }) } })
    await mine.join([], {})
    const seal = credentialSeal(mine.credential!)
    expect(typeof seal).toBe('string')
    expect(minted).toHaveLength(1)
    expect(getPublicKey(minted[0]!.sealSk!)).toBe(seal)
    mine.leave()
  })

  it('a rekey copy for a member is sealed to its seal key: the device key alone does not open it', async () => {
    const relay = new SimRelay()
    const authoritySk = generateSecretKey()
    const authority = getPublicKey(authoritySk)
    const aliceDeviceSk = generateSecretKey()
    const keeper = member(relay, { authority })
    const alice = member(relay, { authority, deviceSk: aliceDeviceSk })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    expect(keeper.credentialFor(alice.device)?.id).toBe(alice.credential!.id)

    const rekeys: Event[] = []
    relay.subscribe([{ kinds: [KINDS.ROOM_REKEY] }], (event) => rekeys.push(event))
    await keeper.rekey({ authoritySk })
    await settle()
    expect(alice.epoch).toBe(1)

    // A thief with Alice's device key and nothing else reads who was
    // removed, and no secret.
    const copy = decodeRekeyEvent(rekeys[0]!, { roomId, authority, current: deriveEpoch({ epoch: 0, secret: SECRET }), deviceSk: aliceDeviceSk })
    expect(copy).not.toBeNull()
    expect(copy?.secret).toBeUndefined()
    keeper.leave()
    alice.leave()
  })

  it('never moves a device back to an older credential a roster entry replays', async () => {
    const relay = new SimRelay()
    const aliceSk = generateSecretKey()
    const aliceDeviceSk = generateSecretKey()
    const keeper = member(relay)
    const alice = member(relay, { participantSk: aliceSk, deviceSk: aliceDeviceSk })
    await keeper.join([], {})
    await alice.join([], {})
    await settle()
    const newest = keeper.credentialFor(alice.device)
    expect(newest?.id).toBe(alice.credential!.id)

    // The thief's replay: Alice's device key signing an entry that carries
    // an older credential, still live, under a seal key they hold.
    const older = await createDeviceCredential({
      identity: localIdentity(aliceSk),
      devicePubkey: alice.device,
      roomId,
      expiresAt: NOW + 600,
      seal: generateSealKey().pubkey,
      now: () => NOW - 60,
    })
    relay.publish(
      encodeRosterEvent(
        { participant: alice.participant, device: alice.device, credential: older, tracks: [], claims: {}, updatedAt: NOW + 1 },
        { roomId, roomKey, deviceSk: aliceDeviceSk },
      ),
    )
    await settle()
    expect(keeper.credentialFor(alice.device)?.id).toBe(newest!.id)
    keeper.leave()
    alice.leave()
  })

  it('resumes a credential naming a seal key only with that key\'s secret', async () => {
    const participantSk = generateSecretKey()
    const deviceSk = generateSecretKey()
    const seal = generateSealKey()
    const resume = await createDeviceCredential({
      identity: localIdentity(participantSk),
      devicePubkey: getPublicKey(deviceSk),
      roomId,
      expiresAt: NOW + 6 * 3600,
      seal: seal.pubkey,
      now,
    })
    const cases: [Uint8Array | undefined, boolean][] = [
      [undefined, false],
      [generateSealKey().secretKey, false],
      [seal.secretKey, true],
    ]
    for (const [kept, resumed] of cases) {
      const mine = member(new SimRelay(), { participantSk, deviceSk, extra: { resume, ...(kept ? { sealKeys: [generateSealKey().secretKey, kept] } : {}) } })
      await mine.join([], {})
      expect(mine.credential?.id === resume.id).toBe(resumed)
      mine.leave()
    }
  })
})
