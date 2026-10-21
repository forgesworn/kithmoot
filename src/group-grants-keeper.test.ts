import { describe, it, expect, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { ControlMessage } from './control.js'
import {
  GroupGrantKeeper, MAX_DEVICES_PER_PARTICIPANT, parseLedger, type GroupGrantHost, type GroupGrantsConfig,
} from './group-grants-keeper.js'
import { GRANT_LIFETIME_SECONDS, parseGroupEvent, type ParsedGrant, type GroupEvent } from './group-grants.js'
import { FakeNodes, MemoryStore, hex32, waitFor } from '../test/group-grants-fixtures.js'

const T0 = 1_800_000_000
const DAY = 86_400
const A = 'https://node-a.test:8080'
const B = 'https://node-b.test'

const open: GroupGrantKeeper[] = []
afterEach(() => { for (const k of open.splice(0)) k.close() })

function setup(over: Partial<GroupGrantsConfig> = {}, store = new MemoryStore(), nodeUrls: string[] = [A, B]) {
  const sk = generateSecretKey()
  const authority = getPublicKey(sk)
  const roomId = 'ab'.repeat(32)
  const world = {
    now: T0,
    devices: [] as { device: string; participant: string }[],
    removed: new Set<string>(),
    sent: [] as ControlMessage[],
    removeCalls: [] as string[],
    sendFails: false,
  }
  const nodes = new FakeNodes(authority)
  const logs: string[] = []
  const host: GroupGrantHost = {
    roomId, authoritySk: sk, keeperParticipant: 'cc'.repeat(32),
    now: () => world.now,
    devices: () => world.devices,
    removed: () => world.removed,
    send: async (op) => { if (world.sendFails) throw new Error('relay down'); world.sent.push(op) },
    removeParticipant: async (p) => { world.removeCalls.push(p); world.removed.add(p) },
  }
  const config: GroupGrantsConfig = {
    nodes: nodeUrls, bytes: 1000, store, fetch: nodes.fetch, log: (l) => logs.push(l),
    backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 150, pushTimeoutMs: 1_000, sweepIntervalMs: 3_600_000, rosterDelayMs: 5,
    ...over,
  }
  const make = async (c: GroupGrantsConfig = config) => {
    const k = await GroupGrantKeeper.open(c, host)
    open.push(k)
    return k
  }
  const grantOps = () => world.sent.filter((o): o is Extract<ControlMessage, { op: 'storage-grant' }> => o.op === 'storage-grant')
  const parsed = (e: GroupEvent): ParsedGrant => (parseGroupEvent(e) as { ok: true; parsed: ParsedGrant }).parsed
  const addDevice = (participant: string) => { const device = hex32(); world.devices.push({ device, participant }); return device }
  const tick = (seconds: number) => { world.now += seconds; nodes.now = world.now }
  return { sk, authority, roomId, world, nodes, logs, host, config, store, make, grantOps, parsed, addDevice, tick }
}

const P1 = '11'.repeat(32)
const P2 = '22'.repeat(32)

describe('configuration', { timeout: 30_000 }, () => {
  it('refuses what cannot work, in plain words', () => {
    const base = { store: new MemoryStore() }
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: [], bytes: 1 })).toThrow(/at least one/)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: [A], bytes: undefined as never })).toThrow(/byte ceiling/)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: [A], bytes: 0 })).toThrow(/bytes/)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: ['http://x.onion'], bytes: 1 })).toThrow(/onion/)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: ['ftp://x.test'], bytes: 1 })).toThrow(/http/)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: [A, 'https://node-a.test:9'], bytes: 1 })).toThrow(/twice/)
    expect(GroupGrantKeeper.validate({ ...base, nodes: [A, B], bytes: '5' })).toEqual({
      nodes: [{ base: 'https://node-a.test:8080', server: 'node-a.test' }, { base: 'https://node-b.test', server: 'node-b.test' }], bytes: '5',
    })
  })
})

