import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildGrant, buildReset, buildRevocation, parseGroupEvent } from '../../group-grants.js'
import { NodeLedger, NodeRefusal } from './ledger.js'
import { NodeSupervisor, type CloseRequest } from './supervisor.js'
import { type CallBackend, type RelayBackend } from './backends.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture(empty = false) {
  const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-supervisor-')); cleanups.push(() => rmSync(path, { force: true, recursive: true }))
  let now = 1_900_000_000
  const authority = generateSecretKey(), device = getPublicKey(generateSecretKey()), room = '01'.repeat(32)
  const nodeKey = generateSecretKey()
  const options = { host: 'node.example', salt: 'test-salt', serviceKey: getPublicKey(nodeKey), now: () => now }
  let ledger = new NodeLedger(join(path, 'ledger.sqlite'), options)
  cleanups.push(() => ledger.close())
  ledger.claimOwner(getPublicKey(generateSecretKey()))
  if (!empty) ledger.enrol({ room, authority: getPublicKey(authority), inviter: getPublicKey(authority) })
  const state = { callReady: true, lease: false, relayFail: false, removeFail: false, purgeFail: false, addLostAck: false,
    revisions: [] as number[], members: new Set<string>(), purges: 0, publishes: 0, relayDevices: [] as string[], leases: 0 }
  const calls: CallBackend = {
    status: async () => ({ ready: state.callReady, leaseActive: state.lease }),
    offer: async () => ({ v: 1, endpoint: 'https://node.example', token: 'A'.repeat(43), expiresAt: now + 86400 }),
    register: async (_token, revision, add, remove) => {
      expect(revision).toBeGreaterThan(state.revisions.at(-1) ?? 0); state.revisions.push(revision)
      for (const key of add) state.members.add(key)
      for (const key of remove) state.members.delete(key)
      if (state.addLostAck && add.length) { state.addLostAck = false; throw Error('lost acknowledgement') }
    },
    lease: async () => { state.lease = true; state.leases++ },
    remove: async () => { if (state.removeFail) throw Error('unreachable'); state.members.clear() },
  }
  const relay: RelayBackend = {
    sync: async (_rooms, devices) => { if (state.relayFail) throw Error('unreachable'); state.relayDevices = devices.map(d => d.device) },
    publish: async () => { state.publishes++ },
    purge: async () => { if (state.purgeFail) throw Error('unreachable'); state.purges++; state.relayDevices = []; return 3 },
    status: async () => ({ rooms: 1, devices: state.relayDevices.length, usedBytes: 0, leaseActive: true }),
  }
  let supervisor = new NodeSupervisor(ledger, calls, relay, options.host, nodeKey, options.now)
  const grant = buildGrant({ authoritySk: authority, roomId: room, device, server: options.host, scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: now, expiration: now + 3600 })
  return { path, state, calls, relay, grant, room, device, authority, get ledger() { return ledger }, get supervisor() { return supervisor },
    advance: (seconds: number) => { now += seconds },
    restart: () => { ledger.close(); ledger = new NodeLedger(join(path, 'ledger.sqlite'), options); supervisor = new NodeSupervisor(ledger, calls, relay, options.host, nodeKey, options.now) },
    close: (): CloseRequest => ({ operation: '01'.repeat(16), room, deadline: now + 5,
      reset: buildReset({ authoritySk: authority, roomId: room, server: options.host, createdAt: now + 1 }),
      closure: finalizeEvent({ kind: 27543, created_at: now, content: '', tags: [['t', 'closed'], ['d', room], ['server', options.host],
        ['operation', '01'.repeat(16)], ['expiration', String(now + 30 * 86400)]] }, authority),
      events: [1461, 1462].map(kind => finalizeEvent({ kind, created_at: now, content: 'sealed fixture', tags: [['expiration', String(now + 3600)]] }, authority)) }),
  }
}
describe('node supervisor recovery', () => {
  it('keeps seven rooms usable within the child write budget while four clients poll access', async () => {
    const f = fixture(true), now = f.grant.created_at
    let writes = 0
    const write = () => { if (++writes > 60) throw Error('child write rate limit') }
    const revisions = new Map<string, number>()
    f.calls.offer = async room => ({ v: 1, endpoint: 'https://node.example', token: Buffer.from(room, 'hex').toString('base64url'), expiresAt: now + 86400 })
    f.calls.register = async (token, revision, add, remove) => {
      write(); expect(revision).toBeGreaterThan(revisions.get(token) ?? 0); revisions.set(token, revision)
      for (const key of add) f.state.members.add(key)
      for (const key of remove) f.state.members.delete(key)
    }
    f.calls.lease = async () => { write(); f.state.lease = true; f.state.leases++ }
    for (let i = 1; i <= 7; i++) {
      const room = i.toString(16).padStart(64, '0'), device = i === 1 ? f.device : getPublicKey(generateSecretKey())
      f.ledger.enrol({ room, authority: getPublicKey(f.authority), inviter: getPublicKey(f.authority) })
      await f.supervisor.apply(buildGrant({ authoritySk: f.authority, roomId: room, device, server: 'node.example',
        scopes: ['turn', 'relay-read', 'relay-write'], grantId: i.toString(16).padStart(32, '0'), createdAt: now, expiration: now + 3600 }))
    }
    const firstRoom = '1'.padStart(64, '0')
    for (let second = 0; second < 60; second++) {
      f.advance(1)
      if (second % 2 === 0) await f.supervisor.tick()
      if (second % 5 === 0) for (let client = 0; client < 4; client++) {
        await expect(f.supervisor.offer(firstRoom, f.device)).resolves.toMatchObject({ endpoint: 'https://node.example' })
      }
    }
    expect(f.supervisor.status()).toMatchObject({ ready: true, rooms: 7, devices: 7 })
    expect(writes).toBeLessThanOrEqual(60)
  })
  it('withholds cached offers after restart or failed reconciliation until both children recover', async () => {
    const f = fixture(); await f.supervisor.apply(f.grant)
    f.restart()
    await expect(f.supervisor.offer(f.room, f.device)).rejects.toThrow('node-reconciling')
    await f.supervisor.tick()
    await expect(f.supervisor.offer(f.room, f.device)).resolves.toMatchObject({ endpoint: 'https://node.example' })
    f.state.relayFail = true
    await expect(f.supervisor.tick()).rejects.toThrow('node-reconciling')
    await expect(f.supervisor.offer(f.room, f.device)).rejects.toThrow('node-reconciling')
    f.state.relayFail = false; await f.supervisor.tick()
    await expect(f.supervisor.offer(f.room, f.device)).resolves.toMatchObject({ endpoint: 'https://node.example' })
    await expect(f.supervisor.offer(f.room, getPublicKey(generateSecretKey()))).rejects.toThrow('access-required')
    const parsed = parseGroupEvent(f.grant); if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture')
    await f.supervisor.apply(buildRevocation(parsed.parsed, f.authority, f.grant.created_at + 1))
    await expect(f.supervisor.offer(f.room, f.device)).rejects.toThrow('access-required')
  })
  it('does not return an expired cached offer while a longer device grant remains active', async () => {
    const f = fixture()
    await f.supervisor.apply(buildGrant({ authoritySk: f.authority, roomId: f.room, device: f.device, server: 'node.example',
      scopes: ['turn', 'relay-read', 'relay-write'], grantId: '01'.repeat(16), createdAt: f.grant.created_at, expiration: f.grant.created_at + 28 * 86400 }))
    f.advance(86401)
    await expect(f.supervisor.offer(f.room, f.device)).rejects.toThrow('node-reconciling')
    await f.supervisor.tick()
    await expect(f.supervisor.offer(f.room, f.device)).resolves.toMatchObject({ endpoint: 'https://node.example' })
  })
  it('refuses deletion while a room exists and leaves admission usable', async () => {
    const f = fixture(); await f.supervisor.tick()
    await expect(f.supervisor.prepareDeletion()).rejects.toThrow('close-rooms-before-delete')
    expect(f.ledger.meta('deleting')).toBeUndefined()
    await expect(f.supervisor.apply(f.grant)).resolves.toEqual({ accepted: true })
  })
  it('serialises durable deletion intent against enrolment and requires local cancellation after restart', async () => {
    const f = fixture(true); await f.supervisor.tick()
    const room = { room: f.room, authority: getPublicKey(f.authority), inviter: getPublicKey(f.authority) }
    const prepared = f.supervisor.prepareDeletion(), raced = f.supervisor.enrol(room)
    await expect(prepared).resolves.toEqual({ deleteReady: true })
    await expect(raced).rejects.toThrow('node-deleting')
    expect(f.supervisor.status()).toMatchObject({ ready: false, deleting: true, rooms: 0 })
    f.restart(); await f.supervisor.tick()
    expect(() => f.ledger.enrol(room)).toThrow('node-deleting')
    expect(() => f.ledger.claimOwner(getPublicKey(f.authority))).toThrow('node-deleting')
    await expect(f.supervisor.apply(f.grant)).rejects.toThrow('node-deleting')
    await expect(f.supervisor.prepareDeletion()).resolves.toEqual({ deleteReady: true })
    await expect(f.supervisor.cancelDeletion()).resolves.toEqual({ deleteReady: false })
    await f.supervisor.tick()
    await expect(f.supervisor.enrol(room)).resolves.toBeUndefined()
    await expect(f.supervisor.prepareDeletion()).rejects.toThrow('close-rooms-before-delete')
  })
  it('acknowledges only both child projections and retries the same committed grant', async () => {
    const f = fixture(); f.state.relayFail = true
    await expect(f.supervisor.apply(f.grant)).rejects.toThrow('children-pending')
    expect(f.ledger.devices()).toHaveLength(1); expect(f.state.members.has(f.device)).toBe(true)
    f.state.relayFail = false
    await expect(f.supervisor.apply(f.grant)).resolves.toEqual({ accepted: true })
    expect(f.state.relayDevices).toEqual([f.device]); expect(f.state.revisions).toHaveLength(2)
  })
  it('removes a registration whose successful add acknowledgement was lost', async () => {
    const f = fixture(); f.state.addLostAck = true
    await expect(f.supervisor.apply(f.grant)).rejects.toThrow('children-pending')
    const parsed = parseGroupEvent(f.grant); if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture')
    f.restart()
    await f.supervisor.apply(buildRevocation(parsed.parsed, f.authority, f.grant.created_at + 1))
    expect(f.state.members.size).toBe(0); expect(f.state.relayDevices).toEqual([])
  })
  it('fully reconciles after the child lease is lost', async () => {
    const f = fixture(); await f.supervisor.apply(f.grant)
    f.state.members.clear(); f.state.lease = false; f.restart()
    await f.supervisor.tick()
    expect(f.state.members.has(f.device)).toBe(true)
  })
  it('does not report closed until both teardown acknowledgements and erasure survive restart', async () => {
    const f = fixture(); await f.supervisor.apply(f.grant)
    const request = f.close()
    expect((await f.supervisor.close(getPublicKey(f.authority), request)).phase).toBe('draining')
    expect(f.state.members.size).toBe(1)
    f.advance(6); f.state.purgeFail = true; f.restart()
    await expect(f.supervisor.tick()).rejects.toThrow('node-reconciling')
    expect(f.supervisor.operation(request.operation).phase).toBe('teardown')
    expect(f.ledger.room(f.room)).toBeDefined(); expect(f.state.members.size).toBe(0)
    f.state.purgeFail = false; f.restart(); await f.supervisor.tick()
    expect(f.supervisor.operation(request.operation)).toMatchObject({ phase: 'done', result: { callsRevoked: true, relayPurged: true, eventsDeleted: 3 } })
    expect(f.ledger.rooms()).toEqual([]); expect(f.ledger.devices()).toEqual([])
    expect(f.ledger.operation(request.operation)?.payload).toEqual({})
    expect(f.ledger.closedProof(f.room)?.proof).not.toHaveProperty('pubkey')
    expect((await f.supervisor.close(getPublicKey(f.authority), request)).phase).toBe('done')
    await expect(f.supervisor.close(getPublicKey(f.authority), { ...request, room: '02'.repeat(32) })).rejects.toThrow('operation-rebound')
  })
  it('withholds lease renewal when a closing room cannot revoke calls', async () => {
    const f = fixture(); await f.supervisor.apply(f.grant); const request = f.close()
    await f.supervisor.close(getPublicKey(f.authority), request); f.advance(6); f.state.removeFail = true
    const leases = f.state.leases
    await expect(f.supervisor.tick()).rejects.toThrow('node-reconciling')
    expect(f.state.leases).toBe(leases); expect(f.state.purges).toBe(1)
    f.state.removeFail = false; await f.supervisor.tick()
    expect(f.supervisor.operation(request.operation).phase).toBe('done')
  })
  it('rejects a foreign close and does not persist it', async () => {
    const f = fixture(), request = f.close()
    await expect(f.supervisor.close(getPublicKey(generateSecretKey()), request)).rejects.toThrow('room-authority-required')
    await expect(f.supervisor.close(getPublicKey(f.authority), { ...request, events: request.events.map(e => ({ ...e, content: 'tampered' })) })).rejects.toThrow('invalid-closing-events')
    await expect(f.supervisor.close(getPublicKey(f.authority), { ...request, closure: request.reset })).rejects.toThrow('invalid-close-statement')
    expect(f.ledger.operations()).toEqual([])
  })
})

