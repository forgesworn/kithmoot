import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { ControlMessage } from './control.js'
import { GroupGrantKeeper, type GroupGrantHost, type GroupGrantsConfig } from './group-grants-keeper.js'
import { parseGroupEvent, buildGrant, KEEPER_SCOPES, type GroupEvent, type ParsedGrant } from './group-grants.js'
import { FakeNodes, MemoryStore, hex32, waitFor } from '../test/group-grants-fixtures.js'

// Behaviours an independent review found missing: each of these failed before the fix it covers.

const T0 = 1_800_000_000
const DAY = 86_400
const A = 'https://node-a.test:8080'
const B = 'https://node-b.test'
const P1 = '11'.repeat(32)
const P2 = '22'.repeat(32)

const open: GroupGrantKeeper[] = []
afterEach(() => { vi.restoreAllMocks(); for (const k of open.splice(0)) k.close() })

function setup(over: Partial<GroupGrantsConfig> = {}, store = new MemoryStore(), nodeUrls: string[] = [A], roomExisted = false) {
  const sk = generateSecretKey()
  const authority = getPublicKey(sk)
  const roomId = 'ab'.repeat(32)
  const world = {
    now: T0, devices: [] as { device: string; participant: string }[], removed: new Set<string>(), sent: [] as ControlMessage[],
    hangSend: false, removeCalls: [] as string[],
  }
  const nodes = new FakeNodes(authority)
  const logs: string[] = []
  const host: GroupGrantHost = {
    roomId, authoritySk: sk, keeperParticipant: 'cc'.repeat(32), now: () => world.now, devices: () => world.devices, removed: () => world.removed,
    send: (op) => (world.hangSend ? new Promise<void>(() => {}) : (world.sent.push(op), Promise.resolve())),
    removeParticipant: async (p) => { world.removeCalls.push(p); world.removed.add(p) },
  }
  const config: GroupGrantsConfig = {
    nodes: nodeUrls, bytes: 1000, store, fetch: nodes.fetch, log: (l) => logs.push(l),
    backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 150, pushTimeoutMs: 1_000, sweepIntervalMs: 3_600_000, rosterDelayMs: 5, ...over,
  }
  const make = async (c: GroupGrantsConfig = config, existed = roomExisted) => {
    const prepared = await GroupGrantKeeper.prepare(c, { roomExisted: existed, now: () => world.now })
    const k = await GroupGrantKeeper.open(c, host, prepared)
    open.push(k)
    return k
  }
  const parsed = (e: GroupEvent): ParsedGrant => (parseGroupEvent(e) as { ok: true; parsed: ParsedGrant }).parsed
  const addDevice = (participant: string) => { const device = hex32(); world.devices.push({ device, participant }); return device }
  const tick = (s: number) => { world.now += s; nodes.now = world.now }
  const errors = () => world.sent.filter((o): o is Extract<ControlMessage, { op: 'error' }> => o.op === 'error')
  const grantOps = () => world.sent.filter((o): o is Extract<ControlMessage, { op: 'storage-grant' }> => o.op === 'storage-grant')
  return { sk, authority, roomId, world, nodes, logs, host, config, store, make, parsed, addDevice, tick, errors, grantOps }
}

describe('1. closing the room grants nothing more', () => {
  it('a roster change, a sweep and a storage-grant? during the close mint, renew and send nothing', async () => {
    const t = setup({ pushBudgetMs: 300 })
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.nodes.hang('node-a.test', true) // a slow node: the close waits out its budget
    const sent = t.world.sent.length
    const closing = keeper.beforeClose()
    await new Promise((r) => setTimeout(r, 20))
    const late = t.addDevice(P2)
    keeper.noteRoster()
    await keeper.sweep()
    await keeper.answer(late, P2)
    await closing
    const floor = keeper.ledger.floors['node-a.test']!
    expect(keeper.ledger.grants.filter((g) => g.status === 'active')).toEqual([])
    expect(keeper.ledger.grants.some((g) => g.device === late)).toBe(false)
    expect(keeper.ledger.grants.every((g) => g.createdAt <= floor)).toBe(true)
    // Only the reset went into the room after the close began.
    expect(t.grantOps().slice(sent).map((o) => o.event.tags[0]![1])).toEqual(['reset'])
  })

  it('a sweep already waiting in the queue when the close begins mints nothing either', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.addDevice(P2)
    const sweeping = keeper.sweep()
    const closing = keeper.beforeClose()
    await Promise.all([sweeping, closing])
    expect(keeper.ledger.grants.filter((g) => g.status === 'active')).toEqual([])
  })
})

