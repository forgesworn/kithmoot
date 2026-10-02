import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import type { RelayConfig, RelayTransport } from './relay-pool.js'
import { RoomAgent, agentRelayPool } from './agent.js'
import { CONTROL_CHANNEL, encodeControl } from './control.js'
import { encodeRoomLink, parseRoomLink } from './link.js'
import { signRoomRelays } from './room-relays.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const BASE = 'https://example.test/j/'
const url = (name: string) => `wss://${name}.example/`
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => url(`${prefix}${i}`))

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
async function settleUntil(done: () => boolean, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await settle()
}

/** A simulator transport that remembers the relays it was built for and every
 *  list it was later moved to. */
class RecordingTransport extends SimTransport implements RelayTransport {
  moves: string[][] = []
  constructor(relay: SimRelay, readonly built: string[]) { super(relay) }
  setRelays(entries: readonly (string | RelayConfig)[]): void {
    this.moves.push(entries.map((e) => (typeof e === 'string' ? e : e.url)))
  }
}

function recorder(relay: SimRelay) {
  const made: RecordingTransport[] = []
  return { made, make: (relays: string[]) => { const t = new RecordingTransport(relay, relays); made.push(t); return t } }
}

describe('agentRelayPool', () => {
  it('puts the room first, then the agent’s own, without repeats', () => {
    expect(agentRelayPool([url('a'), url('b')], [url('b'), url('c')])).toEqual([url('a'), url('b'), url('c')])
  })

  it('caps at sixteen and cuts the agent’s own, never the room’s', () => {
    const pool = agentRelayPool([...many('r', 8), ...many('s', 8)], many('own', 8))
    expect(pool).toHaveLength(16)
    expect(pool.slice(0, 16)).toEqual([...many('r', 8), ...many('s', 8)])
    const small = agentRelayPool(many('r', 8), many('own', 12))
    expect(small).toHaveLength(16)
    expect(small.slice(0, 8)).toEqual(many('r', 8))
  })

  it('uses its own relays alone when the room names none, and the defaults when it has none either', () => {
    expect(agentRelayPool([], [url('own')])).toEqual([url('own')])
    expect(agentRelayPool([], []).length).toBeGreaterThan(0)
  })
})

describe('RoomAgent room relays', () => {
  it('a keeper fixes the room’s relays into its signed invitation, and its pool is those', async () => {
    const relay = new SimRelay({ replay: true })
    const rec = recorder(relay)
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: [url('a'), url('b')], transport: rec.make, announceJitterMs: 0 })
    expect(keeper.relays).toEqual([url('a'), url('b')])
    expect(rec.made[0]!.built).toEqual([url('a'), url('b')])
    keeper.leave()
  })

  it('a joiner dials the room’s relays first, then its own', async () => {
    const relay = new SimRelay({ replay: true })
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: [url('a'), url('b')], transport: (() => new SimTransport(relay)), announceJitterMs: 0 })
    const rec = recorder(relay)
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', relays: [url('mine'), url('a')], transport: rec.make, announceJitterMs: 0 })
    expect(ada.relays).toEqual([url('a'), url('b'), url('mine')])
    expect(rec.made.every((t) => t.built.slice(0, 2).join() === [url('a'), url('b')].join())).toBe(true)
    // The lookup that read the invitation went to the room's relays and its own too.
    expect(rec.made[0]!.built).toEqual([url('a'), url('b'), url('mine')])
    ada.leave(); keeper.leave()
  })

  it('the signed invitation’s relays replace the link’s unsigned ones', async () => {
    const relay = new SimRelay({ replay: true })
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: [url('a'), url('b')], transport: (() => new SimTransport(relay)), announceJitterMs: 0 })
    // A stale bookmark: the same invitation, but a link naming other relays.
    const stale = encodeRoomLink(BASE, { ...parseRoomLink(keeper.url), relays: [url('x')] })
    const rec = recorder(relay)
    // The lookup has to find the invitation somewhere, so the joiner's own relay stands in for it.
    const ada = await RoomAgent.join({ link: stale, name: 'Ada', relays: [url('mine')], transport: rec.make, announceJitterMs: 0 })
    expect(ada.relays).toEqual([url('a'), url('b'), url('mine')])
    expect(ada.relays).not.toContain(url('x'))
    ada.leave(); keeper.leave()
  })

  it('a link with no signed invitation relays still uses the link’s `r`', async () => {
    const relay = new SimRelay({ replay: true })
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: [url('a')], transport: (() => new SimTransport(relay)), announceJitterMs: 0 })
    // No admission is read from a legacy room: use a secret link.
    const secret = keeper.keeperState!.secret
    const { encodeJoinUrl } = await import('./room.js')
    const ada = await RoomAgent.join({ link: encodeJoinUrl(BASE, secret, [url('a'), url('c')]), name: 'Ada', relays: [url('mine')], transport: recorder(relay).make, announceJitterMs: 0 })
    expect(ada.relays).toEqual([url('a'), url('c'), url('mine')])
    ada.leave(); keeper.leave()
  })

  describe('the authority’s relays op', () => {
    async function room() {
      const relay = new SimRelay({ replay: true })
      const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: [url('a')], transport: (() => new SimTransport(relay)), announceJitterMs: 0 })
      const rec = recorder(relay)
      const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', relays: [url('mine')], transport: rec.make, announceJitterMs: 0 })
      await settle()
      const post = async (sk: Uint8Array, relays: string[], version: number) => {
        const sig = signRoomRelays({ roomId: keeper.roomId, version, relays, authoritySk: sk })
        await keeper.session.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'relays', relays, version, sig }))
      }
      return { keeper, ada, rec, post, authoritySk: keeper.keeperState!.inviterSk }
    }

    it('adds relays after the room’s and before the agent’s own, and moves the live pool', async () => {
      const { keeper, ada, rec, post, authoritySk } = await room()
      await post(authoritySk, [url('b'), url('a')].sort(), 5)
      await settleUntil(() => ada.relays.length > 2)
      expect(ada.relays).toEqual([url('a'), url('b'), url('mine')])
      // Made 0 was the lookup, closed once the invitation was read; 1 is the room's pool.
      expect(rec.made[1]!.moves.at(-1)).toEqual([url('a'), url('b'), url('mine')])
      ada.leave(); keeper.leave()
    })

    it('ignores a list the authority did not sign, and an older one', async () => {
      const { keeper, ada, post, authoritySk } = await room()
      await post(generateSecretKey(), [url('evil')], 9)
      await settle()
      expect(ada.relays).toEqual([url('a'), url('mine')])
      await post(authoritySk, [url('b')], 5)
      await settleUntil(() => ada.relays.includes(url('b')))
      await post(authoritySk, [url('c')], 4)
      await settle()
      expect(ada.relays).toEqual([url('a'), url('b'), url('mine')])
      ada.leave(); keeper.leave()
    })
  })
})
