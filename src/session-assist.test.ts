import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { createFakeFactory } from '../test/fake-rtc.js'
import { RoomSession } from './session.js'
import { localIdentity } from './identity.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'
import { decodeRosterEvent } from './roster.js'
import { MAX_ASSISTED_PAIRS } from './peer-assist.js'
import { PeerRelay } from './peer-relay.js'
import type { AssistOffer } from './types.js'

const NOW = 1_800_000_000
const now = () => NOW
const SECRET = new Uint8Array(32).fill(11)
const { roomId: ROOM_ID, roomKey: ROOM_KEY } = deriveRoom(SECRET)

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0))
}

function offer(over: Partial<AssistOffer> = {}): AssistOffer {
  return {
    reachability: 'public',
    capacity: { uplinkBps: 100_000_000, peers: 2, perPeerBps: 600_000 },
    relaying: 0,
    maxRelayed: MAX_ASSISTED_PAIRS,
    ...over,
  }
}

interface Fixture {
  relay: SimRelay
  assist?: () => AssistOffer | null
  /** This device's own relay registry, when it is volunteering. */
  peerRelay?: PeerRelay
  factory?: ReturnType<typeof createFakeFactory>
}

function session(fixture: Fixture): RoomSession {
  return new RoomSession({
    transport: new SimTransport(fixture.relay),
    secret: SECRET,
    identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(),
    now,
    announceJitterMs: 0,
    assist: fixture.assist,
    relay: fixture.peerRelay,
    factory: fixture.factory,
  })
}

/** Every roster entry this relay has carried, decoded. */
function entries(relay: SimRelay) {
  return relay.published
    .filter((event) => event.kind === KINDS.ROSTER)
    .map((event) => decodeRosterEvent(event, { roomId: ROOM_ID, roomKey: ROOM_KEY, now: NOW }))
    .filter((entry) => entry !== null)
}

describe('advertising an assist offer', () => {
  it('publishes nothing at all when nobody has opted in', async () => {
    const relay = new SimRelay()
    const s = session({ relay })
    await s.join([], {})
    await settle()

    // The wire is byte-identical to a room that has never heard of any of
    // this, which is the whole point of the field being optional.
    expect(entries(relay).every((entry) => entry!.assist === undefined)).toBe(true)
    s.leave()
  })

  it('carries the offer inside the room-key ciphertext, where a relay cannot read it', async () => {
    const relay = new SimRelay()
    const s = session({ relay, assist: () => offer() })
    await s.join([], {})
    await settle()

    const published = relay.published.filter((event) => event.kind === KINDS.ROSTER)
    expect(published.length).toBeGreaterThan(0)
    // Nothing about capacity, reachability or willingness is visible outside.
    for (const event of published) {
      expect(JSON.stringify(event.tags)).not.toContain('public')
      expect(event.content).not.toContain('uplinkBps')
    }
    expect(entries(relay).at(-1)!.assist).toEqual(offer())
    s.leave()
  })

  it('asks again on every publish, so the load figure is never stale', async () => {
    const relay = new SimRelay()
    let relaying = 0
    const s = session({ relay, assist: () => offer({ relaying }) })
    await s.join([], {})
    relaying = 2
    await s.announce()
    await settle()

    expect(entries(relay).at(-1)!.assist?.relaying).toBe(2)
    s.leave()
  })

  it('reads a caller whose offer source throws as not offering', async () => {
    const relay = new SimRelay()
    const s = session({
      relay,
      assist: () => {
        throw new Error('battery API rejected')
      },
    })
    await s.join([], {})
    await settle()

    // "I do not know" must read as "do not spend their bandwidth".
    expect(entries(relay).at(-1)!.assist).toBeUndefined()
    s.leave()
  })

  it('defuses an offer another client made up before it reaches anybody\'s arithmetic', async () => {
    const relay = new SimRelay()
    const liar = session({
      relay,
      assist: () => ({ ...offer(), maxRelayed: 5_000 }),
    })
    await liar.join([], {})
    await settle()

    expect(entries(relay).at(-1)!.assist?.maxRelayed).toBe(MAX_ASSISTED_PAIRS)
    liar.leave()
  })
})