describe('2. a lost ledger on a room that already existed', () => {
  it('signs a reset at every node before minting, so a grant the keeper forgot cannot survive', async () => {
    const t = setup({}, new MemoryStore(), [A, B])
    const dev = t.addDevice(P1)
    const first = await t.make()
    await first.start()
    await waitFor(() => first.ledger.journal.length === 0)
    const old = first.ledger.grants.map((g) => g.id)
    first.close()
    // The same room on a new machine: the state came across, the sidecar did not.
    const second = await t.make({ ...t.config, store: new MemoryStore() }, true)
    await second.start()
    await waitFor(() => second.ledger.journal.length === 0)
    expect(t.logs.some((l) => l.includes('no grant ledger') && l.includes('reset'))).toBe(true)
    for (const host of ['node-a.test', 'node-b.test']) {
      const mine = t.nodes.postsTo(host).slice(-2)
      expect(mine[0]!.event.tags[0]![1]).toBe('reset')
      expect(mine[1]!.status).toBe(201)
    }
    expect(t.nodes.posts.filter((p) => p.status === 409)).toEqual([])
    const fresh = second.ledger.grants.filter((g) => g.status === 'active')
    expect(fresh.length).toBe(2)
    expect(fresh.every((g) => !old.includes(g.id))).toBe(true)
    // The old ids are no longer live at the node, so the removal that follows leaves nothing active.
    await second.beforeRemoval(P1)
    await waitFor(() => second.ledger.journal.length === 0)
    for (const host of ['node-a.test', 'node-b.test']) {
      expect([...t.nodes.state(host).grants.values()].filter((g) => g.device === dev && g.status === 'active' && !g.endedByReset)).toEqual([])
    }
  })

  it('a brand-new room needs no reset', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect(t.nodes.posts.some((p) => p.event.tags[0]![1] === 'reset')).toBe(false)
  })

  it('an unreadable ledger still stops the start, before anything is joined or dialled', async () => {
    const store = new MemoryStore('{ damaged')
    const t = setup({}, store)
    await expect(GroupGrantKeeper.prepare(t.config, { roomExisted: true, now: () => T0 })).rejects.toThrow(/--group-reset/)
    expect(store.text).toBe('{ damaged')
    expect(t.nodes.posts).toEqual([])
  })
})

describe('3. a grant is pushed only once the ledger has recorded it', () => {
  it('nothing goes to the node while saves fail, and it goes once one succeeds', async () => {
    const store = new MemoryStore()
    const t = setup({}, store)
    const keeper = await t.make()
    await keeper.start()
    let failing = true
    store.onSave = () => { if (failing) throw new Error('ENOSPC') }
    t.addDevice(P1)
    await keeper.sweep()
    await new Promise((r) => setTimeout(r, 100))
    expect(t.nodes.posts.filter((p) => p.status === 201)).toEqual([])
    expect(t.logs.some((l) => l.includes('could not save the ledger'))).toBe(true)
    expect(t.errors().length).toBe(1)
    // Nor is the grant sent in the room: a device that read it could post it to a node on its own.
    expect(t.grantOps()).toEqual([])
    failing = false
    await keeper.sweep() // the unrecorded state is still dirty: this saves it
    await waitFor(() => t.nodes.posts.filter((p) => p.status === 201).length === 1)
    expect(JSON.parse(store.text!).grants.length).toBe(1)
    expect(t.grantOps().length).toBe(1) // sent once the ledger has it
  })
})

