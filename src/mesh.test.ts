import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Mesh } from './mesh.js'
import type { MeshSession } from './mesh.js'
import { wrapSignal } from './signal.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { ParticipantView } from './session.js'

function device(): { sk: Uint8Array; pub: string } {
  const sk = generateSecretKey()
  return { sk, pub: getPublicKey(sk) }
}

function view(participant: string, devices: string[]): ParticipantView {
  return { participant, devices, tracks: [] }
}

/**
 * A fully controllable double for the slice of `RoomSession` Mesh actually
 * touches. The real thing never shrinks its roster (stage 1 has no device
 * departure), so a device-loss test needs a double that can be told to.
 */
class FakeSession implements MeshSession {
  #views: ParticipantView[] = []
  #listeners = new Set<(views: ParticipantView[]) => void>()

  participants(): ParticipantView[] {
    return this.#views
  }

  onChange(cb: (views: ParticipantView[]) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  /** Test-only: set the roster and notify, exactly as a real ingest would. */
  setViews(views: ParticipantView[]): void {
    this.#views = views
    for (const listener of this.#listeners) listener(views)
  }
}

/** Deterministically drain the microtask queue - no real timers, so no
 *  flakiness, unlike a fixed setTimeout wait. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const ROOM_ID = 'room-1'

describe('Mesh', () => {
  it('creates exactly one peer when the roster gains a remote device', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    const remoteParticipant = device().pub
    const remote = device()
    session.setViews([view(remoteParticipant, [remote.pub])])

    expect(factory.instances).toHaveLength(1)
    mesh.close()
  })

  it('creates NO peer for a second device of our own participant', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const ownParticipant = device().pub
    const otherOwnDevice = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: ownParticipant, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    session.setViews([view(ownParticipant, [local.pub, otherOwnDevice.pub])])

    expect(factory.instances).toHaveLength(0)
    mesh.close()
  })

  it('creates NO peer for our own other device before our own entry arrives', () => {
    // The production join window: join() publishes our roster entry and
    // constructs Mesh immediately, but the relay has not echoed our own
    // entry back yet - so the only view of our participant on the roster is
    // our OTHER device. Inferring "my devices" from whichever view already
    // contains localDevice finds nothing here and opens a peer to ourselves,
    // which is the phone uploading its screen share back to its own laptop.
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const ownParticipant = device().pub
    const otherOwnDevice = device()
    const mesh = new Mesh({
      session,
      factory,
      localDevice: local.pub,
      localParticipant: ownParticipant,
      deviceSk: local.sk,
      transport: new SimTransport(relay),
      roomId: ROOM_ID,
    })

    session.setViews([view(ownParticipant, [otherOwnDevice.pub])])

    expect(factory.instances).toHaveLength(0)
    mesh.close()
  })

  it('closes and removes the peer when the roster loses a device', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const remoteParticipant = device().pub
    const remote = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    session.setViews([view(remoteParticipant, [remote.pub])])
    expect(factory.instances).toHaveLength(1)
    const pc = factory.instances[0]!
    expect(pc.closed).toBe(false)

    session.setViews([])

    expect(pc.closed).toBe(true)

    // Rejoining creates a genuinely new peer, proving the old one was removed
    // from bookkeeping rather than merely closed-but-still-tracked.
    session.setViews([view(remoteParticipant, [remote.pub])])
    expect(factory.instances).toHaveLength(2)

    mesh.close()
  })

  it('attributes a remote track to the participant, not the device', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const remoteParticipant = device().pub
    const remote = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    const received: { participant: string; device: string; track: MediaStreamTrack }[] = []
    mesh.onRemoteTrack((t) => received.push(t))

    session.setViews([view(remoteParticipant, [remote.pub])])

    const pc = factory.instances[0]!
    const track = {} as MediaStreamTrack
    pc.ontrack?.({ track })

    expect(received).toEqual([{ participant: remoteParticipant, device: remote.pub, track }])
    mesh.close()
  })

  it('gives two devices of one remote participant two peers but one participant in attribution', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const remoteParticipant = device().pub
    const remoteA = device()
    const remoteB = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    const received: { participant: string; device: string }[] = []
    mesh.onRemoteTrack((t) => received.push({ participant: t.participant, device: t.device }))

    session.setViews([view(remoteParticipant, [remoteA.pub, remoteB.pub])])
    expect(factory.instances).toHaveLength(2)

    factory.instances[0]!.ontrack?.({ track: {} as MediaStreamTrack })
    factory.instances[1]!.ontrack?.({ track: {} as MediaStreamTrack })

    expect(received).toHaveLength(2)
    expect(received.every((r) => r.participant === remoteParticipant)).toBe(true)
    expect(new Set(received.map((r) => r.device))).toEqual(new Set([remoteA.pub, remoteB.pub]))
    mesh.close()
  })

  it('ignores a signal for a device it does not know about, without throwing', () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const stranger = device() // never appears in the roster, so unknown to the mesh
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    const wrap = wrapSignal(
      { type: 'ice', roomId: ROOM_ID, candidate: 'irrelevant' },
      { senderSk: stranger.sk, recipientPubkey: local.pub },
    )

    expect(() => relay.publish(wrap)).not.toThrow()
    expect(factory.instances).toHaveLength(0)
    mesh.close()
  })

  it('two meshes wired through a shared relay actually exchange signals', async () => {
    const relay = new SimRelay()
    const factoryA = createFakeFactory()
    const factoryB = createFakeFactory()
    const a = device()
    const b = device()
    const participantA = device().pub
    const participantB = device().pub
    const sessionA = new FakeSession()
    const sessionB = new FakeSession()

    const meshA = new Mesh({ session: sessionA, factory: factoryA, localDevice: a.pub, localParticipant: participantA, deviceSk: a.sk, transport: new SimTransport(relay), roomId: ROOM_ID })
    const meshB = new Mesh({ session: sessionB, factory: factoryB, localDevice: b.pub, localParticipant: participantB, deviceSk: b.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    const roster = [view(participantA, [a.pub]), view(participantB, [b.pub])]
    sessionA.setViews(roster)
    sessionB.setViews(roster)

    await flush()

    const pcA = factoryA.instances[0]!
    const pcB = factoryB.instances[0]!

    // Both sides offered simultaneously (glare). Whichever pubkey sorts
    // lower is polite and ends up applying the other's offer as a remote
    // description after rollback; the impolite side applies the answer it
    // gets back. Either way, both connections end up with a remote
    // description set - that is the signal actually made the round trip.
    expect(pcA.calls.some((c) => c.method === 'setRemoteDescription')).toBe(true)
    expect(pcB.calls.some((c) => c.method === 'setRemoteDescription')).toBe(true)

    meshA.close()
    meshB.close()
  })
})