/** A calls backend that enforces Spry's `count`: a fixed 60 s window opened by
 * the first POST, 120 POSTs per window, refused POSTs still counted, GET status
 * free. The child lease lasts 15 s; `members` stands for Spry's registrations,
 * which a test clears to simulate a Spry restart. */
function sprySimulation(rooms: number, options: { start?: number } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-burst-')); cleanups.push(() => rmSync(path, { force: true, recursive: true }))
  let ms = options.start ?? 1_900_000_000_000
  const now = () => Math.floor(ms / 1000)
  const authority = generateSecretKey(), nodeKey = generateSecretKey()
  const ledger = new NodeLedger(join(path, 'ledger.sqlite'), { host: 'node.example', salt: 'test-salt', serviceKey: getPublicKey(nodeKey), maxRooms: 64, now })
  cleanups.push(() => ledger.close())
  ledger.claimOwner(getPublicKey(generateSecretKey()))
  const spry = { posts: 0, refusals: 0, registers: 0, offers: 0, leases: 0, statuses: 0, window: undefined as { end: number; count: number } | undefined,
    leaseUntil: 0, lastLease: undefined as number | undefined, maxLeaseGap: 0, lapses: 0, fail: 0, failRemove: false, maxWindow: 0,
    members: new Map<string, Set<string>>(), revisions: new Map<string, number>() }
  const post = () => {
    if (!spry.window || spry.window.end <= ms) spry.window = { end: ms + 60_000, count: 0 }
    spry.window.count++; spry.posts++; spry.maxWindow = Math.max(spry.maxWindow, spry.window.count)
    if (spry.window.count > 120) { spry.refusals++; throw new NodeRefusal(503, 'spry-http-429') }
    if (spry.fail > 0) { spry.fail--; throw new NodeRefusal(503, 'spry-unavailable') }
  }
  const calls: CallBackend = {
    status: async () => { spry.statuses++; return { ready: true, leaseActive: ms < spry.leaseUntil } },
    offer: async room => { post(); spry.offers++; return { v: 1, endpoint: 'https://node.example', token: Buffer.from(room, 'hex').toString('base64url'), expiresAt: now() + 86400 } },
    register: async (token, revision, add, remove) => {
      post()
      if (spry.failRemove && remove.length) throw new NodeRefusal(503, 'spry-unavailable')
      spry.registers++
      expect(revision).toBeGreaterThan(spry.revisions.get(token) ?? 0); spry.revisions.set(token, revision)
      const members = spry.members.get(token) ?? new Set<string>(); spry.members.set(token, members)
      for (const key of add) members.add(key)
      for (const key of remove) members.delete(key)
    },
    lease: async () => {
      post(); spry.leases++
      if (spry.leaseUntil <= ms && spry.lastLease !== undefined) spry.lapses++
      if (spry.lastLease !== undefined) spry.maxLeaseGap = Math.max(spry.maxLeaseGap, ms - spry.lastLease)
      spry.lastLease = ms; spry.leaseUntil = ms + 15_000
    },
    remove: async token => { post(); spry.members.delete(token) },
  }
  const relay: RelayBackend = { sync: async () => {}, publish: async () => {}, purge: async () => 0,
    status: async () => ({ rooms: 0, devices: 0, usedBytes: 0, leaseActive: true }) }
  const start = () => new NodeSupervisor(ledger, calls, relay, 'node.example', nodeKey, now, { clock: () => ms, sleep: async (wait: number) => { ms += wait } })
  let supervisor = start()
  const base = now()
  const roomIds = Array.from({ length: rooms }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  const room = (id: string) => ({ room: id, authority: getPublicKey(authority), inviter: getPublicKey(authority) })
  const grant = (id: string, slot: number, expiration = base + 7200, device = getPublicKey(generateSecretKey())) => buildGrant({ authoritySk: authority, roomId: id, device, server: 'node.example',
    scopes: ['turn', 'relay-read', 'relay-write'], grantId: (roomIds.indexOf(id) * 8 + slot + 1).toString(16).padStart(32, '0'), createdAt: now(), expiration })
  let lastTick = ms
  return { spry, get supervisor() { return supervisor }, ledger, roomIds, room, grant, authority, restart: () => { supervisor = start() },
    get ms() { return ms }, advance: (wait: number) => { ms += wait },
    /** The production timer ticks every 2 s; drive it from virtual time. */
    tickIfDue: async () => { if (ms - lastTick >= 2000) { lastTick = ms; await supervisor.tick().catch(() => {}) } },
    token: (id: string) => Buffer.from(id, 'hex').toString('base64url') }
}
describe('node supervisor Spry request budget', { timeout: 60_000 }, () => {
  it('admits 64 rooms enrolled 20 ms apart with three devices each without a 503 or a Spry 429', async () => {
    const s = sprySimulation(64)
    const failures: unknown[] = [], latency: number[] = []
    const timed = async (work: () => Promise<unknown>) => {
      const began = s.ms
      try { await work() } catch (error) { failures.push((error as Error).message) }
      latency.push(s.ms - began)
    }
    for (const id of s.roomIds) {
      s.advance(20); await s.tickIfDue(); await timed(() => s.supervisor.enrol(s.room(id)))
      for (let slot = 0; slot < 3; slot++) { s.advance(20); await s.tickIfDue(); await timed(() => s.supervisor.apply(s.grant(id, slot))) }
    }
    for (let i = 0; i < 30; i++) { s.advance(2000); await s.tickIfDue() }
    expect(failures).toEqual([])
    expect(s.spry.refusals).toBe(0); expect(s.spry.maxWindow).toBeLessThanOrEqual(100)
    expect(s.spry.lapses).toBe(0); expect(s.spry.maxLeaseGap).toBeLessThan(15_000)
    expect(Math.max(...latency)).toBeLessThan(6000) // the client's own request timeout
    expect(s.spry.offers).toBe(64); expect(s.spry.registers).toBe(192)
    for (const id of s.roomIds) expect(s.spry.members.get(s.token(id))?.size).toBe(3)
    expect(s.supervisor.status()).toMatchObject({ ready: true, rooms: 64, devices: 192 })
  })
  it('shares one reconcile between concurrent mutations', async () => {
    const s = sprySimulation(8)
    await s.supervisor.tick()
    const statuses = s.spry.statuses
    await Promise.all(s.roomIds.map(id => s.supervisor.enrol(s.room(id))))
    await Promise.all(s.roomIds.flatMap(id => [0, 1, 2].map(slot => s.supervisor.apply(s.grant(id, slot)))))
    // One pass in flight and at most one follow-up for each burst.
    expect(s.spry.statuses - statuses).toBeLessThanOrEqual(4)
    expect(s.spry.refusals).toBe(0); expect(s.spry.offers).toBe(8); expect(s.spry.registers).toBeLessThanOrEqual(16)
    for (const id of s.roomIds) expect(s.spry.members.get(s.token(id))?.size).toBe(3)
    expect(s.supervisor.status()).toMatchObject({ ready: true, rooms: 8, devices: 24 })
  })
  it('re-sends only the failed room after a refused registration', async () => {
    const s = sprySimulation(10)
    for (const id of s.roomIds) {
      await s.supervisor.enrol(s.room(id))
      for (let slot = 0; slot < 3; slot++) await s.supervisor.apply(s.grant(id, slot))
      s.advance(2000); await s.tickIfDue()
    }
    const last = s.roomIds.at(-1)!
    s.spry.fail = 1
    await expect(s.supervisor.apply(s.grant(last, 3))).rejects.toThrow('children-pending')
    const registers = s.spry.registers
    s.advance(2000); await s.supervisor.tick()
    // Before the fix every room was left shelter-pending and every device was re-registered.
    expect(s.spry.registers - registers).toBe(1)
    expect(s.spry.members.get(s.token(last))?.size).toBe(4)
    expect(s.supervisor.status()).toMatchObject({ ready: true })
  })
  it('stays under the window when the supervisor restarts inside one', async () => {
    const s = sprySimulation(64)
    for (const [index, id] of s.roomIds.entries()) {
      if (index === 20 || index === 40) s.restart()
      s.advance(20); await s.tickIfDue(); await s.supervisor.enrol(s.room(id))
      for (let slot = 0; slot < 3; slot++) { s.advance(20); await s.tickIfDue(); await s.supervisor.apply(s.grant(id, slot)) }
    }
    expect(s.spry.refusals).toBe(0); expect(s.spry.maxWindow).toBeLessThanOrEqual(115)
  })
  it('resumes a paced full re-registration after Spry loses its state', async () => {
    const s = sprySimulation(64)
    let distinct = 0
    for (const id of s.roomIds) {
      await s.supervisor.enrol(s.room(id))
      for (let slot = 0; slot < 3; slot++) await s.supervisor.apply(s.grant(id, slot, Math.floor(s.ms / 1000) + 7200 + ++distinct))
      s.advance(2000); await s.tickIfDue()
    }
    expect(s.supervisor.status()).toMatchObject({ ready: true, devices: 192 })
    const registers = s.spry.registers, refusals = s.spry.refusals
    s.spry.members.clear(); s.spry.leaseUntil = 0 // Spry restarted
    let waited = 0
    while (!(s.supervisor.status().ready && s.spry.leaseUntil > s.ms) && waited < 600_000) { s.advance(2000); waited += 2000; await s.tickIfDue() }
    expect(s.supervisor.status().ready).toBe(true)
    expect(s.spry.registers - registers).toBe(192) // each device once, distinct expiries
    expect(s.spry.refusals - refusals).toBe(0)
    for (const id of s.roomIds) expect(s.spry.members.get(s.token(id))?.size).toBe(3)
    expect(waited).toBeLessThan(240_000)
  })
  it('admits an unawaited 64-room burst through client retries without a Spry 429 or a lapse', async () => {
    const s = sprySimulation(64)
    await s.supervisor.tick()
    const outcomes = { refused: 0, rounds: 0, codes: new Set<string>() }
    const drive = async (work: (() => Promise<unknown>)[]) => {
      let left = work
      while (left.length && outcomes.rounds < 500) {
        outcomes.rounds++
        const results = await Promise.allSettled(left.map(run => run()))
        for (const r of results) if (r.status === 'rejected') { outcomes.refused++; outcomes.codes.add((r.reason as Error).message) }
        left = left.filter((_, i) => results[i]!.status === 'rejected')
        s.advance(2000); await s.tickIfDue()
      }
    }
    await drive(s.roomIds.map(id => () => s.supervisor.enrol(s.room(id))))
    const grants = s.roomIds.flatMap(id => [0, 1, 2].map(slot => s.grant(id, slot)))
    await drive(grants.map(grant => () => s.supervisor.apply(grant)))
    expect(s.spry.refusals).toBe(0); expect(s.spry.lapses).toBe(0); expect(s.spry.maxLeaseGap).toBeLessThan(15_000)
    // The node's own queue cap (429 node-busy) and paced passes (503) refuse
    // some of a truly concurrent burst; the clients' retries then succeed.
    for (const code of outcomes.codes) expect(['children-pending', 'node-busy']).toContain(code)
    for (const id of s.roomIds) expect(s.spry.members.get(s.token(id))?.size).toBe(3)
    expect(s.supervisor.status()).toMatchObject({ ready: true, rooms: 64, devices: 192 })
  })
  it('lets the lease lapse while a revocation cannot be delivered during a paced backlog', async () => {
    const s = sprySimulation(24)
    const kept = getPublicKey(generateSecretKey())
    const revoked = s.grant(s.roomIds[23]!, 0, undefined, kept)
    for (const id of s.roomIds) { await s.supervisor.enrol(s.room(id)); s.advance(2000); await s.tickIfDue() }
    await s.supervisor.apply(revoked)
    s.advance(6000); await s.tickIfDue()
    const parsed = parseGroupEvent(revoked); if (!parsed.ok || parsed.parsed.type !== 'grant') throw Error('fixture')
    const leases = s.spry.leases
    s.spry.failRemove = true
    const burst = await Promise.allSettled([
      ...s.roomIds.slice(0, 23).map(id => s.supervisor.apply(s.grant(id, 1))),
      s.supervisor.apply(buildRevocation(parsed.parsed, s.authority, s.ms / 1000 | 0)),
    ])
    expect(burst.some(r => r.status === 'rejected')).toBe(true)
    for (let i = 0; i < 10; i++) { s.advance(2000); await s.tickIfDue() }
    expect(s.spry.leases).toBe(leases) // never renewed while the revocation is owed
    expect(s.spry.leaseUntil).toBeLessThanOrEqual(s.ms)
    s.spry.failRemove = false
    for (let i = 0; i < 60 && !s.supervisor.status().ready; i++) { s.advance(2000); await s.tickIfDue() }
    expect(s.spry.members.get(s.token(s.roomIds[23]!))?.has(kept)).toBe(false)
    expect(s.supervisor.status()).toMatchObject({ ready: true })
    expect(s.spry.refusals).toBe(0)
  })
})
