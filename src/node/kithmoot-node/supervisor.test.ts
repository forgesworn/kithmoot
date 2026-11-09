import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildGrant, buildReset, buildRevocation, parseGroupEvent } from '../../group-grants.js'
import { NodeLedger } from './ledger.js'
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