describe('configuration: the room\'s list', () => {
  const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://n${i}.example.net`)

  it('allows eight nodes and refuses nine, saying why', () => {
    const base = { store: new MemoryStore(), bytes: 1 }
    expect(GroupGrantKeeper.validate({ ...base, nodes: urls(8) }).nodes.length).toBe(8)
    expect(() => GroupGrantKeeper.validate({ ...base, nodes: urls(9) })).toThrow('group grants: at most 8 group nodes (the room\'s invitation lists at most 8)')
  })

  it('accepts an empty list only when withdrawn, and then needs no byte ceiling', () => {
    const store = new MemoryStore()
    expect(GroupGrantKeeper.validate({ store, nodes: [], bytes: '', withdrawn: true })).toEqual({ nodes: [], bytes: '' })
    expect(() => GroupGrantKeeper.validate({ store, nodes: [], bytes: 1 })).toThrow(/at least one/)
    expect(() => GroupGrantKeeper.validate({ store, nodes: [A], bytes: 1, withdrawn: true })).toThrow(/lists no group nodes/)
  })
})

describe('admission: minting', { timeout: 30_000 }, () => {
  it('signs one grant per device per node: authority key, fresh 16-byte id, three scopes, the ceiling, thirty days', async () => {
    const t = setup()
    const a = t.addDevice(P1)
    const b = t.addDevice(P2)
    const keeper = await t.make()
    await keeper.start()
    const l = keeper.ledger
    expect(l.grants.length).toBe(4)
    expect(new Set(l.grants.map((g) => g.id)).size).toBe(4)
    for (const g of l.grants) {
      const p = t.parsed(g.event)
      expect(p.signer).toBe(t.authority)
      expect(p.roomId).toBe(t.roomId)
      expect(g.id).toMatch(/^[0-9a-f]{32}$/)
      expect(p.scopes).toEqual(['upload', 'get', 'delete'])
      expect(p.bytes).toBe(1000n)
      expect(p.status).toBe('active')
      expect(p.expiration).toBe(p.createdAt + GRANT_LIFETIME_SECONDS)
      expect([a, b]).toContain(p.device)
      expect(['node-a.test', 'node-b.test']).toContain(p.server)
    }
    // Delivered in the room, one event per op, and pushed to the node each names.
    expect(t.grantOps().length).toBe(4)
    expect(t.grantOps().map((o) => o.event.id).sort()).toEqual(l.grants.map((g) => g.event.id).sort())
    await waitFor(() => t.nodes.posts.length === 4)
    expect(t.nodes.posts.every((p) => p.status === 201)).toBe(true)
    expect(t.nodes.postsTo('node-a.test').length).toBe(2)
    await waitFor(() => keeper.ledger.journal.length === 0)
    // Persisted: a ledger that reads back.
    expect(parseLedger(t.store.text!).grants.length).toBe(4)
  })

  it('draws the ids from the keeper\'s randomness, and never reuses one', async () => {
    let calls = 0
    const t = setup({ randomBytes: (n) => new Uint8Array(n).fill(++calls) })
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    expect(keeper.ledger.grants.map((g) => g.id).sort()).toEqual(['01'.repeat(16), '02'.repeat(16)])
  })

  it('mints once: a second sweep adds nothing for a device that has its grants', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await keeper.sweep()
    await keeper.sweep()
    expect(keeper.ledger.grants.length).toBe(2)
    expect(t.grantOps().length).toBe(2)
  })

  it('a device that arrives later (the keeper was offline) is granted at the next look', async () => {
    const t = setup()
    const keeper = await t.make()
    await keeper.start()
    expect(keeper.ledger.grants.length).toBe(0)
    t.addDevice(P1)
    keeper.noteRoster()
    await waitFor(() => keeper.ledger.grants.length === 2)
  })

  it('nothing for a removed participant, and nothing for one being removed', async () => {
    const t = setup()
    t.addDevice(P1)
    t.addDevice(P2)
    t.world.removed.add(P1)
    const keeper = await t.make()
    await keeper.start()
    expect(new Set(keeper.ledger.grants.map((g) => g.participant))).toEqual(new Set([P2]))
  })

  it('without configuration there is no keeper to speak of: the class is only built for one', () => {
    // RoomAgent builds GroupGrantKeeper only when `groupGrants` is given; see agent-group-grants.test.ts.
    expect(typeof GroupGrantKeeper.validate).toBe('function')
  })
})