describe('reading other people\'s offers', () => {
  it('shows an offer against the device that made it, not the person', async () => {
    const relay = new SimRelay()
    const volunteer = session({ relay, assist: () => offer() })
    const watcher = session({ relay })
    await volunteer.join([], {})
    await watcher.join([], {})
    await settle()

    const view = watcher.participants().find((v) => v.participant === volunteer.participant)!
    expect(view.assist).toEqual([{ ...offer(), device: volunteer.device }])
    watcher.leave()
    volunteer.leave()
  })

  it('leaves the field off entirely for somebody who is not offering', async () => {
    const relay = new SimRelay()
    const quiet = session({ relay })
    const watcher = session({ relay })
    await quiet.join([], {})
    await watcher.join([], {})
    await settle()

    const view = watcher.participants().find((v) => v.participant === quiet.participant)!
    expect(view.assist).toBeUndefined()
    watcher.leave()
    quiet.leave()
  })
})

describe('revoking mid-call', () => {
  it('stops advertising at once rather than at the next heartbeat', async () => {
    const relay = new SimRelay()
    const s = session({ relay, assist: () => offer() })
    await s.join([], {})
    await settle()
    expect(entries(relay).at(-1)!.assist).toBeDefined()

    await s.setAssist(null)
    await settle()

    expect(entries(relay).at(-1)!.assist).toBeUndefined()
    s.leave()
  })

  it('drops everything it was carrying before it says it will not carry any more', async () => {
    const relay = new SimRelay()
    const peerRelay = new PeerRelay()
    const factory = createFakeFactory()
    const s = session({ relay, factory, peerRelay, assist: () => offer() })
    await s.join([], {})
    peerRelay.admit('a'.repeat(64), 'b'.repeat(64))
    expect(s.relaying).toBe(1)

    await s.setAssist(null)

    // No window in which the room believes an offer this device has already
    // withdrawn.
    expect(peerRelay.relaying).toBe(0)
    expect(entries(relay).at(-1)!.assist).toBeUndefined()
    s.leave()
  })

  it('leaves the room, the call and everybody else exactly where they were', async () => {
    const relay = new SimRelay()
    const volunteer = session({ relay, assist: () => offer(), factory: createFakeFactory() })
    const other = session({ relay, factory: createFakeFactory() })
    await volunteer.join([], {})
    await other.join([], {})
    await settle()
    expect(other.participants()).toHaveLength(2)

    await volunteer.setAssist(null)
    await settle()

    // Still two people in the room. Revoking is not leaving.
    expect(other.participants()).toHaveLength(2)
    expect(volunteer.participants()).toHaveLength(2)
    other.leave()
    volunteer.leave()
  })

  it('refuses to carry anybody once revoked, even if asked directly', async () => {
    const relay = new SimRelay()
    const peerRelay = new PeerRelay()
    const s = session({ relay, factory: createFakeFactory(), peerRelay, assist: () => offer() })
    await s.join([], {})
    await s.setAssist(null)

    // The registry is closed, so nothing gets back in whatever anybody asks.
    expect(peerRelay.admit('a'.repeat(64), 'b'.repeat(64))).toBeNull()
    s.leave()
  })

  it('can be turned back on again', async () => {
    const relay = new SimRelay()
    const s = session({ relay })
    await s.join([], {})
    await s.setAssist(offer())
    await settle()

    expect(entries(relay).at(-1)!.assist).toEqual(offer())
    s.leave()
  })

  it('answers honestly about routes and load before media is ever set up', async () => {
    const relay = new SimRelay()
    const s = session({ relay })
    await s.join([], {})
    // No factory, so no mesh. Both answers are empty rather than absent.
    expect(s.routes.size).toBe(0)
    expect(s.relaying).toBe(0)
    s.leave()
  })
})
