import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent, AGENT_CHANNEL, TRANSCRIPT_CHANNEL } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { encodeJoinUrl } from './room.js'
import { encodeRoomLink, parseRoomLink } from './link.js'
import { localIdentity } from './identity.js'

const BASE = 'https://example.test/j/'

/** Lets scheduled re-announces and admission grants run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function transportFor(relay: SimRelay) {
  return () => new SimTransport(relay)
}

describe('RoomAgent', () => {
  it('a keeper makes a room and an agent joins it from the link, as an agent', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    expect(keeper.hosting).toBe(true)
    expect(keeper.keeperState).toBeDefined()
    expect(parseRoomLink(keeper.url).invitation).toBeDefined()

    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()

    expect(ada.roomId).toBe(keeper.roomId)
    const seen = keeper.roster().find((v) => v.participant === ada.participant)
    expect(seen?.agent).toBe(true)
    expect(seen?.name).toBe('Ada')
    // Admitted by the keeper, and now a delegated responder itself.
    expect(ada.hosting).toBe(true)

    // Chat both ways, on the room's own conversation.
    await ada.chat.send('hello')
    await keeper.chat.send('welcome')
    // Sorted: both land in the same second, and a tie breaks on a random id.
    expect(keeper.chat.messages().map((m) => m.text).sort()).toEqual(['hello', 'welcome'])

    ada.leave()
    keeper.leave()
  })

  it('a second agent is admitted by the first, after the keeper has gone', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    keeper.leave()
    await settle()

    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    expect(bob.roomId).toBe(keeper.roomId)
    expect(ada.roster().map((v) => v.name).sort()).toEqual(['Ada', 'Bob'])
    ada.leave()
    bob.leave()
  })

  it('reopens the same room from persisted keeper state', async () => {
    const relay = new SimRelay()
    const first = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const state = first.keeperState!
    const url = first.url
    first.leave()

    const again = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, state })
    expect(again.roomId).toBe(first.roomId)
    expect(again.url).toBe(url)
    again.leave()
  })

  it('agents talk among themselves on the agents channel and the people can read it', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, agent: false })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    // Open before anybody speaks; the simulator replays nothing.
    keeper.backchannel
    bob.backchannel
    await ada.backchannel.send('I will take the research')
    expect(bob.backchannel.messages().map((m) => m.text)).toEqual(['I will take the research'])
    expect(keeper.backchannel.messages().map((m) => m.text)).toEqual(['I will take the research'])
    expect(keeper.chat.messages()).toEqual([])
    expect(keeper.backchannel.channel).toBe(AGENT_CHANNEL)
    expect(keeper.transcripts.channel).toBe(TRANSCRIPT_CHANNEL)
    keeper.leave()
    ada.leave()
    bob.leave()
  })

  it('joins a legacy secret link, without hosting anything', async () => {
    const relay = new SimRelay()
    const secret = new Uint8Array(32).fill(4)
    const url = encodeJoinUrl(BASE, secret, ['wss://sim'])
    const agent = await RoomAgent.join({ link: url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    expect(agent.hosting).toBe(false)
    expect(agent.link.secret).toBeDefined()
    agent.leave()
  })

  it('refuses a pairing link, which is for a person’s second device', async () => {
    const relay = new SimRelay()
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const pairing = encodeRoomLink(BASE, { ...keeper.link, pairingCode: new Uint8Array(16).fill(1) })
    await expect(RoomAgent.join({ link: pairing, name: 'Ada', transport: transportFor(relay) })).rejects.toThrow(/pairing/)
    keeper.leave()
  })

  it('keeps the identity it is given', async () => {
    const relay = new SimRelay()
    const sk = generateSecretKey()
    const identity = localIdentity(sk)
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, identity })
    expect(keeper.participant).toBe(identity.pubkey)
    keeper.leave()
  })
})