describe('the sixth device', { timeout: 30_000 }, () => {
  it('gets no grant, the hosts are told once, and it is granted when a slot frees', async () => {
    const t = setup({}, new MemoryStore(), [A])
    const first = Array.from({ length: MAX_DEVICES_PER_PARTICIPANT }, () => t.addDevice(P1))
    const sixth = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    const l = keeper.ledger
    expect(new Set(l.grants.map((g) => g.device))).toEqual(new Set(first))
    expect(l.refused.map((r) => r.device)).toEqual([sixth])
    const errors = t.world.sent.filter((o) => o.op === 'error')
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatchObject({ op: 'error', host: 'cc'.repeat(32) })
    expect((errors[0] as { message: string }).message.length).toBeLessThanOrEqual(140)
    await keeper.sweep()
    expect(t.world.sent.filter((o) => o.op === 'error').length).toBe(1)
    // Somebody else's devices are not counted against P1.
    t.addDevice(P2)
    await keeper.sweep()
    expect(keeper.ledger.grants.some((g) => g.participant === P2)).toBe(true)
    // One of P1's devices stops being heard and its grant runs out: the sixth is let in.
    t.world.devices = t.world.devices.filter((d) => d.device !== first[0])
    t.tick(31 * DAY)
    await keeper.sweep()
    expect(keeper.ledger.grants.some((g) => g.device === sixth && g.status === 'active')).toBe(true)
    expect(keeper.ledger.refused).toEqual([])
  })
})

describe('renewal', { timeout: 30_000 }, () => {
  it('re-signs the same id with a later created_at and expiration once ten days or fewer are left, not before', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    const first = keeper.ledger.grants[0]!
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.tick(20 * DAY - 1)
    await keeper.sweep()
    expect(keeper.ledger.grants[0]!.event.id).toBe(first.event.id)
    t.tick(1)
    await keeper.sweep()
    const renewed = keeper.ledger.grants[0]!
    expect(keeper.ledger.grants.length).toBe(1)
    expect(renewed.id).toBe(first.id)
    expect(renewed.createdAt).toBeGreaterThan(first.createdAt)
    expect(renewed.expiration).toBe(renewed.createdAt + GRANT_LIFETIME_SECONDS)
    expect(renewed.expiration).toBeGreaterThan(first.expiration)
    expect(t.parsed(renewed.event).scopes).toEqual(['upload', 'get', 'delete'])
    // Sent in the room again, and pushed.
    expect(t.grantOps().at(-1)!.event.id).toBe(renewed.event.id)
    await waitFor(() => t.nodes.posts.some((p) => p.event.id === renewed.event.id && p.status === 201))
  })

  it('a device that is no longer heard is not renewed, and its grant simply ends', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    const first = keeper.ledger.grants[0]!
    t.world.devices = []
    t.tick(25 * DAY)
    await keeper.sweep()
    expect(keeper.ledger.grants[0]!.event.id).toBe(first.event.id)
    t.tick(5 * DAY + 3600)
    await keeper.sweep()
    expect(keeper.ledger.grants[0]!.status).toBe('ended')
  })

  it('a new ceiling applies to a renewal, and a participant removed meanwhile is revoked, not renewed', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.addDevice(P2)
    const first = await t.make()
    await first.start()
    first.close()
    const keeper = await t.make({ ...t.config, bytes: 2000 })
    t.tick(21 * DAY)
    t.world.removed.add(P2)
    await keeper.sweep()
    const mine = keeper.ledger.grants.filter((g) => g.participant === P1)
    expect(mine.length).toBe(1)
    expect(mine[0]!.createdAt).toBe(T0 + 21 * DAY)
    expect(t.parsed(mine[0]!.event).bytes).toBe(2000n)
    expect(keeper.ledger.grants.find((g) => g.participant === P2)!.status).toBe('revoked')
  })
})

