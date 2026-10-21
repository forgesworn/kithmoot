import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import type { KeeperState } from './agent.js'
import { CONTROL_CHANNEL, decodeControl } from './control.js'
import { GrantReceiver, GROUP_GRANT_KIND, type GroupEvent } from './group-grants.js'
import type { GroupGrantsConfig } from './group-grants-keeper.js'
import { KINDS } from './kinds.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { FakeNodes, MemoryStore, oldEpochRosterEntry, waitFor } from '../test/group-grants-fixtures.js'

const BASE = 'https://example.test/j/'
const A = 'http://node-a.test:8080'
const B = 'https://node-b.test'

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
async function settleUntil(done: () => boolean, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await settle()
}
const transportFor = (relay: SimRelay) => () => new SimTransport(relay)

function grantsConfig(nodes: FakeNodes, over: Partial<GroupGrantsConfig> = {}): GroupGrantsConfig {
  return {
    nodes: [A, B], bytes: 1_000_000, store: new MemoryStore(), fetch: nodes.fetch,
    backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 200, rosterDelayMs: 5, sweepIntervalMs: 3_600_000, ...over,
  }
}

async function room(over: Partial<GroupGrantsConfig> = {}, extra: Partial<Parameters<typeof RoomAgent.create>[0]> = {}) {
  const relay = new SimRelay({ replay: true })
  const nodes = new FakeNodes('')
  nodes.clock = () => Math.floor(Date.now() / 1000)
  const config = grantsConfig(nodes, over)
  const keeper = await RoomAgent.create({
    base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, groupGrants: config, ...extra,
  })
  nodes.keeper = keeper.link.invitation!.inviter
  const join = (name: string, identity = localIdentity(generateSecretKey())) =>
    RoomAgent.join({ link: keeper.url, name, identity, deviceSk: generateSecretKey(), transport: transportFor(relay), announceJitterMs: 0, timing: { heartbeatIntervalMs: 40 } })
  return { relay, nodes, keeper, join, config }
}

const storageOps = (agent: RoomAgent): { id: string; event: GroupEvent }[] =>
  agent.channel(CONTROL_CHANNEL).messages().flatMap((m) => {
    const c = decodeControl(m.text)
    return c?.op === 'storage-grant' ? [{ id: m.id, event: c.event }] : []
  })

