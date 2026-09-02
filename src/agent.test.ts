import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent, AGENT_CHANNEL, TRANSCRIPT_CHANNEL } from './agent.js'
import type { KeeperState } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import { verifyAdmins } from './epoch.js'
import type { RekeyNotice } from './epoch.js'
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

  it('a keeper removes a member on an admin’s signed request, and not on anybody else’s', async () => {
    const relay = new SimRelay()
    const adminSk = generateSecretKey()
    const admin = localIdentity(adminSk)
    const states: KeeperState[] = []
    const keeper = await RoomAgent.create({
      base: BASE,
      name: 'Keeper',
      relays: ['wss://sim'],
      transport: transportFor(relay),
      announceJitterMs: 0,
      admins: [admin.pubkey],
      onState: (s) => {
        states.push(s)
      },
    })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: admin, transport: transportFor(relay), announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    const carol = await RoomAgent.join({ link: keeper.url, name: 'Carol', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    expect(keeper.roster().map((v) => v.name).sort()).toEqual(['Ada', 'Bob', 'Carol', 'Keeper'])

    // The keeper said who the admins are, signed by the room's authority.
    const announced = keeper.channel(CONTROL_CHANNEL).messages().map((m) => decodeControl(m.text)).find((c) => c?.op === 'admins')
    expect(announced?.op).toBe('admins')
    if (announced?.op !== 'admins') throw new Error('unreachable')
    expect(announced.admins).toEqual([admin.pubkey])
    expect(verifyAdmins({ roomId: keeper.roomId, epoch: 0, admins: announced.admins, sig: announced.sig, authority: keeper.link.invitation!.inviter })).toBe(true)

    // Carol is nobody special: her request goes nowhere.
    await carol.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'remove', participant: bob.participant }))
    await settle()
    expect(keeper.session.epoch).toBe(0)
    expect(keeper.roster().map((v) => v.name).sort()).toEqual(['Ada', 'Bob', 'Carol', 'Keeper'])

    // Ada is an admin: Bob is removed, and everybody who is left knows why.
    const epochs: RekeyNotice[] = []
    carol.onEpoch((n) => epochs.push(n))
    let bobTold: { epoch: number; by?: string } | undefined
    bob.onRemoved((n) => (bobTold = n))
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'remove', participant: bob.participant }))
    await settle()
    expect(keeper.session.epoch).toBe(1)
    expect(carol.session.epoch).toBe(1)
    expect(bob.session.epoch).toBe(0)
    expect(epochs).toHaveLength(1)
    expect(epochs[0]!.removed).toEqual([bob.participant])
    expect(epochs[0]!.by).toBe(admin.pubkey)
    expect(bobTold).toEqual({ epoch: 1, by: admin.pubkey })
    expect(keeper.roster().map((v) => v.name).sort()).toEqual(['Ada', 'Carol', 'Keeper'])
    expect(states.at(-1)?.epoch).toBe(1)
    expect(states.at(-1)?.removed).toEqual([bob.participant])
    expect(states.at(-1)?.epochSecret).toHaveLength(32)

    // Chat after the fact: Carol reads it, Bob does not.
    await ada.chat.send('just us now')
    await settle()
    expect(carol.chat.messages().map((m) => m.text)).toEqual(['just us now'])
    expect(bob.chat.messages()).toEqual([])

    // Removal is by participant, and the link is still open: somebody
    // arriving under a key the room has never seen is admitted to epoch 1,
    // which is what an open weekly room wants and is stated in the docs.
    bob.leave()
    const dave = await RoomAgent.join({ link: keeper.url, name: 'Dave', transport: transportFor(relay), announceJitterMs: 0 })
    expect(dave.session.epoch).toBe(1)
    dave.leave()
    keeper.leave()
    ada.leave()
    carol.leave()
  })

  it('a removed participant presenting the link again is refused the epoch', async () => {
    const relay = new SimRelay()
    const bobIdentity = localIdentity(generateSecretKey())
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', identity: bobIdentity, transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    await keeper.remove(bob.participant)
    await settle()
    await bob.leave()
    await expect(
      RoomAgent.join({ link: keeper.url, name: 'Bob', identity: bobIdentity, transport: transportFor(relay), announceJitterMs: 0 }),
    ).rejects.toThrow(/removed/)
    // Removing twice is one epoch, not two.
    await keeper.remove(bob.participant)
    expect(keeper.session.epoch).toBe(1)
    keeper.leave()
  })

  it('reopens a rekeyed room in the same epoch, still refusing the removed', async () => {
    const relay = new SimRelay({ replay: true })
    const bobIdentity = localIdentity(generateSecretKey())
    let state: KeeperState | undefined
    const first = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, onState: (s) => void (state = s) })
    const bob = await RoomAgent.join({ link: first.url, name: 'Bob', identity: bobIdentity, transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    await first.remove(bob.participant)
    await settle()
    await bob.leave()
    await first.leave()
    expect(state?.epoch).toBe(1)

    const again = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, state })
    expect(again.roomId).toBe(first.roomId)
    expect(again.url).toBe(first.url)
    expect(again.session.epoch).toBe(1)
    expect(again.session.removed.has(bobIdentity.pubkey)).toBe(true)
    await expect(
      RoomAgent.join({ link: again.url, name: 'Bob', identity: bobIdentity, transport: transportFor(relay), announceJitterMs: 0 }),
    ).rejects.toThrow(/removed/)
    const eve = await RoomAgent.join({ link: again.url, name: 'Eve', transport: transportFor(relay), announceJitterMs: 0 })
    expect(eve.session.epoch).toBe(1)
    eve.leave()
    again.leave()
  })

  it('an admin closes the room: nobody is kept, the link stops answering, the keeper leaves', async () => {
    const relay = new SimRelay()
    const admin = localIdentity(generateSecretKey())
    let state: KeeperState | undefined
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, admins: [admin.pubkey], onState: (s) => void (state = s) })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', identity: admin, transport: transportFor(relay), announceJitterMs: 0 })
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    let closed: { epoch: number; by?: string } | undefined
    bob.onClosed((n) => (closed = n))
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'close' }))
    await settle()
    expect(closed).toEqual({ epoch: 1, by: admin.pubkey })
    expect(state?.closed).toBe(true)
    expect(keeper.hosting).toBe(false)
    await expect(RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), state })).rejects.toThrow(/closed/)
    ada.leave()
    bob.leave()
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
