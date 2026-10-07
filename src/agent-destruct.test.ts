import { describe, it, expect } from 'vitest'
import { RoomAgent } from './agent.js'
import type { KeeperState } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { KINDS } from './kinds.js'
import { decodePersistentInvitation } from './persistent-invitation.js'
import { parseRoomLink } from './link.js'

const BASE = 'https://example.test/j/'

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

async function settleUntil(done: () => boolean, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await settle()
}

function world(extra: Partial<Parameters<typeof RoomAgent.create>[0]> = {}) {
  const relay = new SimRelay({ replay: true })
  const transport = () => new SimTransport(relay)
  const states: KeeperState[] = []
  const create = () => RoomAgent.create({
    base: BASE, name: 'Keeper', relays: ['wss://sim'], transport, announceJitterMs: 0, agent: false,
    onState: (s) => { states.push(s) },
    ...extra,
  })
  return { relay, transport, states, create }
}

describe('a self-destructing room (agent)', () => {
  it('writes the flag into the group invitation, and a joiner learns it', async () => {
    const { relay, transport, create } = world({ destruct: true })
    const keeper = await create()
    expect(keeper.destruct).toBe(true)
    expect(keeper.keeperState?.destruct).toBe(true)
    const link = parseRoomLink(keeper.url)
    const event = relay.published.find((e) => e.kind === KINDS.GROUP_INVITATION)!
    expect(decodePersistentInvitation(event, link.invitation!)?.destruct).toBe(true)
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    expect(ada.destruct).toBe(true)
    await ada.leave()
    await keeper.leave()
  })

  it('leaves an ordinary room unflagged', async () => {
    const { relay, transport, create } = world()
    const keeper = await create()
    const event = relay.published.find((e) => e.kind === KINDS.GROUP_INVITATION)!
    expect(decodePersistentInvitation(event, parseRoomLink(keeper.url).invitation!)?.destruct).toBeUndefined()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    expect(ada.destruct).toBe(false)
    expect(keeper.destruct).toBe(false)
    await ada.leave()
    await keeper.leave()
  })

  it('closes with destruct when asked, tells members, and saves the flag', async () => {
    const { transport, states, create } = world()
    const keeper = await create()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await settle()
    const heard: { destruct?: true }[] = []
    ada.onClosed((n) => heard.push(n))
    await keeper.closeRoom(undefined, { destruct: true })
    await settleUntil(() => heard.length > 0)
    expect(heard).toHaveLength(1)
    expect(heard[0]!.destruct).toBe(true)
    expect(ada.destruct).toBe(true)
    expect(states.at(-1)?.closed).toBe(true)
    expect(states.at(-1)?.destruct).toBe(true)
    await ada.leave()
  })

  it('a plain close of an ordinary room carries no flag', async () => {
    const { transport, create } = world()
    const keeper = await create()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await settle()
    const heard: { destruct?: true }[] = []
    ada.onClosed((n) => heard.push(n))
    await keeper.closeRoom()
    await settleUntil(() => heard.length > 0)
    expect(heard[0]!.destruct).toBeUndefined()
    await ada.leave()
  })

  it('a flagged room closes with destruct even when closed plainly', async () => {
    const { transport, create } = world({ destruct: true })
    const keeper = await create()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await settle()
    const heard: { destruct?: true }[] = []
    ada.onClosed((n) => heard.push(n))
    await keeper.closeRoom('ab'.repeat(32))
    await settleUntil(() => heard.length > 0)
    expect(heard[0]!.destruct).toBe(true)
    await ada.leave()
  })

  it('the keeper closes a flagged room at its end, and everybody hears it ended', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { transport, states, create } = world({ destruct: true, endsAt: now + 2 })
    const keeper = await create()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await settle()
    let keeperEnded = 0
    let adaEnded = 0
    const heard: { destruct?: true }[] = []
    keeper.onEnded(() => keeperEnded++)
    ada.onEnded(() => adaEnded++)
    ada.onClosed((n) => heard.push(n))
    const until = Date.now() + 5_000
    while ((keeperEnded === 0 || adaEnded === 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    expect(keeperEnded).toBe(1)
    expect(adaEnded).toBe(1)
    await settleUntil(() => heard.length > 0)
    expect(heard[0]?.destruct).toBe(true)
    expect(states.at(-1)?.closed).toBe(true)
    await ada.leave()
  })

  it('does not end an ordinary conference room by itself', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { create } = world({ endsAt: now + 2 })
    const keeper = await create()
    let ended = 0
    keeper.onEnded(() => ended++)
    await new Promise((r) => setTimeout(r, 2_400))
    expect(ended).toBe(0)
    expect(keeper.session.closed).toBe(false)
    await keeper.leave()
  })

  it('asks the relays to delete what its device signed, and the keeper\'s invitations', async () => {
    const { relay, transport, create } = world({ destruct: true })
    const keeper = await create()
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport, announceJitterMs: 0 })
    await settle()
    await ada.chat.send('hello')
    await settle()
    const mine = relay.published.filter((e) => e.pubkey === ada.device && e.kind < 20_000)
    expect(mine.length).toBeGreaterThan(0)
    const report = await ada.deleteOwnEvents({ timeoutMs: 2_000 })
    expect(report.found).toBeGreaterThanOrEqual(mine.length)
    expect(report.failed).toBe(0)
    const asked = new Set(relay.published.filter((e) => e.kind === 5 && e.pubkey === ada.device).flatMap((e) => e.tags.filter((t) => t[0] === 'e').map((t) => t[1])))
    for (const e of mine) expect(asked.has(e.id)).toBe(true)
    const kreport = await keeper.deleteOwnEvents({ timeoutMs: 2_000 })
    expect(kreport.failed).toBe(0)
    const invitation = relay.published.find((e) => e.kind === KINDS.GROUP_INVITATION)!
    const keeperAsked = relay.published.filter((e) => e.kind === 5).flatMap((e) => e.tags.filter((t) => t[0] === 'e').map((t) => t[1]))
    expect(keeperAsked).toContain(invitation.id)
    // The authority's closing words and retirement are not among them.
    const rekeys = relay.published.filter((e) => e.kind === KINDS.ROOM_REKEY)
    for (const e of rekeys) expect(keeperAsked).not.toContain(e.id)
  })

  it('a restarted keeper of an ended flagged room says why it will not start', async () => {
    const { states, create } = world({ destruct: true })
    const keeper = await create()
    const state = { ...keeper.keeperState!, endsAt: Math.floor(Date.now() / 1000) - 5 }
    await keeper.leave()
    expect(states.length).toBeGreaterThan(-1)
    const again = RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: () => new SimTransport(new SimRelay()), state })
    await expect(again).rejects.toMatchObject({ destruct: true })
  })
})