describe('a keeper with group nodes', { timeout: 30_000 }, () => {
  it('mints for each admitted device, delivers it in the room, and pushes it to its node', async () => {
    const { nodes, keeper, join } = await room()
    const ada = await join('Ada')
    const bob = await join('Bob')
    await settleUntil(() => (keeper.groupGrantLedger?.grants.length ?? 0) === 4)
    const ledger = keeper.groupGrantLedger!
    expect(new Set(ledger.grants.map((g) => g.device))).toEqual(new Set([ada.device, bob.device]))
    expect(ledger.grants.every((g) => g.participant === (g.device === ada.device ? ada.participant : bob.participant))).toBe(true)
    await waitFor(() => nodes.posts.filter((p) => p.status === 201).length === 4)

    // Ada, reading the control channel with the authority pinned in her link, keeps her own two grants and nobody else's.
    const adaView = new GrantReceiver({ authority: ada.link.invitation!.inviter, roomId: ada.roomId, device: ada.device })
    await settleUntil(() => storageOps(ada).length === 4)
    for (const op of storageOps(ada)) adaView.offer(op.event, Math.floor(Date.now() / 1000))
    expect(adaView.grantsFor('node-a.test', Math.floor(Date.now() / 1000)).length).toBe(1)
    expect(adaView.grantsFor('node-b.test', Math.floor(Date.now() / 1000)).length).toBe(1)
    expect(adaView.grantsFor('node-a.test', Math.floor(Date.now() / 1000))[0]!.device).toBe(ada.device)
    // The keeper's own device is never in its grants.
    expect(ledger.grants.some((g) => g.device === keeper.device)).toBe(false)
    for (const a of [ada, bob, keeper]) await a.leave()
  })

  it('answers storage-grant? from the asking device, whose credential binds it', async () => {
    const { keeper, join } = await room()
    const ada = await join('Ada')
    await settleUntil(() => (keeper.groupGrantLedger?.grants.length ?? 0) === 2)
    await settleUntil(() => storageOps(ada).length === 2)
    const before = storageOps(ada).length
    await ada.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'storage-grant?' }))
    await settleUntil(() => storageOps(ada).length > before)
    expect(storageOps(ada).length).toBe(before + 2)
    expect(storageOps(ada).slice(before).every((o) => o.event.tags.some((t) => t[0] === 'device' && t[1] === ada.device))).toBe(true)
    for (const a of [ada, keeper]) await a.leave()
  })

  it('never publishes a grant, revocation or reset bare on a relay', async () => {
    const { relay, keeper, join, nodes } = await room()
    const ada = await join('Ada')
    const bob = await join('Bob')
    await settleUntil(() => nodes.posts.length >= 4)
    await keeper.remove(bob.participant)
    await settleUntil(() => keeper.session.epoch === 1)
    await keeper.closeRoom()
    await settle()
    const ids = [...keeper.groupGrantLedger!.grants.map((g) => g.id), ...keeper.groupGrantLedger!.grants.map((g) => g.event.id)]
    expect(ids.length).toBeGreaterThan(0)
    expect(nodes.posts.some((p) => p.event.tags[0]![1] === 'reset')).toBe(true)
    for (const event of relay.published) {
      expect(event.kind).not.toBe(GROUP_GRANT_KIND)
      expect(event.tags.some((t) => t[0] === 'grant' || t[0] === 'status' || t[0] === 'scope' || t[0] === 'bytes')).toBe(false)
      const wire = JSON.stringify(event)
      for (const id of ids) expect(wire).not.toContain(id)
    }
    // And it did ride the room: the control channel (encrypted by the epoch key) carried them.
    expect(relay.published.length).toBeGreaterThan(0)
    for (const a of [ada, bob]) await a.leave()
  })

  it('removal: revocations are pushed before the rekey and posted after it, in the new epoch', async () => {
    const { relay, nodes, keeper, join } = await room()
    const ada = await join('Ada')
    const bob = await join('Bob')
    await settleUntil(() => nodes.posts.filter((p) => p.status === 201).length === 4)
    const seen = nodes.posts.length
    const removal = keeper.remove(bob.participant)
    await removal
    await settleUntil(() => keeper.session.epoch === 1 && storageOps(ada).some((o) => o.event.tags.some((t) => t[0] === 'status' && t[1] === 'revoked')))
    // The nodes saw both revocations for Bob's device, and revoked its grants.
    const revokedPosts = nodes.posts.slice(seen).filter((p) => p.event.tags.some((t) => t[0] === 'status' && t[1] === 'revoked'))
    expect(revokedPosts.length).toBe(2)
    expect(revokedPosts.every((p) => p.status === 201)).toBe(true)
    for (const host of ['node-a.test', 'node-b.test']) {
      const states = [...nodes.state(host).grants.values()]
      expect(states.filter((g) => g.device === bob.device).every((g) => g.status === 'revoked')).toBe(true)
      expect(states.filter((g) => g.device === ada.device).every((g) => g.status === 'active')).toBe(true)
    }
    // In the room: Ada, who followed to epoch 1, reads and can carry the revocations; Bob, who did not, cannot.
    const adaView = new GrantReceiver({ authority: ada.link.invitation!.inviter, roomId: ada.roomId, device: ada.device })
    const now = Math.floor(Date.now() / 1000)
    for (const op of storageOps(ada)) adaView.offer(op.event, now)
    expect(adaView.carry('node-a.test', now).length).toBe(1)
    expect(adaView.carry('node-b.test', now).length).toBe(1)
    const bobRevocations = storageOps(bob).filter((o) => o.event.tags.some((t) => t[0] === 'status' && t[1] === 'revoked'))
    expect(bobRevocations).toEqual([])
    expect(keeper.groupGrantLedger!.removing).toEqual([])
    for (const a of [ada, bob, keeper]) await a.leave()
  })

  it('the order is the contract\'s: the push happens before the rekey is published', async () => {
    const relay = new SimRelay({ replay: true })
    const nodes = new FakeNodes('')
    nodes.clock = () => Math.floor(Date.now() / 1000)
    const events: string[] = []
    const tracedFetch = ((input: string, init: RequestInit) => {
      const e = JSON.parse(String(init.body)) as GroupEvent
      if (e.tags.some((t) => t[0] === 'status' && t[1] === 'revoked')) events.push(`push@${relay.published.filter((x) => x.kind === KINDS.ROOM_REKEY).length}`)
      return nodes.fetch(input, init)
    }) as unknown as typeof fetch
    const keeper = await RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0,
      groupGrants: grantsConfig(nodes, { fetch: tracedFetch }),
    })
    nodes.keeper = keeper.link.invitation!.inviter
    const bob = await RoomAgent.join({ link: keeper.url, name: 'Bob', transport: transportFor(relay), announceJitterMs: 0 })
    await settleUntil(() => nodes.posts.filter((p) => p.status === 201).length === 2)
    await keeper.remove(bob.participant)
    // Every revocation push saw no rekey yet; afterwards there is exactly one.
    expect(events).toEqual(['push@0', 'push@0'])
    expect(relay.published.filter((x) => x.kind === KINDS.ROOM_REKEY).length).toBe(1)
    for (const a of [bob, keeper]) await a.leave()
  })

  it('an unreachable node does not delay the rekey', async () => {
    const { nodes, keeper, join } = await room({ pushBudgetMs: 100 })
    const bob = await join('Bob')
    await settleUntil(() => nodes.posts.filter((p) => p.status === 201).length === 2)
    nodes.hang('node-a.test', true)
    nodes.setOffline('node-b.test', true)
    const started = Date.now()
    await keeper.remove(bob.participant)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(keeper.session.epoch).toBe(1)
    expect(keeper.groupGrantLedger!.journal.length).toBeGreaterThan(0)
    for (const a of [bob, keeper]) await a.leave()
  })

  it('close: a reset in the room and at every node, before the room closes', async () => {
    const { nodes, keeper, join } = await room()
    const ada = await join('Ada')
    await settleUntil(() => nodes.posts.filter((p) => p.status === 201).length === 2)
    await keeper.closeRoom()
    await settle()
    const resets = nodes.posts.filter((p) => p.event.tags[0]![1] === 'reset' && p.status === 201)
    expect(resets.map((p) => p.host).sort()).toEqual(['node-a.test', 'node-b.test'])
    const inRoom = storageOps(ada).filter((o) => o.event.tags[0]![1] === 'reset')
    expect(inRoom.length).toBe(2)
    await ada.leave()
  })
})