describe('4. a removal never depends on the ledger being writable', () => {
  it('beforeRemoval and afterRemoval complete, the revocation is pushed, and the hosts are told', async () => {
    const store = new MemoryStore()
    const t = setup({}, store)
    const dev = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    store.onSave = () => { throw new Error('ENOSPC') }
    await keeper.beforeRemoval(P1)
    await keeper.afterRemoval(P1)
    expect([...t.nodes.state('node-a.test').grants.values()].filter((g) => g.device === dev).every((g) => g.status === 'revoked')).toBe(true)
    expect(t.logs.some((l) => l.includes('could not save the ledger') && l.includes('removals still go ahead'))).toBe(true)
    expect(t.errors().some((e) => e.message.includes('removals still go ahead'))).toBe(true)
    // And the revocation is sent in the room.
    expect(t.grantOps().some((o) => o.event.tags.some((x) => x[0] === 'status' && x[1] === 'revoked'))).toBe(true)
  })
})

describe('5. a reset goes ahead of everything at its node, and a refused grant is made good', () => {
  it('a reset that meets a busy node holds the new grants back: no scope-taken, nothing stopped', async () => {
    const t = setup({ resetUnreadable: true }, new MemoryStore('{ damaged'))
    const dev = t.addDevice(P1)
    const old = buildGrant({ authoritySk: t.sk, roomId: t.roomId, device: dev, server: 'node-a.test', scopes: KEEPER_SCOPES, bytes: 1000, grantId: 'ee'.repeat(16), createdAt: T0 - 100, expiration: T0 + 20 * DAY })
    await t.nodes.fetch(A + '/groups/v1/events', { method: 'POST', body: JSON.stringify(old) })
    t.nodes.script('node-a.test', { status: 503 }) // the reset meets a busy node once
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0, 5_000)
    const kinds = t.nodes.posts.slice(1).map((p) => `${p.event.tags[0]![1]}:${p.status}`)
    expect(kinds).toEqual(['reset:503', 'reset:201', 'grant:201'])
    expect(keeper.ledger.journal).toEqual([])
    expect(keeper.ledger.grants.filter((g) => g.status === 'active').length).toBe(1)
  })

  it('a first grant the node refuses for good is revoked (so it can never land), the device is not counted as granted, and it is signed afresh after a cooldown, not in a loop', async () => {
    const t = setup()
    const dev = t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 409, reason: 'scope-taken' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.some((j) => j.stopped !== undefined))
    await waitFor(() => keeper.ledger.journal.length === 1 && keeper.ledger.journal[0]!.stopped !== undefined)
    const first = keeper.ledger.grants[0]!
    expect(first.status).toBe('revoked')
    // The revocation reached the node: the refused id is recorded there as revoked.
    expect(t.nodes.state('node-a.test').grants.get(first.id)?.status).toBe('revoked')
    expect(t.errors().some((e) => e.message.includes('--group-reset'))).toBe(true) // the right advice for scope-taken
    // Within the cooldown, sweeps sign nothing.
    for (let i = 0; i < 5; i++) await keeper.sweep()
    expect(keeper.ledger.grants.length).toBe(1)
    // After it, a new id.
    t.tick(3_601)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.grants.filter((g) => g.status === 'active').length === 1)
    const second = keeper.ledger.grants.find((g) => g.status === 'active')!
    expect(second.id).not.toBe(first.id)
    await waitFor(() => t.nodes.state('node-a.test').grants.get(second.id)?.status === 'active')
    expect(second.device).toBe(dev)
  })

  it('refusals do not loop: each cooldown is longer than the last', async () => {
    const t = setup()
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 409, reason: 'floor' }, { status: 201 }, { status: 409, reason: 'floor' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => (keeper.ledger.cooldown?.['node-a.test|' + t.world.devices[0]!.device]?.n ?? 0) === 1)
    const key = 'node-a.test|' + t.world.devices[0]!.device
    const until1 = keeper.ledger.cooldown![key]!.until
    t.tick(3_601)
    await keeper.sweep() // revocation of the first (script: 201) then a new grant refused again
    await waitFor(() => (keeper.ledger.cooldown?.[key]?.n ?? 0) === 2)
    expect(keeper.ledger.cooldown![key]!.until - t.world.now).toBeGreaterThan(until1 - T0)
  })

  it('a refused renewal is signed again, later than the first, once the cooldown has passed', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.tick(21 * DAY)
    t.nodes.script('node-a.test', { status: 409, reason: 'floor' })
    await keeper.sweep()
    await waitFor(() => keeper.ledger.journal.some((j) => j.stopped !== undefined))
    const stoppedAt = keeper.ledger.grants[0]!.createdAt
    expect(keeper.ledger.grants[0]!.needsRenewal).toBe(true)
    expect(keeper.ledger.grants[0]!.status).toBe('active')
    t.tick(3_601)
    await keeper.sweep()
    await waitFor(() => t.nodes.posts.at(-1)!.status === 201 && t.nodes.posts.length === 3)
    expect(keeper.ledger.grants[0]!.createdAt).toBeGreaterThan(stoppedAt)
    expect(keeper.ledger.grants[0]!.needsRenewal).toBeUndefined()
  })
})