describe('removal, in the order of 4.8', { timeout: 30_000 }, () => {
  it('records it, signs and pushes the revocations, then the rekey, then posts them', async () => {
    const t = setup()
    const a = t.addDevice(P1)
    const b = t.addDevice(P1)
    const c = t.addDevice(P2)
    const trace: string[] = []
    const traced = ((input: string, init: RequestInit) => {
      const e = JSON.parse(String(init.body)) as GroupEvent
      const revoked = e.tags.some((x) => x[0] === 'status' && x[1] === 'revoked')
      return t.nodes.fetch(input, init).then((r) => { if (revoked) trace.push('push'); return r })
    }) as unknown as typeof fetch
    const keeper = await t.make({ ...t.config, fetch: traced })
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    const before = new Map(keeper.ledger.grants.map((g) => [g.id, g]))
    t.store.onSave = (json) => { if ((JSON.parse(json) as { removing: string[] }).removing.includes(P1) && !trace.includes('recorded')) trace.push('recorded') }
    const sentBefore = t.world.sent.length
    await keeper.beforeRemoval(P1)
    trace.push('rekey')
    expect(t.world.sent.length).toBe(sentBefore) // nothing posted in the room before the rekey
    await keeper.afterRemoval(P1)
    expect(trace.indexOf('recorded')).toBe(0)
    expect(trace.indexOf('recorded')).toBeLessThan(trace.indexOf('push'))
    expect(trace.lastIndexOf('push')).toBeLessThan(trace.indexOf('rekey'))
    const ops = t.grantOps().slice(grantCount(t.world.sent, sentBefore))
    expect(ops.length).toBe(4) // two devices at two nodes
    // Every grant id of every device of the participant, at every node.
    const revoked = keeper.ledger.grants.filter((g) => g.participant === P1)
    expect(revoked.length).toBe(4)
    for (const g of revoked) {
      expect(g.status).toBe('revoked')
      const was = t.parsed(before.get(g.id)!.event)
      const now = t.parsed(g.event)
      expect(now.status).toBe('revoked')
      expect(now.scopes).toEqual(was.scopes)
      expect(now.bytes).toBe(was.bytes)
      expect(now.device).toBe(was.device)
      expect(now.server).toBe(was.server)
      expect(now.createdAt).toBeGreaterThan(was.createdAt)
      expect(now.expiration).toBe(was.expiration)
      expect([a, b]).toContain(now.device)
    }
    expect(keeper.ledger.grants.filter((g) => g.device === c).every((g) => g.status === 'active')).toBe(true)
    expect(keeper.ledger.removing).toEqual([])
    expect(t.nodes.posts.filter((p) => p.event.tags.some((x) => x[1] === 'revoked') && p.status === 201).length).toBe(4)
  })

  it('an unreachable node never holds the rekey back past the push budget', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.nodes.hang('node-b.test', true)
    const started = Date.now()
    await keeper.beforeRemoval(P1)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(t.nodes.postsTo('node-a.test').some((p) => p.event.tags.some((x) => x[1] === 'revoked'))).toBe(true)
    expect(keeper.ledger.journal.some((j) => j.server === 'node-b.test' && j.kind === 'revoked')).toBe(true)
  })

  it('a revocation for a grant already past its end is not signed; it ended', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.tick(30 * DAY + 3600)
    await keeper.beforeRemoval(P1)
    expect(keeper.ledger.grants[0]!.status).toBe('ended')
    expect(keeper.ledger.journal).toEqual([])
  })

  it('the node that is offline gets the revocation from the journal when it returns', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.nodes.setOffline('node-b.test', true)
    await keeper.beforeRemoval(P1)
    await keeper.afterRemoval(P1)
    await new Promise((r) => setTimeout(r, 60))
    expect(keeper.ledger.journal.filter((j) => j.server === 'node-b.test').length).toBe(1)
    expect(keeper.ledger.journal[0]!.tries).toBeGreaterThan(0)
    t.nodes.setOffline('node-b.test', false)
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect([...t.nodes.state('node-b.test').grants.values()].every((g) => g.status === 'revoked')).toBe(true)
  })

  it('revokes at a node no longer configured, using the address it remembers', async () => {
    const store = new MemoryStore()
    const t = setup({}, store)
    t.addDevice(P1)
    const first = await t.make()
    await first.start()
    await waitFor(() => first.ledger.journal.length === 0)
    first.close()
    const second = await t.make({ ...t.config, nodes: [A] })
    await second.beforeRemoval(P1)
    await waitFor(() => t.nodes.posts.filter((p) => p.host === 'node-b.test' && p.event.tags.some((x) => x[1] === 'revoked')).length === 1)
    expect(second.ledger.grants.every((g) => g.status === 'revoked')).toBe(true)
  })

  it('a removal begun before a stop is finished on the next start', async () => {
    const store = new MemoryStore()
    const t = setup({}, store, [A])
    t.addDevice(P1)
    const first = await t.make()
    await first.start()
    await first.beforeRemoval(P1) // the process stops here, before the rekey
    first.close()
    const second = await t.make()
    await second.start()
    expect(t.world.removeCalls).toEqual([P1])
    // And a removal whose rekey did happen only lacks the post in the room.
    t.world.sent.length = 0
    const third = await t.make()
    await third.start()
    expect(third.ledger.removing).toEqual([])
    expect(t.grantOps().length).toBe(1)
  })
})

