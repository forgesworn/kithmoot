import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Mesh } from './mesh.js'
import type { MeshOptions, MeshSession, RouteView } from './mesh.js'
import { PeerRelay } from './peer-relay.js'
import type { RelayLeg, RelayMediaPipeline } from './peer-relay.js'
import { MAX_ASSISTED_PAIRS } from './peer-assist.js'
import { unwrapSignal, wrapSignal } from './signal.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { ParticipantView } from './session.js'
import type { AssistOffer } from './types.js'

function device(): { sk: Uint8Array; pub: string } {
  const sk = generateSecretKey()
  return { sk, pub: getPublicKey(sk) }
}

const ROOM_ID = 'room-6'

/** A volunteer's offer: publicly reachable, plenty of room. */
function offer(over: Partial<AssistOffer> = {}): AssistOffer {
  return {
    reachability: 'public',
    capacity: { uplinkBps: 100_000_000, peers: 2, perPeerBps: 600_000 },
    relaying: 0,
    maxRelayed: MAX_ASSISTED_PAIRS,
    ...over,
  }
}

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

  setViews(views: ParticipantView[]): void {
    this.#views = views
    for (const listener of this.#listeners) listener(views)
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One person, one device, optionally volunteering. */
function person(pub: string, assist?: AssistOffer): ParticipantView {
  const view: ParticipantView = { participant: `p-${pub.slice(0, 8)}`, devices: [pub], tracks: [] }
  if (assist) view.assist = [{ ...assist, device: pub }]
  return view
}

interface Harness {
  mesh: Mesh
  session: FakeSession
  relay: SimRelay
  factory: ReturnType<typeof createFakeFactory>
  local: { sk: Uint8Array; pub: string }
  routes: Array<{ device: string; route: RouteView }>
  /** Report a connection state for the connection currently open to `device`. */
  state(device: string, state: RTCPeerConnectionState): void
  /** Everything this mesh has published, decoded far enough to assert on. */
  close(): void
}

function harness(over: Partial<MeshOptions> = {}, factoryOptions: Parameters<typeof createFakeFactory>[0] = {}): Harness {
  const session = new FakeSession()
  const factory = createFakeFactory(factoryOptions)
  const relay = new SimRelay()
  const local = device()
  const routes: Array<{ device: string; route: RouteView }> = []

  const mesh = new Mesh({
    session,
    factory,
    localDevice: local.pub,
    localParticipant: device().pub,
    deviceSk: local.sk,
    transport: new SimTransport(relay),
    roomId: ROOM_ID,
    // Long enough that no test is racing a timer it did not ask for.
    routeTimeoutMs: 60_000,
    // This harness exercises an already verified media integration. The
    // production default deliberately does not opt in to server forwarding.
    forwarderMedia: () => true,
    forwarderMediaPipeline: { rekey: () => true, protectSender: () => true, protectReceiver: () => true },
    onRoute: (d, route) => routes.push({ device: d, route }),
    ...over,
  })

  return {
    mesh,
    session,
    relay,
    factory,
    local,
    routes,
    state(target, state) {
      const pc = factory.to(target)
      if (!pc) throw new Error(`no open connection to ${target.slice(0, 8)}`)
      pc.connectionState = state
      pc.onconnectionstatechange?.()
    },
    close: () => mesh.close(),
  }
}

/** The assist signals this mesh has published, newest last. */
function assistSignals(relay: SimRelay, recipientSk: Uint8Array): Array<{ assist?: string; accept?: boolean }> {
  const out: Array<{ assist?: string; accept?: boolean }> = []
  for (const event of relay.published) {
    // Decoded through the real unwrap, so a test cannot pass on a signal a
    // real recipient would reject.
    const unwrapped = unwrap(event, recipientSk)
    if (unwrapped?.body.type === 'assist') out.push({ assist: unwrapped.body.assist, accept: unwrapped.body.accept })
  }
  return out
}

function unwrap(event: Parameters<typeof unwrapSignal>[0], sk: Uint8Array) {
  return unwrapSignal(event, { recipientSk: sk, roomId: ROOM_ID })
}

/** The full assist signals this mesh has published to one recipient. */
function assistBodies(relay: SimRelay, recipientSk: Uint8Array): Array<{ assist?: string; accept?: boolean; release?: true }> {
  const out: Array<{ assist?: string; accept?: boolean; release?: true }> = []
  for (const event of relay.published) {
    const unwrapped = unwrap(event, recipientSk)
    if (unwrapped?.body.type === 'assist') out.push({ assist: unwrapped.body.assist, accept: unwrapped.body.accept, release: unwrapped.body.release })
  }
  return out
}

/** A pump that records what it was asked to carry, as the app's would. */
function fakePipeline(ready = true): RelayMediaPipeline & { legs: RelayLeg[]; closed: RelayLeg[]; prepared: unknown[] } {
  const legs: RelayLeg[] = []
  const closed: RelayLeg[] = []
  const prepared: unknown[] = []
  return {
    ready,
    legs,
    closed,
    prepared,
    prepare: (receiver) => void prepared.push(receiver),
    carry: (leg) => {
      legs.push(leg)
      return { close: () => void closed.push(leg) }
    },
  }
}

/** A track good enough to be cloned into a clock and stopped. */
function mediaTrack(id: string, kind: 'audio' | 'video' = 'video'): MediaStreamTrack {
  const track = {
    id,
    kind,
    muted: false,
    readyState: 'live' as MediaStreamTrackState,
    ended: 0,
    clone: () => mediaTrack(`${id}-clock`, kind),
    stop: () => {
      track.readyState = 'ended'
    },
    dispatchEvent: (event: Event) => {
      if (event.type === 'ended') track.ended += 1
      return true
    },
  }
  return track as unknown as MediaStreamTrack
}

/** A receiver whose inbound byte count a test moves by hand. */
function receiver(): { bytes: number; getStats(): Promise<Map<string, Record<string, unknown>>> } {
  const r = {
    bytes: 0,
    getStats: async () => new Map([['in', { type: 'inbound-rtp', bytesReceived: r.bytes }]]),
  }
  return r
}

function signal(h: Harness, from: { sk: Uint8Array; pub: string }, body: Omit<Parameters<typeof wrapSignal>[0], 'roomId'>): void {
  h.relay.publish(wrapSignal({ ...body, roomId: ROOM_ID } as Parameters<typeof wrapSignal>[0], { senderSk: from.sk, recipientPubkey: h.local.pub }))
}


describe('the route ladder', () => {
  it('starts direct, and stays there while direct works', async () => {
    const h = harness()
    const remote = device()
    h.session.setViews([person(remote.pub)])
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'direct', endpoint: remote.pub })
    // The connection was asked for on the direct rung, which is what lets an
    // app keep TURN out of the ICE list until it is actually needed.
    expect(h.factory.to(remote.pub)?.context?.tier).toBe('direct')
    h.close()
  })

  it('tries a volunteer before a forwarder, and a forwarder before TURN', async () => {
    const volunteer = device()
    const remote = device()
    const forwarder = device()
    const h = harness({ forwarders: [{ url: 'wss://relay.example', pubkey: forwarder.pub }] })

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')

    // The direct connection to `remote` gives up.
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', endpoint: volunteer.pub })
    // ...and no forwarder was promoted on the way past it.
    expect(h.mesh.forwarding).toBe('off')
    h.close()
  })

  it('asks the volunteer, by name, over the ordinary signalling path', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    expect(assistSignals(h.relay, volunteer.sk)).toEqual([{ assist: remote.pub, accept: undefined }])
    h.close()
  })

  it('opens no second connection to the volunteer, because it already has one', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    const before = h.factory.instances.length

    h.state(remote.pub, 'failed')
    await settle()

    // Assist reuses the connection to a publicly reachable member. A second
    // one would glare with the first, since politeness is decided per device
    // pair and both would be the same pair.
    expect(h.factory.instances.length).toBe(before)
    expect(h.mesh.directPeers).toBe(1)
    h.close()
  })

  it('will not route through a volunteer it cannot reach itself', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    // Never connected to the volunteer, so it cannot carry anything for us.
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })

  it('will not route through a volunteer behind a NAT', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer({ reachability: 'nat' })), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })

  it('falls to a forwarder when nobody is volunteering', async () => {
    const remote = device()
    const forwarder = device()
    const h = harness({ forwarders: [{ url: 'wss://relay.example', pubkey: forwarder.pub }] })

    h.session.setViews([person(remote.pub)])
    await settle()
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'forwarder', endpoint: forwarder.pub })
    expect(h.mesh.forwarding).toBe('trying')
    h.close()
  })

  it('falls to TURN only when nothing else is left, and asks for it by name', async () => {
    const remote = device()
    const h = harness()

    h.session.setViews([person(remote.pub)])
    await settle()
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    // The rung is passed to the factory, which is the only way an app can
    // hand ICE the TURN credentials at the last rung and not before.
    expect(h.factory.to(remote.pub)?.context?.tier).toBe('turn')
    h.close()
  })

  it('gives up honestly when TURN fails too, and does not take the room with it', async () => {
    const remote = device()
    const other = device()
    const h = harness()

    h.session.setViews([person(remote.pub), person(other.pub)])
    await settle()
    h.state(other.pub, 'connected')

    h.state(remote.pub, 'failed')
    await settle()
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: true })
    expect(h.routes.at(-1)).toMatchObject({ device: remote.pub, route: { exhausted: true } })
    // The other person is still perfectly well connected.
    expect(h.mesh.routes.get(other.pub)).toMatchObject({ tier: 'direct', connected: true })
    h.close()
  })

  it('marks a route connected only when the connection says so', async () => {
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.connected).toBe(false)
    h.state(remote.pub, 'connected')
    expect(h.mesh.routes.get(remote.pub)?.connected).toBe(true)
    h.close()
  })

  it('drops the route when the device leaves the room', async () => {
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    await settle()
    h.session.setViews([])
    await settle()

    expect(h.mesh.routes.size).toBe(0)
    h.close()
  })
})

