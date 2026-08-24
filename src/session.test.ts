import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { RoomSession } from './session.js'
import { issueKindredProof } from './access.js'

const NOW = 1_800_000_000
const now = () => NOW

function secret() {
  return new Uint8Array(32).fill(11)
}

describe('RoomSession', () => {
  it('groups two devices of one participant into a single view', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)

    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: phoneSk,
      now,
    })
    const laptop = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: laptopSk,
      now,
    })
    const observer = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })

    await observer.join([], {})
    await phone.join([{ trackId: 'cam', role: 'camera' }, { trackId: 'mic', role: 'mic' }], { mic: NOW })
    await laptop.join([{ trackId: 'scr', role: 'screen' }], {})

    const views = observer.participants()
    const mine = views.find((v) => v.participant === participant)

    expect(mine).toBeDefined()
    expect(mine!.devices.sort()).toEqual([getPublicKey(phoneSk), getPublicKey(laptopSk)].sort())
    expect(mine!.tracks.map((t) => t.role).sort()).toEqual(['camera', 'mic', 'screen'])
  })

  it('reports two participants as two views, not four devices', async () => {
    const relay = new SimRelay()
    const alice = generateSecretKey()
    const bob = generateSecretKey()

    const sessions = [
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: alice, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: alice, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: bob, deviceSk: generateSecretKey(), now }),
      new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: bob, deviceSk: generateSecretKey(), now }),
    ]
    const observerSk = generateSecretKey()
    const observerParticipant = getPublicKey(observerSk)
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: observerSk, deviceSk: generateSecretKey(), now })
    await observer.join([], {})
    for (const s of sessions) await s.join([], {})

    // Capture the observer's own pubkey before asserting, and filter against
    // that - not a freshly generated key, which would never match anything
    // and let this assertion pass no matter what participants() returned.
    const others = observer.participants().filter((v) => v.participant !== observerParticipant)
    expect(others).toHaveLength(2)
    expect(others.filter((v) => v.participant === getPublicKey(alice))).toHaveLength(1)
    expect(others.filter((v) => v.participant === getPublicKey(bob))).toHaveLength(1)
  })

  it('resolves the mic to exactly one device', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()
    const phoneSk = generateSecretKey()
    const laptopSk = generateSecretKey()

    const phone = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk, deviceSk: phoneSk, now })
    const laptop = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk, deviceSk: laptopSk, now })
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })

    await observer.join([], {})
    await phone.join([], { mic: NOW })
    await laptop.join([], { mic: NOW + 10 })

    const view = observer.participants().find((v) => v.participant === getPublicKey(participantSk))
    expect(view!.mic).toBe(getPublicKey(laptopSk))
  })

  it('ignores roster events from a different room', async () => {
    const relay = new SimRelay()
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    await observer.join([], {})

    const otherRoom = new RoomSession({
      transport: new SimTransport(relay),
      secret: new Uint8Array(32).fill(99),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })
    await otherRoom.join([], {})

    expect(observer.participants()).toHaveLength(1)
  })

  it('notifies subscribers when the roster changes', async () => {
    const relay = new SimRelay()
    const observer = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    const counts: number[] = []
    observer.onChange((views) => counts.push(views.length))
    await observer.join([], {})

    const joiner = new RoomSession({ transport: new SimTransport(relay), secret: secret(), participantSk: generateSecretKey(), deviceSk: generateSecretKey(), now })
    await joiner.join([], {})

    expect(counts.at(-1)).toBe(2)
  })
})

describe('RoomSession access policy', () => {
  it('refuses to join a kith-gated room when the joiner carries no kindred proof', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
      policy: { tier: 'kith', admitted: [getPublicKey(hostSk)] },
    })

    await expect(session.join([], {})).rejects.toThrow('no kindred proof')
    expect(relay.published).toHaveLength(0)
  })

  it('admits a joiner carrying a valid kindred proof to a kith-gated room', async () => {
    const relay = new SimRelay()
    const hostSk = generateSecretKey()
    const participantSk = generateSecretKey()
    const participant = getPublicKey(participantSk)
    const proof = issueKindredProof({ hostSk, participant, tier: 'kith', expiresAt: NOW + 3600 })

    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: generateSecretKey(),
      now,
      policy: { tier: 'kith', admitted: [getPublicKey(hostSk)] },
      proof,
    })

    await expect(session.join([], {})).resolves.toBeUndefined()
    expect(relay.published).toHaveLength(1)
  })
})

describe('RoomSession media', () => {
  it('publishes tracks to every remote device but never to its own other devices', async () => {
    const relay = new SimRelay()
    const participantSk = generateSecretKey()

    const factoryA = createFakeFactory()

    const a = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: generateSecretKey(),
      now,
      factory: factoryA,
    })
    // A second device of the SAME participant - must never get a peer.
    const b = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk,
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })
    // A different participant entirely - must get a peer.
    const stranger = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })

    await a.join([], {})
    await b.join([], {})
    await stranger.join([], {})

    // Exactly one peer: for the stranger's device. None for our own second device.
    expect(factoryA.instances).toHaveLength(1)

    const track = {} as MediaStreamTrack
    a.publishTracks([track])

    expect(factoryA.instances[0]!.tracks).toContain(track)
  })

  it('surfaces remote tracks grouped by participant, not by device', async () => {
    const relay = new SimRelay()
    const factory = createFakeFactory()

    const local = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
      factory,
    })

    const remoteParticipantSk = generateSecretKey()
    const remoteParticipant = getPublicKey(remoteParticipantSk)
    const remoteA = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: remoteParticipantSk,
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })
    const remoteB = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: remoteParticipantSk,
      deviceSk: generateSecretKey(),
      now,
      factory: createFakeFactory(),
    })

    await local.join([], {})
    await remoteA.join([], {})
    await remoteB.join([], {})

    const received: { participant: string; device: string }[] = []
    local.onRemoteTrack((t) => received.push({ participant: t.participant, device: t.device }))

    expect(factory.instances).toHaveLength(2)
    factory.instances[0]!.ontrack?.({ track: {} as MediaStreamTrack })
    factory.instances[1]!.ontrack?.({ track: {} as MediaStreamTrack })

    expect(received).toHaveLength(2)
    expect(received.every((r) => r.participant === remoteParticipant)).toBe(true)
  })

  it('is safe to call publishTracks and onRemoteTrack when no factory was supplied', async () => {
    const relay = new SimRelay()
    const session = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })
    await session.join([], {})

    expect(() => session.publishTracks([{} as MediaStreamTrack])).not.toThrow()
    const unsub = session.onRemoteTrack(() => {})
    expect(() => unsub()).not.toThrow()
  })
})

describe('RoomSession chat', () => {
  it('exposes a chat log that round-trips a message between two sessions', async () => {
    const relay = new SimRelay()
    const a = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })
    const b = new RoomSession({
      transport: new SimTransport(relay),
      secret: secret(),
      participantSk: generateSecretKey(),
      deviceSk: generateSecretKey(),
      now,
    })

    await a.join([], {})
    await b.join([], {})

    await a.chat.send('hello')

    expect(b.chat.messages().map((m) => m.text)).toEqual(['hello'])
  })
})