describe('re-admission', { timeout: 30_000 }, () => {
  it('a device that returns under a new participant key gets a new id, and the node sees the old id revoked first', async () => {
    const t = setup({}, new MemoryStore(), [A])
    const device = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    const oldId = keeper.ledger.grants[0]!.id
    // The node is away when P1 is removed and the same device comes back as P2.
    t.nodes.setOffline('node-a.test', true)
    await keeper.beforeRemoval(P1)
    t.world.removed.add(P1)
    await keeper.afterRemoval(P1)
    t.world.devices = [{ device, participant: P2 }]
    await keeper.sweep()
    const fresh = keeper.ledger.grants.find((g) => g.participant === P2)!
    expect(fresh.id).not.toBe(oldId)
    expect(fresh.device).toBe(device)
    t.nodes.setOffline('node-a.test', false)
    await waitFor(() => keeper.ledger.journal.length === 0)
    const posts = t.nodes.postsTo('node-a.test')
    const order = posts.filter((p) => p.status === 201).map((p) => `${t.parsed(p.event).grantId === oldId ? 'old' : 'new'}:${t.parsed(p.event).status}`)
    expect(order).toEqual(['old:active', 'old:revoked', 'new:active'])
    expect(posts.some((p) => p.reason === 'scope-taken')).toBe(false)
    expect(keeper.ledger.journal).toEqual([])
  })

  it('a device that now speaks for somebody else loses the old grant first', async () => {
    const t = setup({}, new MemoryStore(), [A])
    const device = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    t.world.devices = [{ device, participant: P2 }]
    await keeper.sweep()
    const l = keeper.ledger
    expect(l.grants.find((g) => g.participant === P1)!.status).toBe('revoked')
    expect(l.grants.find((g) => g.participant === P2)!.status).toBe('active')
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect(t.nodes.posts.every((p) => p.status === 201 || p.status === 200)).toBe(true)
  })
})

describe('never two events for one id in one second', { timeout: 30_000 }, () => {
  it('stamps grant, renewal and revocation of one id in strictly later seconds even if the clock stands still', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    t.tick(20 * DAY)
    await keeper.sweep() // renewal
    await waitFor(() => keeper.ledger.journal.length === 0)
    await keeper.beforeRemoval(P1) // revocation, same second
    await waitFor(() => keeper.ledger.journal.length === 0)
    const stamps = t.nodes.posts.map((p) => p.event.created_at)
    expect(stamps.length).toBe(3)
    expect(stamps[1]).toBeGreaterThan(stamps[0]!)
    expect(stamps[2]).toBeGreaterThan(stamps[1]!)
    expect(t.nodes.posts.map((p) => p.status)).toEqual([201, 201, 201])
  })
})