describe('a volunteer vanishing mid-call', () => {
  it('falls to another volunteer, and the room does not notice', async () => {
    const first = device()
    const second = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(first.pub, offer()), person(second.pub, offer()), person(remote.pub)])
    await settle()
    h.state(first.pub, 'connected')
    h.state(second.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    const chosen = h.mesh.routes.get(remote.pub)!.endpoint
    expect([first.pub, second.pub]).toContain(chosen)

    // They close their laptop. The roster is what says so.
    const left = chosen === first.pub ? second : first
    h.session.setViews([person(left.pub, offer()), person(remote.pub)])
    await settle()

    const route = h.mesh.routes.get(remote.pub)!
    expect(route.tier).toBe('assist')
    expect(route.endpoint).toBe(left.pub)
    h.close()
  })

  it('falls all the way to TURN when the last volunteer goes', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    h.session.setViews([person(remote.pub)])
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    // Never a dropped room: there is still a connection being attempted.
    expect(h.factory.to(remote.pub)).toBeDefined()
    h.close()
  })

  it('falls onwards when the volunteer merely withdraws its offer', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    // Same person, same device, still in the room - they have simply stopped
    // giving their bandwidth away, which they are entitled to do mid-call.
    h.session.setViews([person(volunteer.pub), person(remote.pub)])
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })

  it('falls onwards when the connection to the volunteer itself dies', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    h.state(volunteer.pub, 'failed')
    await settle()
    // A first failure on a connection that was up is a blip until proven
    // otherwise: the peer restarts ICE and the pair stays on the volunteer.
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    h.state(volunteer.pub, 'failed')
    await settle()

    // Both the volunteer and the person they were carrying move on.
    expect(h.mesh.routes.get(remote.pub)?.tier).not.toBe('assist')
    h.close()
  })

  it('never tries the same volunteer twice for one pair', async () => {
    const first = device()
    const second = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(first.pub, offer()), person(second.pub, offer()), person(remote.pub)])
    await settle()
    h.state(first.pub, 'connected')
    h.state(second.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    const tried: string[] = [h.mesh.routes.get(remote.pub)!.endpoint]
    // The chosen volunteer refuses. Both ends of the pair hear the same
    // refusal, so both fall to the same next volunteer.
    const refuse = (from: { sk: Uint8Array; pub: string }): void => {
      h.relay.publish(
        wrapSignal(
          { type: 'assist', roomId: ROOM_ID, assist: remote.pub, accept: false },
          { senderSk: from.sk, recipientPubkey: h.local.pub },
        ),
      )
    }
    refuse(tried[0] === first.pub ? first : second)
    await settle()

    const next = h.mesh.routes.get(remote.pub)!
    expect(next.tier).toBe('assist')
    expect(tried).not.toContain(next.endpoint)
    h.close()
  })

  it('runs out of volunteers rather than cycling through them for ever', async () => {
    const first = device()
    const second = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(first.pub, offer()), person(second.pub, offer()), person(remote.pub)])
    await settle()
    h.state(first.pub, 'connected')
    h.state(second.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    for (const who of [first, second]) {
      const current = h.mesh.routes.get(remote.pub)!.endpoint
      const refuser = current === first.pub ? first : second
      void who
      h.relay.publish(
        wrapSignal(
          { type: 'assist', roomId: ROOM_ID, assist: remote.pub, accept: false },
          { senderSk: refuser.sk, recipientPubkey: h.local.pub },
        ),
      )
      await settle()
    }

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })

  it('does not count a yes as connected, and gives the first media a fresh budget', async () => {
    vi.useFakeTimers()
    try {
      const volunteer = device()
      const remote = device()
      const h = harness({ routeTimeoutMs: 10_000 })
      h.session.setViews([
        person(volunteer.pub, offer()),
        { ...person(remote.pub), tracks: [{ trackId: 'cam-remote', role: 'camera', device: remote.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      h.state(volunteer.pub, 'connected')
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)

      // Most of the request's budget goes on the volunteer holding it for the
      // other end, then it says yes.
      await vi.advanceTimersByTimeAsync(7_000)
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
      await vi.advanceTimersByTimeAsync(0)

      // A yes is not media: the route is not connected...
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', endpoint: volunteer.pub, connected: false })
      // ...and the budget for the first media starts again from the yes, so
      // the 3 s left of the request's would not have been enough.
      await vi.advanceTimersByTimeAsync(9_000)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).not.toBe('assist')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('being the volunteer', () => {
  function ask(h: Harness, from: { sk: Uint8Array; pub: string }, far: string): void {
    h.relay.publish(
      wrapSignal({ type: 'assist', roomId: ROOM_ID, assist: far, readsCarry: true }, { senderSk: from.sk, recipientPubkey: h.local.pub }),
    )
  }
  /** Both ends ask, as they do when the pair really cannot connect. */
  function askBoth(h: Harness, a: { sk: Uint8Array; pub: string }, b: { sk: Uint8Array; pub: string }): void {
    ask(h, a, b.pub)
    ask(h, b, a.pub)
  }

  it('refuses when this device never volunteered', async () => {
    const a = device()
    const b = device()
    const h = harness()
    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')

    ask(h, a, b.pub)
    await settle()

    // Refused, and said so - the asker's alternative is waiting out a timeout.
    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
    h.close()
  })

  it('refuses when this device is not currently advertising an offer', async () => {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const h = harness({ relay, offering: () => false })
    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')

    ask(h, a, b.pub)
    await settle()

    // Being asked is not consent. A device that has withdrawn its offer - or
    // never made one - must not be talked into spending its bandwidth.
    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
    expect(relay.relaying).toBe(0)
    h.close()
  })

  it('carries a pair it is connected to both ends of', async () => {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const started: string[] = []
    const h = harness({ relay, relayMedia: fakePipeline(), onRelayStart: (pair) => started.push(pair.key) })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')

    askBoth(h, a, b)
    await settle()

    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: true })
    expect(assistSignals(h.relay, b.sk).at(-1)).toEqual({ assist: a.pub, accept: true })
    expect(relay.relaying).toBe(1)
    expect(started).toHaveLength(1)
    expect(h.mesh.relaying).toBe(1)
    h.close()
  })

  it('refuses a pair it cannot reach both ends of', async () => {
    const a = device()
    const b = device()
    const h = harness({ relay: new PeerRelay() })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    // b never connected.

    ask(h, a, b.pub)
    await settle()
    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
    h.close()
  })

  it('refuses a pair naming somebody who is not in the room', async () => {
    const a = device()
    const stranger = device()
    const h = harness({ relay: new PeerRelay() })

    h.session.setViews([person(a.pub)])
    await settle()
    h.state(a.pub, 'connected')

    ask(h, a, stranger.pub)
    await settle()
    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: stranger.pub, accept: false })
    h.close()
  })

  it('refuses past the cap, so volunteering never ruins its own call', async () => {
    const people = Array.from({ length: MAX_ASSISTED_PAIRS * 2 + 2 }, () => device())
    const relay = new PeerRelay()
    const h = harness({ relay, relayMedia: fakePipeline() })

    h.session.setViews(people.map((p) => person(p.pub)))
    await settle()
    for (const p of people) h.state(p.pub, 'connected')

    for (let i = 0; i < MAX_ASSISTED_PAIRS; i += 1) askBoth(h, people[i * 2]!, people[i * 2 + 1]!)
    await settle()
    expect(relay.relaying).toBe(MAX_ASSISTED_PAIRS)

    const overflowA = people.at(-2)!
    askBoth(h, overflowA, people.at(-1)!)
    await settle()

    expect(assistSignals(h.relay, overflowA.sk).at(-1)).toMatchObject({ accept: false })
    expect(relay.relaying).toBe(MAX_ASSISTED_PAIRS)
    h.close()
  })

  it('stops carrying a pair when one of its ends leaves', async () => {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const stopped: string[] = []
    const h = harness({ relay, relayMedia: fakePipeline(), onRelayStop: (pair) => stopped.push(pair.key) })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    askBoth(h, a, b)
    await settle()
    expect(relay.relaying).toBe(1)

    h.session.setViews([person(a.pub)])
    await settle()

    expect(relay.relaying).toBe(0)
    expect(stopped).toHaveLength(1)
    // The end still here is told, so it moves on now rather than when the
    // media runs dry.
    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
    h.close()
  })

  it('stops carrying everything when the mesh closes', async () => {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const h = harness({ relay, relayMedia: fakePipeline() })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    askBoth(h, a, b)
    await settle()
    expect(relay.relaying).toBe(1)

    h.close()
    expect(relay.relaying).toBe(0)
  })
})

describe('attribution through a volunteer', () => {
  it('credits relayed media to whoever the roster says published it', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    const views: ParticipantView[] = [
      person(volunteer.pub, offer()),
      { ...person(remote.pub), tracks: [{ trackId: 'cam-remote', role: 'camera', device: remote.pub }] },
    ]
    h.session.setViews(views)
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    const seen: Array<{ participant: string; device: string; via: string }> = []
    h.mesh.onRemoteTrack(({ participant, device: d, via }) => seen.push({ participant, device: d, via }))

    // The volunteer's connection delivers a track the roster says belongs to
    // the person it is carrying.
    const pc = h.factory.to(volunteer.pub)!
    pc.ontrack?.({ track: { id: 'cam-remote' } as MediaStreamTrack })

    expect(seen).toEqual([{ participant: `p-${remote.pub.slice(0, 8)}`, device: remote.pub, via: 'assist' }])
    h.close()
  })

  it('still credits the volunteer with its own media on the same connection', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([
      { ...person(volunteer.pub, offer()), tracks: [{ trackId: 'cam-vol', role: 'camera', device: volunteer.pub }] },
      person(remote.pub),
    ])
    await settle()
    h.state(volunteer.pub, 'connected')

    const seen: string[] = []
    h.mesh.onRemoteTrack(({ device: d, via }) => seen.push(`${d.slice(0, 8)}:${via}`))
    h.factory.to(volunteer.pub)!.ontrack?.({ track: { id: 'cam-vol' } as MediaStreamTrack })

    expect(seen).toEqual([`${volunteer.pub.slice(0, 8)}:direct`])
    h.close()
  })
})