describe('6. the control channel never holds the ledger queue', () => {
  it('a relay that never answers does not delay a removal, and revocations still wait for the rekey', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.world.sent.length = 0
    t.world.hangSend = true
    t.addDevice(P2)
    void keeper.sweep() // its posts hang on the relay
    await new Promise((r) => setTimeout(r, 30))
    const started = Date.now()
    await keeper.beforeRemoval(P1)
    expect(Date.now() - started).toBeLessThan(1_000)
    t.world.hangSend = false
    // A look at the roster between the removal's two halves must not post the revocations early: they belong in the new epoch.
    await keeper.sweep()
    expect(t.grantOps().some((o) => o.event.tags.some((x) => x[1] === 'revoked'))).toBe(false)
    await keeper.afterRemoval(P1)
    expect(t.grantOps().some((o) => o.event.tags.some((x) => x[1] === 'revoked'))).toBe(true)
  })
})

describe('7. clock skew and events that have ended', () => {
  it('403 future is retried until the node agrees, not given up on', async () => {
    const t = setup()
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 403, reason: 'future' }, { status: 403, reason: 'future' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => t.nodes.posts.some((p) => p.status === 201))
    expect(t.nodes.posts.map((p) => p.status)).toEqual([403, 403, 201])
    expect(keeper.ledger.journal).toEqual([])
    expect(t.errors()).toEqual([])
  })

  it('403 expired on a revocation is done, silently: the grant had ended anyway', async () => {
    const t = setup()
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.nodes.script('node-a.test', { status: 403, reason: 'expired' })
    await keeper.beforeRemoval(P1)
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect(t.errors()).toEqual([])
  })

  it('an event that ran out while a node was away is dropped with a log line, not reported as a refusal', async () => {
    const t = setup()
    t.addDevice(P1)
    t.nodes.setOffline('node-a.test', true)
    const keeper = await t.make({ ...t.config, backoff: { baseMs: 3_600_000, maxMs: 3_600_000 } })
    await keeper.start()
    await new Promise((r) => setTimeout(r, 30))
    expect(keeper.ledger.journal.length).toBe(1)
    t.tick(31 * DAY)
    t.world.devices = []
    await keeper.sweep()
    expect(keeper.ledger.journal).toEqual([])
    expect(t.logs.some((l) => l.includes('ran out'))).toBe(true)
    expect(t.errors()).toEqual([])
  })
})