describe('close', { timeout: 30_000 }, () => {
  it('signs a reset per node: t, d, server, expiration ninety days on, sent in the room, then pushed', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    const sentBefore = t.world.sent.length
    await keeper.beforeClose()
    const ops = t.grantOps().slice(sentBefore).map((o) => o.event)
    expect(ops.length).toBe(2)
    for (const e of ops) {
      expect(e.tags.map((x) => x[0])).toEqual(['t', 'd', 'server', 'expiration'])
      expect(e.tags[0]![1]).toBe('reset')
      expect(e.tags[1]![1]).toBe(t.roomId)
      expect(Number(e.tags[3]![1])).toBe(e.created_at + 90 * DAY)
    }
    expect(ops.map((e) => e.tags[2]![1]).sort()).toEqual(['node-a.test', 'node-b.test'])
    await waitFor(() => t.nodes.posts.filter((p) => p.event.tags[0]![1] === 'reset' && p.status === 201).length === 2)
    expect(keeper.ledger.grants.every((g) => g.status === 'ended')).toBe(true)
    // A closed keeper mints nothing.
    t.addDevice(P2)
    await keeper.sweep()
    expect(keeper.ledger.grants.every((g) => g.participant === P1)).toBe(true)
  })

  it('a node that cannot be reached does not hold the close', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    t.nodes.hang('node-a.test', true)
    t.nodes.setOffline('node-b.test', true)
    const started = Date.now()
    await keeper.beforeClose()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('the journal', { timeout: 30_000 }, () => {
  it('survives a restart: a pending event is pushed by the next keeper, and nothing is minted twice', async () => {
    const store = new MemoryStore()
    const t = setup({}, store, [A])
    t.addDevice(P1)
    t.nodes.setOffline('node-a.test', true)
    const first = await t.make()
    await first.start()
    await new Promise((r) => setTimeout(r, 30))
    expect(first.ledger.journal.length).toBe(1)
    const id = first.ledger.grants[0]!.id
    first.close()
    t.nodes.setOffline('node-a.test', false)
    const second = await t.make()
    await second.start()
    await waitFor(() => second.ledger.journal.length === 0)
    expect(second.ledger.grants.map((g) => g.id)).toEqual([id])
    expect(t.nodes.posts.filter((p) => p.status === 201).length).toBe(1)
  })

  for (const code of [429, 503, 502, 504]) {
    it(`keeps the entry and retries after ${code}`, async () => {
      const t = setup({}, new MemoryStore(), [A])
      t.addDevice(P1)
      t.nodes.script('node-a.test', { status: code, reason: 'rate' }, { status: code })
      const keeper = await t.make()
      await keeper.start()
      await waitFor(() => t.nodes.posts.some((p) => p.status === 201))
      expect(t.nodes.posts.map((p) => p.status)).toEqual([code, code, 201])
      expect(keeper.ledger.journal).toEqual([])
    })
  }

  it('keeps the entry and retries after a network error, with a backoff that grows', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.nodes.setOffline('node-a.test', true)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => (keeper.ledger.journal[0]?.tries ?? 0) >= 3)
    expect(keeper.ledger.journal[0]!.stopped).toBeUndefined()
    t.nodes.setOffline('node-a.test', false)
    await waitFor(() => keeper.ledger.journal.length === 0)
  })

  for (const [status, reason] of [[200, 'unchanged'], [201, 'accepted'], [409, 'stale']] as const) {
    it(`is finished, silently, by ${status} ${reason}`, async () => {
      const t = setup({}, new MemoryStore(), [A])
      t.addDevice(P1)
      t.nodes.script('node-a.test', { status, reason })
      const keeper = await t.make()
      await keeper.start()
      await waitFor(() => keeper.ledger.journal.length === 0)
      expect(t.nodes.posts.length).toBe(1)
      expect(t.world.sent.filter((o) => o.op === 'error')).toEqual([])
    })
  }

  for (const [status, reason] of [[400, 'malformed'], [401, 'signature'], [403, 'keeper'], [403, 'server'], [413, 'too-large'], [404, ''], [501, ''], [409, 'key-conflict'], [409, 'scope-taken'], [409, 'floor']] as const) {
    it(`stops after ${status} ${reason}, and tells the hosts, once`, async () => {
      const t = setup({}, new MemoryStore(), [A])
      t.addDevice(P1)
      t.nodes.script('node-a.test', { status, reason })
      const keeper = await t.make()
      await keeper.start()
      await waitFor(() => keeper.ledger.journal[0]?.stopped !== undefined)
      await new Promise((r) => setTimeout(r, 60))
      // The refused grant is not retried; what follows is the keeper's revocation of an id the node never recorded.
      expect(t.nodes.posts.filter((p) => t.parsed(p.event).status === 'active').length).toBe(1)
      await waitFor(() => t.world.sent.some((o) => o.op === 'error'))
      const errors = t.world.sent.filter((o) => o.op === 'error') as { op: 'error'; host: string; message: string }[]
      expect(errors.length).toBe(1)
      expect(errors[0]!.host).toBe('cc'.repeat(32))
      expect(errors[0]!.message).toContain('node-a.test')
      // Plain advice for the two refusals that have a cure of their own; the status for the rest.
      expect(errors[0]!.message).toMatch(reason === 'scope-taken' ? /--group-reset/ : reason === 'floor' ? /later one/ : new RegExp(String(status)))
      expect(errors[0]!.message.length).toBeLessThanOrEqual(140)
      expect(t.logs.some((l) => l.includes('node-a.test') && l.includes(String(status)))).toBe(true)
    })
  }

  it('re-announces an open problem to somebody who arrives, at most every ten minutes', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 403, reason: 'keeper' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => t.world.sent.some((o) => o.op === 'error'))
    // Just told: not told again to somebody who arrives straight after.
    await keeper.announceProblems()
    expect(t.world.sent.filter((o) => o.op === 'error').length).toBe(1)
    t.tick(601)
    await keeper.announceProblems()
    expect(t.world.sent.filter((o) => o.op === 'error').length).toBe(2)
    await keeper.announceProblems()
    expect(t.world.sent.filter((o) => o.op === 'error').length).toBe(2)
  })

  it('a pending grant superseded by a revocation is not pushed: only the revocation reaches the node', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.nodes.setOffline('node-a.test', true)
    const keeper = await t.make()
    await keeper.start()
    await keeper.beforeRemoval(P1)
    t.nodes.setOffline('node-a.test', false)
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect(t.nodes.posts.map((p) => t.parsed(p.event).status)).toEqual(['revoked'])
    expect(t.nodes.posts[0]!.status).toBe(201)
  })
})