describe('without group nodes', { timeout: 30_000 }, () => {
  it('changes nothing: no ops, no ledger, no requests', async () => {
    const relay = new SimRelay({ replay: true })
    const keeper = await RoomAgent.create({ base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0 })
    const ada = await RoomAgent.join({ link: keeper.url, name: 'Ada', transport: transportFor(relay), announceJitterMs: 0 })
    await settle()
    await keeper.remove(ada.participant)
    await settle()
    expect(keeper.groupGrantLedger).toBeUndefined()
    await keeper.sweepGroupGrants() // a no-op
    expect(storageOps(keeper)).toEqual([])
    await keeper.closeRoom()
  })

  it('refuses group nodes with a live keeper, and refuses a configuration that cannot work, before dialling anything', async () => {
    const relay = new SimRelay({ replay: true })
    const nodes = new FakeNodes('')
    await expect(RoomAgent.create({
      base: BASE, name: 'Keeper', transport: transportFor(relay), liveKeeper: { close: async () => {} } as never, groupGrants: grantsConfig(nodes),
    })).rejects.toThrow(/live keeper/)
    await expect(RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), groupGrants: { ...grantsConfig(nodes), bytes: undefined as never },
    })).rejects.toThrow(/byte ceiling/)
    expect(relay.published).toEqual([])
  })
})