describe('peer assist can be turned off entirely', () => {
  it('skips straight past a willing volunteer when the room says not to', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness({ assist: () => false })

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })
})

describe('the route timeout', () => {
  it('moves on when a rung neither connects nor fails', async () => {
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ routeTimeoutMs: 1_000 })
      h.session.setViews([person(remote.pub)])
      h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
      // A candidate pair that sits in `checking` for ever reports nothing at
      // all, which is exactly the case ICE will not tell us about.
      vi.advanceTimersByTime(1_500)

      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  /** A direct rung with a negotiation under way: a camera to send, one open
   *  connection, and the long budget far away. */
  async function checking(over: Partial<MeshOptions> = {}) {
    const remote = device()
    const h = harness({ routeTimeoutMs: 10_000, directCheckTimeoutMs: 1_000, ...over })
    h.session.setViews([person(remote.pub)])
    h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
    await vi.advanceTimersByTimeAsync(0)
    return { h, remote, direct: h.factory.to(remote.pub)! }
  }

  it('BUG: moves to TURN soon after direct checks start and find nothing, not ten seconds after the offer', async () => {
    // Measured in an emulated NAT matrix: a pair behind a symmetric NAT sat
    // in `checking` on the direct rung until the route timeout, so every
    // call that needed the relay took nearly twelve seconds to join, while
    // every direct pair had connected 0.6 s after its checks began.
    vi.useFakeTimers()
    try {
      const { h, remote, direct } = await checking()
      h.state(remote.pub, 'connecting')
      await vi.advanceTimersByTimeAsync(1_500)

      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: false })
      expect(direct.closed).toBe(true)
      expect(h.factory.to(remote.pub)?.context?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays direct when the checks connect inside their budget', async () => {
    vi.useFakeTimers()
    try {
      const { h, remote, direct } = await checking()
      h.state(remote.pub, 'connecting')
      await vi.advanceTimersByTimeAsync(600)
      h.state(remote.pub, 'connected')
      await vi.advanceTimersByTimeAsync(15_000)

      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'direct', connected: true })
      expect(h.factory.to(remote.pub)).toBe(direct)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a negotiation that never reaches the checks the whole route timeout', async () => {
    // A lost description is not evidence about the path: nothing has been
    // tried yet, so only the long budget applies.
    vi.useFakeTimers()
    try {
      const { h, remote } = await checking()
      await vi.advanceTimersByTimeAsync(9_000)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the checking clock again when a late candidate arrives', async () => {
    vi.useFakeTimers()
    try {
      const { h, remote } = await checking()
      h.state(remote.pub, 'connecting')
      await vi.advanceTimersByTimeAsync(800)
      const candidate = JSON.stringify({ candidate: 'candidate:2 1 udp 1686052607 198.51.100.7 40000 typ srflx', sdpMid: '0', sdpMLineIndex: 0 })
      h.relay.publish(wrapSignal({ type: 'ice', roomId: ROOM_ID, candidate }, { senderSk: remote.sk, recipientPubkey: h.local.pub }))
      await vi.advanceTimersByTimeAsync(800)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
      await vi.advanceTimersByTimeAsync(500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not shorten the TURN rung', async () => {
    vi.useFakeTimers()
    try {
      const { h, remote } = await checking({ turnRouteTimeoutMs: 20_000 })
      h.state(remote.pub, 'connecting')
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.state(remote.pub, 'connecting')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: false })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('after the ladder runs out', () => {
  it('BUG: tries again from the top after a rest, rather than staying dark for the rest of the call', async () => {
    // Exhaustion used to be final. A pair that lost every rung in one bad
    // minute - a phone through a dead spot, a router rebooting - was lost
    // for the rest of the call, however long, until one side rejoined. In a
    // room that stays open for days, that is a tile gone blank for good.
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ exhaustedRetryMs: 1_000 })
      h.session.setViews([person(remote.pub)])
      await vi.advanceTimersByTimeAsync(0)
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: true })
      const before = h.factory.instances.length

      await vi.advanceTimersByTimeAsync(1_500)

      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'direct', exhausted: false, connected: false })
      expect(h.routes.at(-1)).toMatchObject({ device: remote.pub, route: { tier: 'direct', exhausted: false } })
      // A fresh connection, on the first rung, not a revival of the dead one.
      expect(h.factory.instances.length).toBe(before + 1)
      expect(h.factory.to(remote.pub)?.context?.tier).toBe('direct')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a device that left while it was resting', async () => {
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ exhaustedRetryMs: 1_000 })
      h.session.setViews([person(remote.pub)])
      await vi.advanceTimersByTimeAsync(0)
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      h.session.setViews([])
      const before = h.factory.instances.length
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.factory.instances.length).toBe(before)
      expect(h.mesh.routes.has(remote.pub)).toBe(false)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a pair with nothing to carry', () => {
  it('BUG: keeps an idle connection open without walking the ladder, and starts the clock when a negotiation does', async () => {
    // Two people with their cameras off, or a person and an agent here to
    // read the chat: neither side offers, so nothing connects, and the
    // mesh used to declare the rung failed, walk to TURN, and give up -
    // and, once exhaustion was retried, do it again every rest.
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ routeTimeoutMs: 1_000, exhaustedRetryMs: 1_000 })
      h.session.setViews([person(remote.pub)])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'direct', exhausted: false })
      expect(h.factory.instances.length).toBe(1)

      // They advertise a camera: still no clock, because advertising is not
      // sending - they may have chosen not to send it to us.
      const view = person(remote.pub)
      view.tracks = [{ trackId: 'cam', role: 'camera', device: remote.pub }]
      h.session.setViews([view])
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'direct', exhausted: false })

      // They offer: now a negotiation is under way, the rung has a budget,
      // and a pair that then never connects is a pair that failed.
      h.relay.publish(wrapSignal({ type: 'offer', roomId: ROOM_ID, sdp: 'v=0 offer', tier: 'direct' }, { senderSk: remote.sk, recipientPubkey: h.local.pub }))
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the clock when this side publishes something for the pair', async () => {
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ routeTimeoutMs: 1_000 })
      h.session.setViews([person(remote.pub)])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
      h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('meeting the far end on its rung', () => {
  /** An offer from `remote`, stamped with the rung it was made on. */
  function offerFrom(remote: { sk: Uint8Array; pub: string }, local: string, tier?: 'direct' | 'turn') {
    return wrapSignal(
      { type: 'offer', roomId: ROOM_ID, sdp: 'v=0 offer', ...(tier ? { tier } : {}) },
      { senderSk: remote.sk, recipientPubkey: local },
    )
  }

  it('BUG: hops to TURN when the far end offers from TURN, and answers there', async () => {
    // Each end walks the ladder on its own clock. Left alone, one reaches
    // TURN and offers from a connection with relay candidates, the other
    // answers from one with none, then tears it down on its own timer, and
    // the two chase each other round the ladder for the rest of the call.
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
    const direct = h.factory.to(remote.pub)!

    h.relay.publish(offerFrom(remote, h.local.pub, 'turn'))
    await settle()
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', endpoint: remote.pub, connected: false })
    expect(direct.closed).toBe(true)
    const turn = h.factory.to(remote.pub)!
    expect(turn).not.toBe(direct)
    expect(turn.context?.tier).toBe('turn')
    // And the offer was applied to the connection opened on that rung.
    expect(turn.calls.some((c) => c.method === 'setRemoteDescription')).toBe(true)
    expect(h.routes.at(-1)).toMatchObject({ device: remote.pub, route: { tier: 'turn' } })
    h.close()
  })

  it('stays put when the direct rung is already connected', async () => {
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    await settle()
    h.state(remote.pub, 'connected')
    const direct = h.factory.to(remote.pub)!
    h.relay.publish(offerFrom(remote, h.local.pub, 'turn'))
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
    expect(h.factory.to(remote.pub)).toBe(direct)
    h.close()
  })

  it('treats an offer with no rung on it as it always did', async () => {
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    await settle()
    const direct = h.factory.to(remote.pub)!
    h.relay.publish(offerFrom(remote, h.local.pub))
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('direct')
    expect(h.factory.to(remote.pub)).toBe(direct)
    h.close()
  })

  it('stamps its own offers with the rung they were made on', async () => {
    const remote = device()
    const h = harness()
    h.session.setViews([person(remote.pub)])
    h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
    await settle()
    const offers = h.relay.published
      .map((e) => unwrap(e, remote.sk))
      .filter((u): u is NonNullable<typeof u> => u?.body.type === 'offer')
    expect(offers.length).toBeGreaterThan(0)
    expect(offers.at(-1)?.body.tier).toBe('direct')

    h.state(remote.pub, 'failed')
    await settle()
    h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
    await settle()
    const later = h.relay.published
      .map((e) => unwrap(e, remote.sk))
      .filter((u): u is NonNullable<typeof u> => u?.body.type === 'offer')
    expect(later.at(-1)?.body.tier).toBe('turn')
    h.close()
  })
})