describe('storage-grant?', { timeout: 30_000 }, () => {
  it('answers the asking device with its own live grants, and not more than once in thirty seconds', async () => {
    const t = setup({}, new MemoryStore(), [A, B])
    const a = t.addDevice(P1)
    t.addDevice(P2)
    const keeper = await t.make()
    await keeper.start()
    const sent = t.world.sent.length
    await keeper.answer(a, P1)
    const reply = t.grantOps().slice(grantCount(t.world.sent, sent))
    expect(reply.length).toBe(2)
    expect(reply.every((o) => t.parsed(o.event).device === a)).toBe(true)
    const after = t.world.sent.length
    await keeper.answer(a, P1)
    expect(t.world.sent.length).toBe(after)
    t.tick(31)
    await keeper.answer(a, P1)
    expect(t.world.sent.length).toBe(after + 2)
  })

  it('says nothing to a removed participant, to a device that is not its participant\'s, or to a stranger', async () => {
    const t = setup({}, new MemoryStore(), [A])
    const a = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    const sent = t.world.sent.length
    await keeper.answer(a, P2) // somebody else's participant on that device
    await keeper.answer(hex32(), P1)
    t.world.removed.add(P1)
    await keeper.answer(a, P1)
    expect(t.world.sent.length).toBe(sent)
  })
})

function grantCount(sent: ControlMessage[], before: number): number {
  return sent.slice(0, before).filter((o) => o.op === 'storage-grant').length
}