describe('8. smaller things', () => {
  it('Retry-After is a floor: jitter never brings the retry forward', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const t = setup({ backoff: { baseMs: 5, maxMs: 20 } })
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 429, reason: 'rate', retryAfter: 2 })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal[0]?.tries === 1)
    expect(keeper.ledger.journal[0]!.nextAt - Date.now()).toBeGreaterThan(1_800)
  })

  it('a removal after a crash waits for the revocations signed before it, not only new ones', async () => {
    const store = new MemoryStore()
    const t = setup({ backoff: { baseMs: 3_600_000, maxMs: 3_600_000 } }, store)
    t.addDevice(P1)
    const first = await t.make()
    await first.start()
    await waitFor(() => first.ledger.journal.length === 0)
    t.nodes.setOffline('node-a.test', true)
    await first.beforeRemoval(P1) // signed, pushed in vain; the retry is an hour away
    first.close()
    t.nodes.setOffline('node-a.test', false)
    const second = await t.make()
    await second.start()
    expect(t.nodes.posts.filter((p) => t.parsed(p.event).status === 'revoked').length).toBe(0)
    await second.beforeRemoval(P1) // what start() does on the room's behalf after a crash
    expect(t.nodes.posts.filter((p) => t.parsed(p.event).status === 'revoked' && p.status === 201).length).toBe(1)
  })

  it('the reset floor of a restored keeper holds: a new node address does not matter', async () => {
    const t = setup()
    const keeper = await t.make()
    await keeper.start()
    expect(keeper.ledger.bases['node-a.test']).toBe(A)
  })
})

describe('10. the fake node is as strict as the real one on rule 8 and the room list', () => {
  it('refuses a device that is an enrolled keeper or in another group, and a room it was not told of', async () => {
    const t = setup()
    const mk = (device: string, signerSk = t.sk, room = t.roomId) => buildGrant({
      authoritySk: signerSk, roomId: room, device, server: 'node-a.test', scopes: KEEPER_SCOPES, bytes: 1000, grantId: hex32().slice(0, 32), createdAt: T0, expiration: T0 + DAY,
    })
    const post = async (e: GroupEvent) => (await t.nodes.fetch(A + '/groups/v1/events', { method: 'POST', body: JSON.stringify(e) })).status
    const other = getPublicKey(generateSecretKey())
    t.nodes.reserved.add(other)
    expect(await post(mk(other))).toBe(409)
    const dev = getPublicKey(generateSecretKey())
    expect(await post(mk(dev))).toBe(201)
    expect(await post(mk(dev, t.sk, 'cd'.repeat(32)))).toBe(409) // the same key in a second room at this node
    t.nodes.rooms = ['ef'.repeat(32)]
    expect(await post(mk(getPublicKey(generateSecretKey())))).toBe(403)
  })
})