describe('the TURN rung gets longer', () => {
  it('BUG: gives the last rung more time than the others, because it is the slow one', async () => {
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ routeTimeoutMs: 1_000, turnRouteTimeoutMs: 3_000 })
      h.session.setViews([person(remote.pub)])
      h.mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      // Past the direct budget, well inside the TURN one: still trying.
      await vi.advanceTimersByTimeAsync(1_500)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: false })
      // Past the TURN budget: now it has genuinely failed.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'turn', exhausted: true })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resting longer each time', () => {
  it('BUG: doubles the rest after each failed retry, up to a cap, and forgets it on a connection', async () => {
    // A member with no WebRTC stack at all - an agent that only reads the
    // chat - never answers an offer. Retried every thirty seconds, that is
    // a fresh connection built and torn down every half minute for as long
    // as the two share a standing room.
    vi.useFakeTimers()
    try {
      const remote = device()
      const h = harness({ routeTimeoutMs: 100, turnRouteTimeoutMs: 100, exhaustedRetryMs: 1_000, maxExhaustedRetryMs: 4_000 })
      // Every retry from the top, stamped by the (fake) clock, and the
      // exhaustion before it.
      const events: Array<{ at: number; what: 'retry' | 'exhausted' }> = []
      let connectOnRetry = false
      let seenExhausted = false
      h.mesh.close()
      const mesh = new Mesh({
        session: h.session,
        factory: h.factory,
        localDevice: h.local.pub,
        localParticipant: device().pub,
        deviceSk: h.local.sk,
        transport: new SimTransport(h.relay),
        roomId: ROOM_ID,
        routeTimeoutMs: 100,
        turnRouteTimeoutMs: 100,
        exhaustedRetryMs: 1_000,
        maxExhaustedRetryMs: 4_000,
        // A connection that was up gets an ICE restart before it is believed
        // failed; shortened so the failure below is believed quickly.
        iceRestart: { graceMs: 50, timeoutMs: 100 },
        onRoute: (_d, route) => {
          if (route.exhausted) {
            seenExhausted = true
            events.push({ at: Date.now(), what: 'exhausted' })
          } else if (route.tier === 'direct' && seenExhausted) {
            events.push({ at: Date.now(), what: 'retry' })
            // The peer is opened just after this announcement; connect it a
            // moment later, before its rung times out.
            if (connectOnRetry) setTimeout(() => h.state(remote.pub, 'connected'), 10)
          }
        },
      })
      h.session.setViews([person(remote.pub)])
      mesh.publish([{ id: 'cam', kind: 'video' } as unknown as MediaStreamTrack])

      await vi.advanceTimersByTimeAsync(20_000)
      const rests: number[] = []
      for (let i = 0; i + 1 < events.length; i++) {
        if (events[i]!.what === 'exhausted' && events[i + 1]!.what === 'retry') rests.push(events[i + 1]!.at - events[i]!.at)
      }
      // 1s, 2s, 4s, then the cap.
      expect(rests.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 4_000])

      // A connection forgets the count: the next rest is 1s again.
      connectOnRetry = true
      events.length = 0
      await vi.advanceTimersByTimeAsync(4_100)
      expect(mesh.routes.get(remote.pub)?.connected).toBe(true)
      events.length = 0
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(1_500)
      const after = events.findIndex((e) => e.what === 'exhausted')
      expect(after).toBeGreaterThanOrEqual(0)
      expect(events[after + 1]).toMatchObject({ what: 'retry' })
      expect(events[after + 1]!.at - events[after]!.at).toBe(1_000)
      mesh.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('connected means media', () => {
  /** A pair on the assist rung through `volunteer`, with the far end
   *  advertising a camera and the volunteer's yes already in. */
  async function carriedRoute(over: Partial<MeshOptions> = {}) {
    const volunteer = device()
    const remote = device()
    const h = harness({ routeTimeoutMs: 10_000, assistSampleMs: 100, assistStallMs: 1_000, ...over })
    h.session.setViews([
      person(volunteer.pub, offer()),
      { ...person(remote.pub), tracks: [{ trackId: 'cam-remote', role: 'camera', device: remote.pub }] },
    ])
    await vi.advanceTimersByTimeAsync(0)
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', endpoint: volunteer.pub })
    signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
    await vi.advanceTimersByTimeAsync(0)
    return { h, volunteer, remote }
  }

  /** The volunteer offers with a carried m-line, and it arrives. */
  async function deliver(h: Harness, volunteer: { sk: Uint8Array; pub: string }, carried: string, mid = '7') {
    signal(h, volunteer, { type: 'offer', sdp: 'offer-sdp-carry', carry: { [mid]: { device: carried, role: 'camera' } } })
    await vi.advanceTimersByTimeAsync(0)
    const track = mediaTrack(`recv-${mid}`)
    const r = receiver()
    h.factory.to(volunteer.pub)!.ontrack?.({ track, receiver: r, transceiver: { mid } as never })
    await vi.advanceTimersByTimeAsync(0)
    return { track, r }
  }

  it('does not mark an assist route connected when the volunteer connection comes back', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      // An ICE restart on the volunteer's own link, say.
      h.state(volunteer.pub, 'connected')
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', connected: false })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the route connected on the first carried media, and not before', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const seen: Array<{ device: string; via: string; role?: string }> = []
      h.mesh.onRemoteTrack(({ device: d, via, role }) => seen.push({ device: d, via, role }))
      const { r } = await deliver(h, volunteer, remote.pub)

      // Attributed through the carry map, to the person it belongs to.
      expect(seen).toEqual([{ device: remote.pub, via: 'assist', role: 'camera' }])
      await vi.advanceTimersByTimeAsync(300)
      expect(h.mesh.routes.get(remote.pub)?.connected).toBe(false)

      r.bytes = 1_200
      await vi.advanceTimersByTimeAsync(150)
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', connected: true })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves on, and does not try that volunteer again, when no media arrives in the budget', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      await vi.advanceTimersByTimeAsync(10_500)

      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      // The volunteer is told, and its connection to us is left alone: it
      // was only ever being asked.
      expect(assistBodies(h.relay, volunteer.sk).at(-1)).toEqual({ assist: remote.pub, accept: false, release: true })
      expect(h.factory.to(volunteer.pub)?.closed).toBe(false)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves on when carried media stops arriving after it started', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const { r } = await deliver(h, volunteer, remote.pub)
      r.bytes = 1_000
      await vi.advanceTimersByTimeAsync(150)
      expect(h.mesh.routes.get(remote.pub)?.connected).toBe(true)

      // The volunteer stays in the roster and its connection stays up, but
      // nothing more arrives.
      await vi.advanceTimersByTimeAsync(1_300)
      expect(h.mesh.routes.get(remote.pub)?.tier).not.toBe('assist')
      expect(assistBodies(h.relay, volunteer.sk).at(-1)).toMatchObject({ release: true })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens a connection to the far end when the assist rung fails', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      // Entering assist closed the direct peer.
      expect(h.factory.to(remote.pub)).toBeUndefined()
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      expect(h.factory.to(remote.pub)?.context?.tier).toBe('turn')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends what the volunteer carried when the route moves on, so nobody is shown twice', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const { track } = await deliver(h, volunteer, remote.pub)
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(track.readyState).toBe('ended')
      expect((track as unknown as { ended: number }).ended).toBe(1)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a carried m-line it did not ask this volunteer for, rather than showing it as the volunteer', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer } = await carriedRoute()
      const stranger = device()
      const seen: string[] = []
      h.mesh.onRemoteTrack(({ device: d }) => seen.push(d))
      await deliver(h, volunteer, stranger.pub)
      expect(seen).toEqual([])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the valid carry entries of an offer, and holds an m-line it cannot place until it can', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const seen: Array<{ device: string; via: string }> = []
      h.mesh.onRemoteTrack(({ device: d, via }) => seen.push({ device: d, via }))
      signal(h, volunteer, {
        type: 'offer',
        sdp: 'offer-sdp-carry',
        carry: { '7': { device: remote.pub, role: 'camera' }, '8': { device: 'not-a-key', role: 'camera' } } as never,
      })
      await vi.advanceTimersByTimeAsync(0)
      const pc = h.factory.to(volunteer.pub)!
      pc.ontrack?.({ track: mediaTrack('m7'), receiver: receiver(), transceiver: { mid: '7' } as never })
      pc.ontrack?.({ track: mediaTrack('m8'), receiver: receiver(), transceiver: { mid: '8' } as never })
      // Mid 7 is the far end's. Mid 8 names nobody, and this volunteer is
      // carrying for us, so it is not shown as the volunteer's own: it is held.
      expect(seen).toEqual([{ device: remote.pub, via: 'assist' }])

      // The volunteer's roster says that track is its own after all.
      h.session.setViews([
        { ...person(volunteer.pub, offer()), tracks: [{ trackId: 'm8', role: 'camera', device: volunteer.pub }] },
        { ...person(remote.pub), tracks: [{ trackId: 'cam-remote', role: 'camera', device: remote.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toEqual([
        { device: remote.pub, via: 'assist' },
        { device: volunteer.pub, via: 'direct' },
      ])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a carried track that arrives before its advert, and shows it once the roster catches up', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const seen: Array<{ device: string; role?: string }> = []
      h.mesh.onRemoteTrack(({ device: d, role }) => seen.push({ device: d, role }))
      signal(h, volunteer, { type: 'offer', sdp: 'offer-sdp-carry', carry: { '9': { device: remote.pub, role: 'screen' } } })
      await vi.advanceTimersByTimeAsync(0)
      h.factory.to(volunteer.pub)!.ontrack?.({ track: mediaTrack('m9'), receiver: receiver(), transceiver: { mid: '9' } as never })
      expect(seen).toEqual([])

      h.session.setViews([
        person(volunteer.pub, offer()),
        { ...person(remote.pub), tracks: [{ trackId: 'cam-remote', role: 'camera', device: remote.pub }, { trackId: 'share', role: 'screen', device: remote.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toEqual([{ device: remote.pub, role: 'screen' }])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show a carried m-line switched on in an answer as the volunteer\'s own', async () => {
    vi.useFakeTimers()
    try {
      // Offers collided: this device's offer was answered, and the answer
      // turned on an m-line the volunteer had added, with no `carry` map.
      const { h, volunteer } = await carriedRoute()
      const seen: string[] = []
      h.mesh.onRemoteTrack(({ device: d }) => seen.push(d))
      h.factory.to(volunteer.pub)!.ontrack?.({ track: mediaTrack('clock-id'), receiver: receiver(), transceiver: { mid: '3' } as never })
      expect(seen).toEqual([])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('judges a stall per role, so a camera that stops while the microphone flows is noticed', async () => {
    vi.useFakeTimers()
    try {
      const volunteer = device()
      const remote = device()
      const h = harness({ routeTimeoutMs: 10_000, assistSampleMs: 100, assistStallMs: 1_000 })
      h.session.setViews([
        person(volunteer.pub, offer()),
        { ...person(remote.pub), tracks: [{ trackId: 'c', role: 'camera', device: remote.pub }, { trackId: 'm', role: 'mic', device: remote.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      h.state(volunteer.pub, 'connected')
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
      signal(h, volunteer, { type: 'offer', sdp: 'offer-sdp-carry', carry: { '1': { device: remote.pub, role: 'camera' }, '2': { device: remote.pub, role: 'mic' } } })
      await vi.advanceTimersByTimeAsync(0)
      const cam = receiver()
      const mic = receiver()
      const pc = h.factory.to(volunteer.pub)!
      pc.ontrack?.({ track: mediaTrack('rc'), receiver: cam, transceiver: { mid: '1' } as never })
      pc.ontrack?.({ track: mediaTrack('rm', 'audio'), receiver: mic, transceiver: { mid: '2' } as never })
      cam.bytes = 1_000
      mic.bytes = 100
      await vi.advanceTimersByTimeAsync(150)
      expect(h.mesh.routes.get(remote.pub)?.connected).toBe(true)

      // Sound keeps coming; the picture does not.
      for (let i = 0; i < 12; i += 1) {
        mic.bytes += 100
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(h.mesh.routes.get(remote.pub)?.tier).not.toBe('assist')
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call a route stalled because an old receiver stopped reporting', async () => {
    vi.useFakeTimers()
    try {
      const { h, volunteer, remote } = await carriedRoute()
      const { r: old } = await deliver(h, volunteer, remote.pub, '7')
      old.bytes = 5_000
      await vi.advanceTimersByTimeAsync(150)
      // The camera is toggled: a new m-line, and the old one's report goes.
      const { r: fresh } = await deliver(h, volunteer, remote.pub, '11')
      old.getStats = async () => new Map()
      for (let i = 0; i < 15; i += 1) {
        fresh.bytes += 500
        await vi.advanceTimersByTimeAsync(100)
      }
      expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', connected: true })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('who asks', () => {
  it('never asks for a far end its own audience refuses', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    // Media for everybody except `remote`: an agent its person keeps from
    // hearing them, say.
    h.mesh.publish([mediaTrack('mine', 'audio')], (view) => view.participant !== `p-${remote.pub.slice(0, 8)}`)
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    expect(assistSignals(h.relay, volunteer.sk)).toEqual([])
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
    h.close()
  })

  it('asks with its camera and microphone off, so it can still receive', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(assistSignals(h.relay, volunteer.sk)).toEqual([{ assist: remote.pub, accept: undefined }])
    h.close()
  })

  it('takes its request back when its audience stops admitting the far end', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

    h.mesh.publish([mediaTrack('mine', 'audio')], (view) => view.participant !== `p-${remote.pub.slice(0, 8)}`)
    await settle()
    expect(assistBodies(h.relay, volunteer.sk).at(-1)).toEqual({ assist: remote.pub, accept: false, release: true })
    expect(h.mesh.routes.get(remote.pub)?.tier).not.toBe('assist')
    h.close()
  })
})

describe('the mutual request', () => {
  function ask(h: Harness, from: { sk: Uint8Array; pub: string }, far: string): void {
    signal(h, from, { type: 'assist', assist: far, readsCarry: true })
  }

  /** A volunteer directly connected to `a` and `b`, each sending it a camera. */
  async function volunteering(over: Partial<MeshOptions> = {}) {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const pipeline = fakePipeline()
    const started: string[] = []
    const stopped: string[] = []
    const h = harness(
      { relay, relayMedia: pipeline, assistHoldMs: 8_000, onRelayStart: (pair) => started.push(pair.key), onRelayStop: (pair) => stopped.push(pair.key), ...over },
      { structuredSdp: true },
    )
    h.session.setViews([
      { ...person(a.pub), tracks: [{ trackId: 'cam-a', role: 'camera', device: a.pub }] },
      { ...person(b.pub), tracks: [{ trackId: 'cam-b', role: 'camera', device: b.pub }] },
    ])
    await vi.advanceTimersByTimeAsync(0)
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    h.factory.to(a.pub)!.ontrack?.({ track: mediaTrack('cam-a'), receiver: { from: 'a' } })
    h.factory.to(b.pub)!.ontrack?.({ track: mediaTrack('cam-b'), receiver: { from: 'b' } })
    await vi.advanceTimersByTimeAsync(0)
    return { h, a, b, relay, pipeline, started, stopped }
  }

  it('holds the first request, and refuses it once the hold is up if the other end never asks', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay, pipeline } = await volunteering()
      ask(h, a, b.pub)
      await vi.advanceTimersByTimeAsync(7_900)
      expect(assistSignals(h.relay, a.sk)).toEqual([])
      expect(pipeline.legs).toEqual([])

      await vi.advanceTimersByTimeAsync(200)
      expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
      expect(relay.relaying).toBe(0)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries once both have asked, one leg each way, each tapped from its own source', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, pipeline, started } = await volunteering()
      ask(h, a, b.pub)
      await vi.advanceTimersByTimeAsync(0)
      expect(pipeline.legs).toEqual([])
      expect(started).toEqual([])

      ask(h, b, a.pub)
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toHaveLength(1)
      expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: true })
      expect(assistSignals(h.relay, b.sk).at(-1)).toEqual({ assist: a.pub, accept: true })

      const legs = pipeline.legs.map((leg) => ({ from: leg.from, to: leg.to, role: leg.role, asked: leg.pair.asked(leg.from) }))
      expect(legs).toEqual(
        expect.arrayContaining([
          { from: a.pub, to: b.pub, role: 'camera', asked: true },
          { from: b.pub, to: a.pub, role: 'camera', asked: true },
        ]),
      )
      expect(legs).toHaveLength(2)
      // Each leg taps its source's own receiver, on the connection to it.
      expect(pipeline.legs.find((leg) => leg.from === a.pub)?.source.receiver).toEqual({ from: 'a' })

      // The offer that carries a's camera to b names it, by mid. The fake
      // connection does not raise `negotiationneeded` for `addTransceiver`;
      // a browser does, so the test does it here.
      h.factory.to(b.pub)!.onnegotiationneeded?.()
      await vi.advanceTimersByTimeAsync(0)
      const offers = h.relay.published
        .map((event) => unwrap(event, b.sk))
        .filter((u) => u?.body.type === 'offer' && u.body.carry)
      expect(Object.values(offers.at(-1)!.body.carry!)).toEqual([{ device: a.pub, role: 'camera' }])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries a source whose receiver ids match no advert, by kind, when each kind has one role', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, pipeline } = await volunteering()
      // b's media arrived on m-lines this device offered first, so its
      // receivers kept local ids that b's roster never names.
      h.factory.to(b.pub)!.ontrack?.({ track: mediaTrack('local-id-1', 'audio'), receiver: { from: 'b-mic' } })
      h.session.setViews([
        { ...person(a.pub), tracks: [{ trackId: 'cam-a', role: 'camera', device: a.pub }] },
        { ...person(b.pub), tracks: [{ trackId: 'cam-b', role: 'camera', device: b.pub }, { trackId: 'mic-b', role: 'mic', device: b.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      ask(h, a, b.pub)
      ask(h, b, a.pub)
      await vi.advanceTimersByTimeAsync(0)
      const fromB = pipeline.legs.filter((leg) => leg.from === b.pub).map((leg) => leg.role).sort()
      expect(fromB).toEqual(['camera', 'mic'])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not guess between a camera and a shared screen whose ids it cannot match', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, pipeline } = await volunteering()
      h.factory.to(b.pub)!.ontrack?.({ track: mediaTrack('local-id-2'), receiver: { from: 'b-video' } })
      h.session.setViews([
        { ...person(a.pub), tracks: [{ trackId: 'cam-a', role: 'camera', device: a.pub }] },
        { ...person(b.pub), tracks: [{ trackId: 'cam-b', role: 'camera', device: b.pub }, { trackId: 'scr-b', role: 'screen', device: b.pub }] },
      ])
      await vi.advanceTimersByTimeAsync(0)
      ask(h, a, b.pub)
      ask(h, b, a.pub)
      await vi.advanceTimersByTimeAsync(0)
      // Only b's own matched camera ('cam-b' from the fixture) is carried; the
      // unmatched video is not guessed into either role.
      expect(pipeline.legs.filter((leg) => leg.from === b.pub && leg.source.receiver !== undefined && (leg.source.receiver as { from?: string }).from === 'b-video')).toEqual([])
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses outright when it has no way to pump the frames', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay } = await volunteering({ relayMedia: undefined })
      ask(h, a, b.pub)
      await vi.advanceTimersByTimeAsync(0)
      expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
      expect(relay.relaying).toBe(0)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the pair when one end releases it, fires onRelayStop and tells the other end', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay, pipeline, stopped } = await volunteering()
      ask(h, a, b.pub)
      ask(h, b, a.pub)
      await vi.advanceTimersByTimeAsync(0)
      expect(relay.relaying).toBe(1)

      signal(h, a, { type: 'assist', assist: b.pub, accept: false, release: true })
      await vi.advanceTimersByTimeAsync(0)

      expect(relay.relaying).toBe(0)
      expect(stopped).toHaveLength(1)
      expect(pipeline.closed).toHaveLength(2)
      expect(assistSignals(h.relay, b.sk).at(-1)).toEqual({ assist: a.pub, accept: false })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops carrying everybody at once when this device stops helping, and tells both ends', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay, pipeline, stopped } = await volunteering()
      ask(h, a, b.pub)
      ask(h, b, a.pub)
      await vi.advanceTimersByTimeAsync(0)

      h.mesh.stopRelaying()
      expect(relay.relaying).toBe(0)
      expect(relay.closed).toBe(true)
      expect(stopped).toHaveLength(1)
      expect(pipeline.closed).toHaveLength(2)
      expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
      expect(assistSignals(h.relay, b.sk).at(-1)).toEqual({ assist: a.pub, accept: false })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('claims every receiver as it arrives, before helping is turned on, because a later tap carries nothing', async () => {
    vi.useFakeTimers()
    try {
      const offering = false
      const { pipeline, h } = await volunteering({ offering: () => offering })
      // Not offering at all, and both receivers are claimed already.
      expect(pipeline.prepared).toEqual(expect.arrayContaining([{ from: 'a' }, { from: 'b' }]))
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('claims the receiver of an m-line it makes for its own track, before the far end answers', async () => {
    const remote = device()
    const pipeline = fakePipeline()
    const h = harness({ relay: new PeerRelay(), relayMedia: pipeline })
    h.session.setViews([person(remote.pub)])
    await settle()
    h.mesh.publish([mediaTrack('mine')])
    await settle()
    // The far end may later send on this m-line; its receiver is claimed now,
    // not when the answer turns it on.
    const transceivers = h.factory.to(remote.pub)!.getTransceivers()
    expect(transceivers.length).toBeGreaterThan(0)
    expect(pipeline.prepared).toContain(transceivers[0]!.receiver)
    h.close()
  })

  it('starts the pumps when the room is built, so they are running before the first track', () => {
    let warmed = 0
    const h = harness({ relay: new PeerRelay(), offering: () => false, relayMedia: { ...fakePipeline(), warm: () => void (warmed += 1) } })
    // At construction, before any roster or track, and whether or not it is offering.
    expect(warmed).toBe(1)
    h.close()
    let without = 0
    const none = harness({ relayMedia: { ...fakePipeline(), warm: () => void (without += 1) } })
    // No relay registry: this device never helps, and nothing is started.
    expect(without).toBe(0)
    none.close()
  })

  it('claims receivers early while offering, so a later pair can tap them', async () => {
    vi.useFakeTimers()
    try {
      const { pipeline, h } = await volunteering()
      expect(pipeline.prepared).toEqual(expect.arrayContaining([{ from: 'a' }, { from: 'b' }]))
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('older ends, lost signals and shared registries', () => {
  async function pairOnVolunteer(over: Partial<MeshOptions> = {}) {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const pipeline = fakePipeline()
    const stopped: string[] = []
    const h = harness({ relay, relayMedia: pipeline, onRelayStop: (pair) => stopped.push(pair.key), ...over })
    h.session.setViews([
      { ...person(a.pub), tracks: [{ trackId: 'cam-a', role: 'camera', device: a.pub }] },
      { ...person(b.pub), tracks: [{ trackId: 'cam-b', role: 'camera', device: b.pub }] },
    ])
    await vi.advanceTimersByTimeAsync(0)
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    h.factory.to(a.pub)!.ontrack?.({ track: mediaTrack('cam-a'), receiver: { from: 'a' } })
    h.factory.to(b.pub)!.ontrack?.({ track: mediaTrack('cam-b'), receiver: { from: 'b' } })
    await vi.advanceTimersByTimeAsync(0)
    return { h, a, b, relay, pipeline, stopped }
  }

  it('refuses an end that does not say it reads carry, which an older build would misattribute', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay } = await pairOnVolunteer()
      signal(h, a, { type: 'assist', assist: b.pub })
      signal(h, b, { type: 'assist', assist: a.pub, readsCarry: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: false })
      expect(relay.relaying).toBe(0)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it reads carry on every request it makes', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()
    const requests = h.relay.published.map((event) => unwrap(event, volunteer.sk)).filter((u) => u?.body.type === 'assist')
    expect(requests.map((u) => u!.body.readsCarry)).toEqual([true])
    h.close()
  })

  it('drops a pair whose ends stop asking, so consent lost with a release still ends the carrying', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay, stopped } = await pairOnVolunteer({ assistLeaseMs: 3_000 })
      signal(h, a, { type: 'assist', assist: b.pub, readsCarry: true })
      signal(h, b, { type: 'assist', assist: a.pub, readsCarry: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(relay.relaying).toBe(1)
      // B keeps asking; A's renewals never arrive - its release was lost too.
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
        signal(h, b, { type: 'assist', assist: a.pub, readsCarry: true })
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(relay.relaying).toBe(0)
      expect(stopped).toHaveLength(1)
      expect(assistSignals(h.relay, b.sk).at(-1)).toEqual({ assist: a.pub, accept: false })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps asking while carried, and stops when it no longer sends to the far end', async () => {
    vi.useFakeTimers()
    try {
      const volunteer = device()
      const remote = device()
      let admit = true
      const h = harness({ routeTimeoutMs: 60_000, assistRenewMs: 1_000 })
      h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
      h.mesh.publish([], () => admit)
      await vi.advanceTimersByTimeAsync(0)
      h.state(volunteer.pub, 'connected')
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
      await vi.advanceTimersByTimeAsync(2_100)
      const requests = () => assistBodies(h.relay, volunteer.sk).filter((body) => body.accept === undefined).length
      expect(requests()).toBe(3)

      // The audience rule changes without a publish - the renewal notices.
      admit = false
      await vi.advanceTimersByTimeAsync(1_000)
      expect(assistBodies(h.relay, volunteer.sk).at(-1)).toEqual({ assist: remote.pub, accept: false, release: true })
      expect(requests()).toBe(3)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a yes it is not waiting for with a release', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'connected')
    // A hold that ended after this device had moved on, or a request that
    // outlived its release.
    signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
    await settle()
    expect(assistBodies(h.relay, volunteer.sk).at(-1)).toEqual({ assist: remote.pub, accept: false, release: true })
    h.close()
  })

  it('answers an offer carrying somebody it did not ask for with a release', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()
    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    signal(h, volunteer, { type: 'offer', sdp: 'offer-sdp-carry', carry: { '4': { device: remote.pub, role: 'camera' } } })
    await settle()
    expect(assistBodies(h.relay, volunteer.sk).at(-1)).toEqual({ assist: remote.pub, accept: false, release: true })
    h.close()
  })

  it('follows the far end to TURN from a carried route that never brought anything', async () => {
    vi.useFakeTimers()
    try {
      const volunteer = device()
      const remote = device()
      const h = harness({ routeTimeoutMs: 60_000 })
      // The far end advertises nothing, so no media timer runs after the yes.
      h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
      await vi.advanceTimersByTimeAsync(0)
      h.state(volunteer.pub, 'connected')
      h.state(remote.pub, 'failed')
      await vi.advanceTimersByTimeAsync(0)
      signal(h, volunteer, { type: 'assist', assist: remote.pub, accept: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('assist')

      signal(h, remote, { type: 'offer', sdp: 'offer-sdp-turn', tier: 'turn' })
      await vi.advanceTimersByTimeAsync(0)
      expect(h.mesh.routes.get(remote.pub)?.tier).toBe('turn')
      expect(assistBodies(h.relay, volunteer.sk).at(-1)).toMatchObject({ release: true })
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tries a leg the pipeline refused only once for the same source', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const refusing: RelayMediaPipeline = { ready: true, carry: () => (calls += 1, null) }
      const { h, a, b } = await pairOnVolunteer({ relayMedia: refusing })
      signal(h, a, { type: 'assist', assist: b.pub, readsCarry: true })
      signal(h, b, { type: 'assist', assist: a.pub, readsCarry: true })
      await vi.advanceTimersByTimeAsync(0)
      const first = calls
      for (let i = 0; i < 3; i += 1) h.session.setViews(h.session.participants())
      await vi.advanceTimersByTimeAsync(0)
      expect(first).toBe(2)
      expect(calls).toBe(first)
      h.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closing one room leaves another room\'s pairs in a shared registry alone', async () => {
    vi.useFakeTimers()
    try {
      const { h, a, b, relay, stopped } = await pairOnVolunteer()
      signal(h, a, { type: 'assist', assist: b.pub, readsCarry: true })
      signal(h, b, { type: 'assist', assist: a.pub, readsCarry: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(relay.relaying).toBe(1)

      // The room on screen, with the same registry, closes while this one is
      // the docked call.
      const other = harness({ relay, relayMedia: fakePipeline() })
      other.close()
      expect(relay.relaying).toBe(1)
      expect(relay.closed).toBe(false)
      expect(stopped).toEqual([])
      h.close()
      expect(relay.relaying).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