describe('an unreadable ledger, and --group-reset', { timeout: 30_000 }, () => {
  it('refuses to start without the flag, names it, and leaves the file alone', async () => {
    const store = new MemoryStore('{ not a ledger')
    const t = setup({}, store, [A])
    await expect(GroupGrantKeeper.open(t.config, t.host)).rejects.toThrow(/--group-reset/)
    expect(store.text).toBe('{ not a ledger')
    expect(store.moved).toEqual([])
    const damaged = new MemoryStore(JSON.stringify({ v: 1, bases: {}, floors: {}, grants: [{ id: 'x' }], journal: [], removing: [], refused: [], resets: [] }))
    await expect(GroupGrantKeeper.open({ ...t.config, store: damaged }, t.host)).rejects.toThrow(/--group-reset/)
  })

  it('with the flag moves it aside (never deletes), signs a reset per node first, journals and pushes them, then mints after the floor', async () => {
    const store = new MemoryStore('{ not a ledger')
    const t = setup({ resetUnreadable: true }, store, [A, B])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    expect(store.moved).toEqual([{ at: T0, text: '{ not a ledger' }])
    await waitFor(() => keeper.ledger.journal.length === 0)
    const posts = t.nodes.posts
    // Each node saw its reset before any grant, and no grant was refused for the floor.
    for (const host of ['node-a.test', 'node-b.test']) {
      const mine = posts.filter((p) => p.host === host)
      expect(mine[0]!.event.tags[0]![1]).toBe('reset')
      expect(mine.slice(1).every((p) => p.event.tags[0]![1] === 'grant')).toBe(true)
    }
    expect(posts.some((p) => p.status === 409)).toBe(false)
    expect(keeper.ledger.floors['node-a.test']).toBe(T0)
    for (const g of keeper.ledger.grants) expect(g.createdAt).toBeGreaterThan(keeper.ledger.floors[g.server]!)
    // The reset is also sent in the room, where any member may carry it to a node.
    expect(t.grantOps().filter((o) => o.event.tags[0]![1] === 'reset').length).toBe(2)
  })

  it('minting in the same second as a reset never earns a 409 floor, whatever order the node sees them in', async () => {
    const store = new MemoryStore()
    const t = setup({}, store, [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    await keeper.beforeClose() // a reset in this second
    const resetAt = keeper.ledger.floors['node-a.test']!
    expect(resetAt).toBe(T0)
    // A keeper that comes back to a room it did not really close mints in that same second.
    keeper.close()
    const again = await t.make({ ...t.config })
    t.world.devices = [{ device: hex32(), participant: P2 }]
    await again.start()
    await waitFor(() => again.ledger.journal.length === 0)
    expect(t.nodes.posts.filter((p) => p.reason === 'floor')).toEqual([])
    const fresh = again.ledger.grants.filter((g) => g.participant === P2)
    expect(fresh.length).toBe(1)
    expect(fresh[0]!.createdAt).toBeGreaterThan(resetAt)
    expect(t.nodes.posts.at(-1)!.status).toBe(201)
  })

  it('a readable ledger makes the flag unnecessary: it is ignored, with a line saying so', async () => {
    const store = new MemoryStore()
    const t = setup({}, store, [A])
    t.addDevice(P1)
    const first = await t.make()
    await first.start()
    first.close()
    const second = await t.make({ ...t.config, resetUnreadable: true })
    await second.start()
    expect(store.moved).toEqual([])
    expect(second.ledger.grants.length).toBe(1)
    expect(t.logs.some((l) => l.includes('--group-reset') && l.includes('ignored'))).toBe(true)
  })
})

describe('what is logged', { timeout: 30_000 }, () => {
  it('never an event, a signature, a key or a grant id', async () => {
    const t = setup()
    t.addDevice(P1)
    t.addDevice(P2)
    t.nodes.script('node-a.test', { status: 403, reason: 'keeper' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.some((j) => j.stopped !== undefined))
    await keeper.beforeRemoval(P1)
    await keeper.afterRemoval(P1)
    await keeper.beforeClose()
    await new Promise((r) => setTimeout(r, 30))
    expect(t.logs.length).toBeGreaterThan(0)
    for (const line of t.logs) expect(line).not.toMatch(/[0-9a-f]{16,}/)
  })
})