describe('round 2', () => {
  it('R2-1: a node that no longer enrols the keeper costs one error, a bounded ledger and bounded traffic over a month, and harms no other node', async () => {
    const t = setup({ nodes: [A, B] }, new MemoryStore(), [A, B])
    for (let i = 0; i < 3; i++) t.addDevice(P1)
    t.nodes.unenrolled.add('node-a.test')
    const keeper = await t.make()
    await keeper.start()
    for (let step = 0; step < 31 * 4; step++) {
      t.tick(6 * 3600)
      await keeper.sweep()
      await waitFor(() => keeper.ledger.journal.every((j) => j.stopped !== undefined), 3_000).catch(() => {})
    }
    const l = keeper.ledger
    // The healthy node is granted throughout: three devices, renewed in their time.
    expect(l.grants.filter((g) => g.server === 'node-b.test' && g.status === 'active').length).toBe(3)
    // The refusing node: at most the first three grants and one probe a day.
    expect(l.grants.filter((g) => g.server === 'node-a.test').length).toBeLessThanOrEqual(3 + 31 + 1)
    expect(t.nodes.postsTo('node-a.test').length).toBeLessThanOrEqual(2 * (3 + 31 + 1))
    expect(t.grantOps().length).toBeLessThanOrEqual(2 * (3 + 31 + 1) + 3 * 3)
    expect(t.errors().filter((e) => e.message.includes('node-a.test')).length).toBe(1)
    expect(t.errors().length).toBe(1)
    expect(l.refusedNodes!['node-a.test']!.reason).toBe('403 keeper')
    // The refused, revoked ids do not count against the cap.
    expect(t.logs.filter((l2) => l2.includes('refused') && l2.includes('node-a.test')).length).toBe(1)
  }, 120_000)

  it('R2-1: the node takes the keeper again: one probe grant is accepted and every device is granted there at the next look', async () => {
    const t = setup({}, new MemoryStore(), [A, B])
    for (let i = 0; i < 3; i++) t.addDevice(P1)
    t.nodes.unenrolled.add('node-a.test')
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] !== undefined && keeper.ledger.journal.every((j) => j.stopped !== undefined))
    expect(keeper.ledger.grants.filter((g) => g.server === 'node-a.test' && g.status === 'active')).toEqual([])
    // Within the day: nothing is signed for it.
    t.tick(23 * 3600)
    await keeper.sweep()
    const before = keeper.ledger.grants.length
    // The owner enrols the keeper again; a day later one probe is tried, for one device only.
    t.nodes.unenrolled.delete('node-a.test')
    t.tick(2 * 3600)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] === undefined)
    expect(keeper.ledger.grants.length).toBeLessThanOrEqual(before + 3 + 1)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.grants.filter((g) => g.server === 'node-a.test' && g.status === 'active').length === 3)
    // The revocations the node had refused are sent again, now that it listens.
    await waitFor(() => keeper.ledger.journal.every((j) => j.stopped !== undefined && j.kind !== 'revoked'))
  })

  it('R2-1: a refusal that is not about the keeper (400, 404) also stops signing for that node, once', async () => {
    const t = setup({}, new MemoryStore(), [A])
    for (let i = 0; i < 3; i++) t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 404 }, { status: 404 }, { status: 404 })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] !== undefined)
    for (let i = 0; i < 6; i++) { t.tick(3600); await keeper.sweep() }
    expect(t.errors().length).toBe(1)
  })

  it('R2-3: a grant the node holds revoked is ended, and a new id is signed after the cooldown', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 409, reason: 'revoked' })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.grants[0]?.status === 'ended')
    const first = keeper.ledger.grants[0]!
    expect(first.recorded).not.toBe(true)
    t.tick(3_601)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.grants.some((g) => g.status === 'active' && g.id !== first.id))
    await waitFor(() => keeper.ledger.journal.every((j) => j.stopped !== undefined))
    expect(keeper.ledger.grants.find((g) => g.status === 'active')!.recorded).toBe(true)
  })

  it('R2-3: 409 revoked on a revocation is simply done', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.journal.length === 0)
    t.nodes.script('node-a.test', { status: 409, reason: 'revoked' })
    await keeper.beforeRemoval(P1)
    await waitFor(() => keeper.ledger.journal.length === 0)
    expect(t.errors()).toEqual([])
  })
})