describe('the epoch filter on minting', { timeout: 30_000 }, () => {
  it('a device heard only before the last rekey gets no grant, and a roster entry posted in the old epoch after a removal gets none either', async () => {
    const states: KeeperState[] = []
    // No sweep runs by itself: the test decides when the keeper looks.
    const { relay, nodes, keeper, join } = await room({ rosterDelayMs: 3_600_000 }, { onState: (s) => { states.push(s) } })
    const ada = await join('Ada')
    const bob = await join('Bob')
    const mallory = await join('Mallory')
    await settle()
    await mallory.leave() // heard in epoch 0, and gone before anything was granted
    await settle()
    expect(keeper.groupGrantLedger!.grants).toEqual([])
    await keeper.remove(bob.participant)
    await waitFor(() => keeper.session.epoch === 1 && keeper.session.devicesHeardThisEpoch().some((d) => d.device === ada.device))

    // Mallory's credential is still held (a month's worth are), but she was not heard in this epoch.
    expect(keeper.session.recentCredentials().some((d) => d.device === mallory.device)).toBe(true)
    expect(keeper.session.devicesHeardThisEpoch().some((d) => d.device === mallory.device)).toBe(false)
    expect(keeper.session.devicesHeardThisEpoch().some((d) => d.device === ada.device)).toBe(true)

    // And a fresh participant key posting under the OLD epoch's key, now.
    const eve = await oldEpochRosterEntry(keeper, Math.floor(Date.now() / 1000))
    relay.publish(eve.event)
    await settle()
    expect(keeper.session.recentCredentials().some((d) => d.device === eve.device)).toBe(false)

    await keeper.sweepGroupGrants()
    const granted = new Set(keeper.groupGrantLedger!.grants.map((g) => g.device))
    expect(granted).toEqual(new Set([ada.device]))
    expect(nodes.posts.every((p) => (p.event.tags.find((t) => t[0] === 'device')?.[1] ?? ada.device) === ada.device)).toBe(true)

    // A restart does not bring the remembered devices back as granted either.
    const state = states.at(-1)!
    expect(state.devices?.some((d) => d.device === mallory.device)).toBe(true)
    await keeper.leave()
    const again = await RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, state,
      groupGrants: grantsConfig(nodes, { rosterDelayMs: 3_600_000, store: new MemoryStore() }),
    })
    expect(again.session.recentCredentials().some((d) => d.device === mallory.device)).toBe(true)
    await again.sweepGroupGrants()
    expect(again.groupGrantLedger!.grants.some((g) => g.device === mallory.device)).toBe(false)
    for (const a of [ada, bob, again]) await a.leave()
  })

  it('a member who was away across the rekey follows it and is granted once it speaks in the new epoch', async () => {
    const { keeper, join, nodes } = await room({ rosterDelayMs: 3_600_000 })
    const ada = await join('Ada')
    const bob = await join('Bob')
    await settle()
    await keeper.remove(bob.participant)
    await waitFor(() => ada.session.epoch === 1 && keeper.session.devicesHeardThisEpoch().some((d) => d.device === ada.device))
    await keeper.sweepGroupGrants()
    expect(keeper.groupGrantLedger!.grants.filter((g) => g.device === ada.device).length).toBe(2)
    expect(nodes.keeper).toBe(keeper.link.invitation!.inviter)
    for (const a of [ada, bob, keeper]) await a.leave()
  })
})
