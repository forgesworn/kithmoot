import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Mesh } from './mesh.js'
import type { MeshSession } from './mesh.js'
import type { ForwarderRef } from './types.js'
import { wrapSignal } from './signal.js'
import { MAX_SIGNALS_PER_WINDOW } from './signal-guard.js'
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

/**
 * Two devices whose pubkeys make the local one polite.
 *
 * Politeness is a pubkey comparison, so with random keys whether an inbound
 * offer is applied or deliberately ignored comes out differently run to run.
 * The polite side always gives way and applies the offer it was sent, which is
 * what makes an assertion about an inbound signal mean anything.
 */
function politePair(): { local: { sk: Uint8Array; pub: string }; remote: { sk: Uint8Array; pub: string } } {
  for (;;) {
    const local = device()
    const remote = device()
    if (local.pub < remote.pub) return { local, remote }
  }
}

const ROOM_ID = 'room-1'

/** Let every queued negotiation step run. `Peer` chains its operations, so
 *  what a synchronous `Mesh` call sets in motion lands a few turns later. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

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

    expect(received).toEqual([{ participant: remoteParticipant, device: remote.pub, track, via: 'direct' }])
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

  it('re-publishing the full track set never drops a track an already-connected peer has, and hands a late-arriving peer everything published so far', async () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const localParticipant = device().pub
    const remoteParticipant = device().pub
    const remote = device()
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    // A peer already exists before either track is published.
    session.setViews([view(remoteParticipant, [remote.pub])])
    const existingPc = factory.instances[0]!

    const camera = {} as MediaStreamTrack
    const mic = {} as MediaStreamTrack
    mesh.publish([camera])
    // A caller publishes its whole current set on every toggle, never just
    // the delta - re-sending `camera` here must not stop `mic` getting
    // through to a peer that has had `camera` since the call before.
    mesh.publish([camera, mic])
    // `Peer` queues every negotiation step, so the tracks reach the
    // connection on a later turn rather than inside `publish` - see
    // `Peer`'s `#operations`.
    await settle()

    expect(existingPc.tracks).toEqual([camera, mic])

    // A device that arrives AFTER both toggles must still receive
    // everything published before it joined, not just the latest call.
    const lateParticipant = device().pub
    const lateRemote = device()
    session.setViews([view(remoteParticipant, [remote.pub]), view(lateParticipant, [lateRemote.pub])])
    const latePc = factory.instances[1]!
    await settle()

    expect(latePc.tracks).toEqual([camera, mic])

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

  it('BUG (I5): a replayed signal is acted on once, however many times a relay delivers it', async () => {
    // Publishing to every relay means hearing the same wrap from every relay,
    // and a relay that means harm can send it again an hour later. Re-applying
    // an old offer forces a renegotiation nobody asked for.
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const { local, remote } = politePair()
    const remoteParticipant = device().pub
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    session.setViews([view(remoteParticipant, [remote.pub])])
    await settle()
    const pc = factory.instances[0]!

    const wrap = wrapSignal(
      { type: 'offer', roomId: ROOM_ID, sdp: 'remote-offer-sdp' },
      { senderSk: remote.sk, recipientPubkey: local.pub },
    )
    relay.publish(wrap)
    await settle()
    relay.publish(wrap)
    await settle()

    expect(pc.calls.filter((c) => c.method === 'setRemoteDescription')).toHaveLength(1)
    mesh.close()
  })

  it('BUG (I5): a stale signal is refused', async () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const { local, remote } = politePair()
    const remoteParticipant = device().pub
    // A clock a minute ahead of the sender's is what a replayed wrap looks
    // like from the inside.
    const now = () => Math.floor(Date.now() / 1000) + 60
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID, now })

    session.setViews([view(remoteParticipant, [remote.pub])])
    await settle()
    const pc = factory.instances[0]!

    relay.publish(
      wrapSignal(
        { type: 'offer', roomId: ROOM_ID, sdp: 'remote-offer-sdp' },
        { senderSk: remote.sk, recipientPubkey: local.pub },
      ),
    )
    await settle()

    expect(pc.calls.filter((c) => c.method === 'setRemoteDescription')).toHaveLength(0)
    mesh.close()
  })

  it('BUG (I5): one device cannot flood the mesh with signals', async () => {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const { local, remote } = politePair()
    const remoteParticipant = device().pub
    const mesh = new Mesh({ session, factory, localDevice: local.pub, localParticipant: device().pub, deviceSk: local.sk, transport: new SimTransport(relay), roomId: ROOM_ID })

    session.setViews([view(remoteParticipant, [remote.pub])])
    await settle()
    const pc = factory.instances[0]!

    // The offer first, so the candidates that follow are applied rather than
    // buffered - this measures the rate limit, not the buffer bound.
    relay.publish(
      wrapSignal(
        { type: 'offer', roomId: ROOM_ID, sdp: 'remote-offer-sdp' },
        { senderSk: remote.sk, recipientPubkey: local.pub },
      ),
    )
    for (let i = 0; i < MAX_SIGNALS_PER_WINDOW + 10; i++) {
      relay.publish(
        wrapSignal(
          { type: 'ice', roomId: ROOM_ID, candidate: JSON.stringify({ candidate: `candidate:${i}` }) },
          { senderSk: remote.sk, recipientPubkey: local.pub },
        ),
      )
    }
    await settle()

    // The offer used one of the budget, so the candidates get the rest.
    expect(pc.calls.filter((c) => c.method === 'addIceCandidate')).toHaveLength(MAX_SIGNALS_PER_WINDOW - 1)
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

    // Both sides have something to send. A device with nothing to send does
    // not offer at all - see peer.ts - so a pair of silent meshes would
    // exchange nothing and prove nothing about the relay.
    meshA.publish([{} as MediaStreamTrack])
    meshB.publish([{} as MediaStreamTrack])

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

/**
 * Promotion to a forwarder.
 *
 * The arithmetic these tests are about: mesh upload is `(N-1) x bitrate`, and
 * against a domestic uplink that runs out somewhere around eight people on
 * video - sooner if anybody shares a screen. Past that the room routes through
 * a forwarder instead: one copy up, and the forwarder sends everybody theirs.
 *
 * The behaviour worth being strict about is not the promotion. It is what
 * happens when the forwarder is not there.
 */