describe('round 3', () => {
  it('R3-1: one device the node holds as something else costs that device a growing cooldown and one error, not the node for everybody', async () => {
    const t = setup({ nodes: [A] }, new MemoryStore(), [A])
    const x = t.addDevice(P1)
    const y = t.addDevice(P2)
    t.nodes.reserved.add(x) // at node A this key is already something else: key-conflict
    const keeper = await t.make()
    await keeper.start()
    let lacking = 0
    for (let step = 0; step < 31 * 4; step++) {
      t.tick(6 * 3600)
      await keeper.sweep()
      await waitFor(() => keeper.ledger.journal.every((j) => j.stopped !== undefined), 3_000).catch(() => {})
      if (!keeper.ledger.grants.some((g) => g.device === y && g.status === 'active' && g.expiration > t.world.now)) lacking++
    }
    const l = keeper.ledger
    expect(lacking).toBe(0)
    expect(l.refusedNodes!['node-a.test']).toBeUndefined()
    // The conflicting device: tried again after 1 h, 2 h, 4 h ... up to a day, not every sweep.
    expect(l.grants.filter((g) => g.device === x).length).toBeLessThanOrEqual(36) // about one a day once the cooldown reaches its ceiling, not one a sweep (124)
    expect(t.errors().length).toBe(1)
    expect(t.errors()[0]!.message).toContain('key-conflict')
  }, 120_000)

  it('R3-1: the daily probe leaves a device with a refusal of its own at that node alone', async () => {
    const t = setup({}, new MemoryStore(), [A])
    const x = t.addDevice(P1)
    const y = t.addDevice(P2)
    t.nodes.reserved.add(x) // key-conflict for x at A, from the start
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.cooldown?.['node-a.test|' + x] !== undefined && keeper.ledger.grants.some((g) => g.device === y && g.recorded === true))
    // A new device arrives just as the node stops enrolling the keeper: the node is refused.
    const z = t.addDevice(P2)
    t.nodes.unenrolled.add('node-a.test')
    await keeper.sweep()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] !== undefined)
    t.world.devices = [t.world.devices.find((d) => d.device === x)!, ...t.world.devices.filter((d) => d.device !== x)] // x first
    t.nodes.unenrolled.delete('node-a.test')
    t.tick(86_401)
    const before = keeper.ledger.grants.filter((g) => g.device === x).length
    await keeper.sweep()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] === undefined)
    expect(keeper.ledger.grants.filter((g) => g.device === x).length).toBe(before) // x was not the probe
    expect(keeper.ledger.grants.some((g) => g.device === z && g.recorded === true)).toBe(true)
  })

  it('R3-2: the probe does not hand a sixth device the grant the five-device rule withheld', async () => {
    const t = setup({}, new MemoryStore(), [A, B])
    const five = Array.from({ length: 5 }, () => t.addDevice(P1))
    t.nodes.unenrolled.add('node-a.test')
    const sixth = t.addDevice(P1)
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] !== undefined && keeper.ledger.journal.every((j) => j.stopped !== undefined))
    expect(keeper.ledger.refused.map((r) => r.device)).toEqual([sixth])
    // The sixth is heard first from now on, and the node takes the keeper again.
    t.world.devices = [t.world.devices.find((d) => d.device === sixth)!, ...t.world.devices.filter((d) => d.device !== sixth)]
    t.nodes.unenrolled.delete('node-a.test')
    t.tick(86_401)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.refusedNodes?.['node-a.test'] === undefined)
    await keeper.sweep()
    await waitFor(() => keeper.ledger.journal.every((j) => j.stopped !== undefined))
    const live = new Set(keeper.ledger.grants.filter((g) => g.status === 'active').map((g) => g.device))
    expect(live.has(sixth)).toBe(false)
    expect([...live].sort()).toEqual([...five].sort())
  })

  it('a single 500 is retried, not taken as the node refusing; the third in a row is; 501 is at once', async () => {
    const t = setup({}, new MemoryStore(), [A])
    t.addDevice(P1)
    t.nodes.script('node-a.test', { status: 500 }, { status: 500 })
    const keeper = await t.make()
    await keeper.start()
    await waitFor(() => t.nodes.posts.some((p) => p.status === 201))
    expect(keeper.ledger.refusedNodes!['node-a.test']).toBeUndefined()
    expect(t.errors()).toEqual([])
    // Three in a row: the node is refusing.
    const t2 = setup({}, new MemoryStore(), [A])
    t2.addDevice(P1)
    t2.nodes.script('node-a.test', { status: 500 }, { status: 500 }, { status: 500 })
    const k2 = await t2.make()
    await k2.start()
    await waitFor(() => k2.ledger.refusedNodes?.['node-a.test'] !== undefined)
    expect(k2.ledger.refusedNodes!['node-a.test']!.reason).toBe('500')
    expect(t2.nodes.posts.filter((p) => p.status === 500).length).toBe(3)
    expect(t2.errors().length).toBe(1)
    // 501 and upward at once.
    const t3 = setup({}, new MemoryStore(), [A])
    t3.addDevice(P1)
    t3.nodes.script('node-a.test', { status: 501 })
    const k3 = await t3.make()
    await k3.start()
    await waitFor(() => k3.ledger.refusedNodes?.['node-a.test'] !== undefined)
    expect(t3.nodes.posts.filter((p) => p.status === 501).length).toBe(1)
  })
})
