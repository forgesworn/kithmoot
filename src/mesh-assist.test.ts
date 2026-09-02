import { describe, it, expect, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Mesh } from './mesh.js'
import type { MeshOptions, MeshSession, RouteView } from './mesh.js'
import { PeerRelay } from './peer-relay.js'
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

function harness(over: Partial<MeshOptions> = {}): Harness {
  const session = new FakeSession()
  const factory = createFakeFactory()
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

  it('takes yes for an answer', async () => {
    const volunteer = device()
    const remote = device()
    const h = harness()

    h.session.setViews([person(volunteer.pub, offer()), person(remote.pub)])
    await settle()
    h.state(volunteer.pub, 'connected')
    h.state(remote.pub, 'failed')
    await settle()

    h.relay.publish(
      wrapSignal(
        { type: 'assist', roomId: ROOM_ID, assist: remote.pub, accept: true },
        { senderSk: volunteer.sk, recipientPubkey: h.local.pub },
      ),
    )
    await settle()

    expect(h.mesh.routes.get(remote.pub)).toMatchObject({ tier: 'assist', connected: true })
    h.close()
  })
})

describe('being the volunteer', () => {
  function ask(h: Harness, from: { sk: Uint8Array; pub: string }, far: string): void {
    h.relay.publish(
      wrapSignal({ type: 'assist', roomId: ROOM_ID, assist: far }, { senderSk: from.sk, recipientPubkey: h.local.pub }),
    )
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
    const h = harness({ relay, onRelayStart: (pair) => started.push(pair.key) })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')

    ask(h, a, b.pub)
    await settle()

    expect(assistSignals(h.relay, a.sk).at(-1)).toEqual({ assist: b.pub, accept: true })
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
    const h = harness({ relay })

    h.session.setViews(people.map((p) => person(p.pub)))
    await settle()
    for (const p of people) h.state(p.pub, 'connected')

    for (let i = 0; i < MAX_ASSISTED_PAIRS; i += 1) ask(h, people[i * 2]!, people[i * 2 + 1]!.pub)
    await settle()
    expect(relay.relaying).toBe(MAX_ASSISTED_PAIRS)

    const overflowA = people.at(-2)!
    ask(h, overflowA, people.at(-1)!.pub)
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
    const h = harness({ relay, onRelayStop: (pair) => stopped.push(pair.key) })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    ask(h, a, b.pub)
    await settle()
    expect(relay.relaying).toBe(1)

    h.session.setViews([person(a.pub)])
    await settle()

    expect(relay.relaying).toBe(0)
    expect(stopped).toHaveLength(1)
    h.close()
  })

  it('stops carrying everything when the mesh closes', async () => {
    const a = device()
    const b = device()
    const relay = new PeerRelay()
    const h = harness({ relay })

    h.session.setViews([person(a.pub), person(b.pub)])
    await settle()
    h.state(a.pub, 'connected')
    h.state(b.pub, 'connected')
    ask(h, a, b.pub)
    await settle()

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