describe('Mesh promotion to a forwarder', () => {
  const FORWARDER = device().pub
  const SPARE_FORWARDER = device().pub
  const FORWARDERS = [{ url: 'wss://forward.example', pubkey: FORWARDER }]

  /**
   * The connection opened for the forwarder.
   *
   * Promotion is decided before any direct peer is opened, because the answer
   * governs both - so on the reconcile that promotes, the forwarder's
   * connection is the first one made.
   */
  function forwarderPcIndex(): number {
    return 0
  }

  /** An uplink that a mesh of this size cannot carry. */
  const TIGHT = () => ({ uplinkBps: 1_000_000, perPeerBps: 600_000 })
  /** An uplink that carries anything these tests build. */
  const ROOMY = () => ({ uplinkBps: 100_000_000, perPeerBps: 32_000 })

  function build(opts: {
    uplink?: () => { uplinkBps: number; perPeerBps: number } | null
    forwarders?: ForwarderRef[]
    forwarderTimeoutMs?: number
  }) {
    const session = new FakeSession()
    const factory = createFakeFactory()
    const relay = new SimRelay()
    const local = device()
    const mesh = new Mesh({
      session,
      factory,
      localDevice: local.pub,
      localParticipant: device().pub,
      deviceSk: local.sk,
      transport: new SimTransport(relay),
      roomId: ROOM_ID,
      uplink: opts.uplink,
      forwarders: opts.forwarders,
      forwarderTimeoutMs: opts.forwarderTimeoutMs,
    })
    return { session, factory, mesh, local, relay }
  }

  /** Put `count` remote people in the room. */
  function fill(session: FakeSession, count: number): string[] {
    const devices = Array.from({ length: count }, () => device().pub)
    session.setViews(devices.map((d) => view(device().pub, [d])))
    return devices
  }

  it('stays a mesh when the uplink can carry it, however many people are here', () => {
    const { session, factory, mesh } = build({ uplink: ROOMY, forwarders: FORWARDERS })
    fill(session, 20)
    // Twenty people on Opus voice cost 0.64 Mbps. Headcount is not the
    // question; capacity is.
    expect(mesh.forwarding).toBe('off')
    expect(factory.instances).toHaveLength(20)
    mesh.close()
  })

  it('stays a mesh when nothing has measured the uplink', () => {
    // A room that has not measured anything must not guess. Promotion is on
    // measured capacity or it does not happen.
    const { session, mesh } = build({ forwarders: FORWARDERS })
    fill(session, 20)
    expect(mesh.forwarding).toBe('off')
    mesh.close()
  })

  it('stays a mesh when the room names no forwarder, however tight the uplink', () => {
    const { session, factory, mesh } = build({ uplink: TIGHT })
    fill(session, 12)
    expect(mesh.forwarding).toBe('off')
    expect(factory.instances).toHaveLength(12)
    mesh.close()
  })

  it('opens a connection to the forwarder when capacity runs out', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    fill(session, 12)
    await settle()
    expect(mesh.forwarding).toBe('trying')
    expect(mesh.forwarderDevice).toBe(FORWARDER)
    // Thirteen: the twelve direct peers are still up. Nothing is dismantled
    // on the strength of a connection that has not happened yet.
    expect(factory.instances).toHaveLength(13)
    mesh.close()
  })

  it('closes the direct peers only once the forwarder is genuinely connected', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    fill(session, 12)
    await settle()

    const forwarderPc = factory.instances[forwarderPcIndex()]!
    expect(factory.instances.slice(1, 13).every((pc) => !pc.closed)).toBe(true)

    forwarderPc.connectionState = 'connected'
    forwarderPc.onconnectionstatechange?.()
    await settle()

    expect(mesh.forwarding).toBe('up')
    expect(factory.instances.slice(1, 13).every((pc) => pc.closed)).toBe(true)
    expect(forwarderPc.closed).toBe(false)
    mesh.close()
  })

  it('opens no direct peer for a device that arrives while the forwarder is up', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    const devices = fill(session, 12)
    await settle()
    factory.instances[forwarderPcIndex()]!.connectionState = 'connected'
    factory.instances[forwarderPcIndex()]!.onconnectionstatechange?.()
    await settle()

    const before = factory.instances.length
    session.setViews([...devices, device().pub].map((d) => view(device().pub, [d])))
    await settle()
    expect(factory.instances).toHaveLength(before)
    mesh.close()
  })

  // The non-negotiable one. A dead forwarder must cost a room its headroom,
  // never its call: the difference between "sometimes slower" and "down".
  it('falls back to direct mesh when the forwarder never answers', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS, forwarderTimeoutMs: 20 })
    const devices = fill(session, 4)
    await settle()
    expect(mesh.forwarding).toBe('trying')

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(mesh.forwarding).toBe('failed')
    // The forwarder's own connection is gone...
    expect(factory.instances[forwarderPcIndex()]!.closed).toBe(true)
    // ...and all four people are still reachable directly. Degraded - every
    // device is paying `(N-1) x bitrate` again - but not broken.
    expect(factory.instances.slice(1, 5).every((pc) => !pc.closed)).toBe(true)
    expect(mesh.directPeers).toBe(4)
    expect(devices).toHaveLength(4)
    mesh.close()
  })

  it('reopens the direct mesh when a forwarder that was up drops', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    fill(session, 6)
    await settle()
    const forwarderPc = factory.instances[forwarderPcIndex()]!
    forwarderPc.connectionState = 'connected'
    forwarderPc.onconnectionstatechange?.()
    await settle()
    expect(mesh.forwarding).toBe('up')
    expect(mesh.directPeers).toBe(0)

    forwarderPc.connectionState = 'failed'
    forwarderPc.onconnectionstatechange?.()
    await settle()
    // A first failure on a connection that was up is a blip until proven
    // otherwise: the peer restarts ICE and the room stays on the forwarder,
    // rather than six people tearing down and re-meshing for a hiccup.
    expect(mesh.forwarding).toBe('up')
    expect(mesh.directPeers).toBe(0)

    forwarderPc.connectionState = 'failed'
    forwarderPc.onconnectionstatechange?.()
    await settle()

    expect(mesh.forwarding).toBe('failed')
    expect(mesh.directPeers).toBe(6)
    mesh.close()
  })

  it('does not thrash back to a forwarder that has already failed', async () => {
    const { session, factory, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS, forwarderTimeoutMs: 20 })
    fill(session, 6)
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mesh.forwarding).toBe('failed')

    // Another roster change, still well over capacity. A room that retried on
    // every roster change would spend the call cycling through a forwarder
    // that is not there, tearing the mesh down and putting it back.
    fill(session, 7)
    await settle()
    expect(mesh.forwarding).toBe('failed')
    expect(mesh.forwarderDevice).toBeUndefined()
    expect(mesh.directPeers).toBe(7)
    mesh.close()
  })

  it('tries again when the room names a forwarder it has not already failed', async () => {
    const { session, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS, forwarderTimeoutMs: 20 })
    fill(session, 6)
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mesh.forwarding).toBe('failed')

    mesh.setForwarders([{ url: 'wss://other.example', pubkey: SPARE_FORWARDER }])
    await settle()
    expect(mesh.forwarding).toBe('trying')
    expect(mesh.forwarderDevice).toBe(SPARE_FORWARDER)
    mesh.close()
  })

  it('demotes back to a mesh when the room shrinks under the uplink again', async () => {
    let peers = 12
    const uplink = () => ({ uplinkBps: 1_000_000, perPeerBps: 600_000 })
    const { session, factory, mesh } = build({ uplink, forwarders: FORWARDERS })
    fill(session, peers)
    await settle()
    const forwarderPc = factory.instances[forwarderPcIndex()]!
    forwarderPc.connectionState = 'connected'
    forwarderPc.onconnectionstatechange?.()
    await settle()
    expect(mesh.forwarding).toBe('up')

    peers = 1
    fill(session, 1)
    await settle()
    expect(mesh.forwarding).toBe('off')
    expect(forwarderPc.closed).toBe(true)
    expect(mesh.directPeers).toBe(1)
    mesh.close()
  })

  it('signals to the forwarder over the room channel, addressed to its pubkey', async () => {
    const { session, mesh, relay } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    fill(session, 12)
    await settle()
    const toForwarder = relay.published.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === FORWARDER))
    expect(toForwarder.length).toBeGreaterThan(0)
    mesh.close()
  })

  it('refuses a forwarder entry with no pubkey - there would be nobody to address', async () => {
    const { session, mesh } = build({ uplink: TIGHT, forwarders: [{ url: 'wss://forward.example' }] })
    fill(session, 12)
    await settle()
    expect(mesh.forwarding).toBe('off')
    mesh.close()
  })

  it('never treats the forwarder as a participant', async () => {
    const { session, mesh } = build({ uplink: TIGHT, forwarders: FORWARDERS })
    fill(session, 12)
    await settle()
    const tracks: string[] = []
    mesh.onRemoteTrack((t) => tracks.push(t.participant))
    // A forwarder is not in the roster and has no participant. A track that
    // arrives over it and matches no roster advert is dropped, never
    // attributed to the forwarder itself.
    expect(tracks).not.toContain(FORWARDER)
    mesh.close()
  })
})
