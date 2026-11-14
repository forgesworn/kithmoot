import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { buildGrant } from '../../group-grants.js'
import { NodeLedger } from './ledger.js'
import { NodeSupervisor } from './supervisor.js'
import { SpryBackend, type CallBackend, type CallRefusals, type RelayBackend } from './backends.js'
import { LIMITS, nodeHttp, preparePairing } from './http.js'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const run of cleanups.splice(0).reverse()) await run() })

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
const metrics = (over: Record<string, unknown> = {}) => ({ v: 1, epoch: 'run-1', elapsedMillis: 1000, ageMillis: 40, udpAllocations: 6, streamAllocations: 2,
  streamConnections: 2, udpForwardedBytes: 0, streamForwardedBytes: 0, forwardedPackets: 0, droppedPackets: 0, streamErrors: 0, refusedStreams: 0,
  allocationQuotaRefusals: 0, userQuotaRefusals: 0, relayBindFailures: 0, ...over })

describe('Spry call capacity client', () => {
  const key = generateSecretKey(), turnSecret = '11'.repeat(32)
  it('reads the free allocation gauge and adds the configured capacity', async () => {
    const requests: string[] = []
    const fetcher = (async (url: string, init?: RequestInit) => { requests.push(`${init?.method} ${url}`); return json({ v: 1, ready: true, leaseActive: true, allocations: 8, forwardedBytes: 9 }) }) as typeof fetch
    const spry = new SpryBackend({ local: 'http://127.0.0.1:9', origin: 'https://node.example', key, turnSecret, fetch: fetcher, capacity: 8 })
    expect(await spry.status()).toEqual({ ready: true, leaseActive: true, allocations: 8, capacity: 8 })
    expect(requests).toEqual(['GET http://127.0.0.1:9/v1/status'])
  })
  it('stays compatible with a Spry that reports no gauge, and with no configured capacity', async () => {
    const old = new SpryBackend({ local: 'http://127.0.0.1:9', origin: 'https://node.example', key, turnSecret, capacity: 32,
      fetch: (async () => json({ ready: true, leaseActive: false })) as unknown as typeof fetch })
    expect(await old.status()).toEqual({ ready: true, leaseActive: false })
    const unset = new SpryBackend({ local: 'http://127.0.0.1:9', origin: 'https://node.example', key, turnSecret,
      fetch: (async () => json({ ready: true, leaseActive: true, allocations: 3 })) as unknown as typeof fetch })
    expect(await unset.status()).toEqual({ ready: true, leaseActive: true })
    expect(() => new SpryBackend({ local: 'http://127.0.0.1:9', origin: 'https://node.example', key, turnSecret, capacity: 0 })).toThrow()
  })
  it('signs the private status request and counts server-limit and port refusals, not per-user ones', async () => {
    let seen: { body: string; event: Event } | undefined
    let answer: unknown = { v: 1, ready: true, leaseActive: true, allocations: 8, forwardedBytes: 0,
      metrics: metrics({ allocationQuotaRefusals: 22, relayBindFailures: 3, userQuotaRefusals: 50 }) }
    const fetcher = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:9/v1/node/status'); expect(init?.method).toBe('POST')
      const header = String((init?.headers as Record<string, string>).Authorization)
      seen = { body: String(init?.body), event: JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8')) }
      return json(answer)
    }) as typeof fetch
    const spry = new SpryBackend({ local: 'http://127.0.0.1:9', origin: 'https://node.example', key, turnSecret, fetch: fetcher, capacity: 8 })
    expect(await spry.refusals()).toEqual({ epoch: 'run-1', elapsedMillis: 1000, ageMillis: 40, refusals: 25 })
    const body = JSON.parse(seen!.body)
    expect(Object.keys(body).sort()).toEqual(['pairing', 'v']); expect(body.v).toBe(1)
    expect(verifyEvent(seen!.event)).toBe(true)
    expect(seen!.event.tags).toContainEqual(['u', 'https://node.example/v1/node/status'])
    expect(seen!.event.tags).toContainEqual(['payload', createHash('sha256').update(seen!.body).digest('hex')])
    answer = { v: 1, ready: true, leaseActive: true, metrics: null }
    expect(await spry.refusals()).toBeUndefined()
    answer = { v: 1, ready: true, leaseActive: true, metrics: metrics({ allocationQuotaRefusals: -1 }) }
    expect(await spry.refusals()).toBeUndefined()
  })
})

function node(options: { refusals?: boolean } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-capacity-')); cleanups.push(() => rmSync(path, { force: true, recursive: true }))
  let now = 1_900_000_000
  const nodeKey = generateSecretKey()
  const ledger = new NodeLedger(join(path, 'ledger.sqlite'), { host: 'node.example', salt: 'test-salt', serviceKey: getPublicKey(nodeKey), now: () => now })
  cleanups.push(() => ledger.close())
  const state = { allocations: 0 as number | undefined, capacity: 8, statusFails: false, reads: 0, readFails: false,
    reading: { epoch: 'run-1', elapsedMillis: 1000, ageMillis: 20, refusals: 0 } as CallRefusals | undefined }
  const calls: CallBackend = {
    status: async () => {
      if (state.statusFails) throw Error('unreachable')
      return { ready: true, leaseActive: true, ...(state.allocations === undefined ? {} : { allocations: state.allocations, capacity: state.capacity }) }
    },
    offer: async () => ({ v: 1, endpoint: 'https://node.example', token: 'A'.repeat(43), expiresAt: now + 86400 }),
    register: async () => {}, lease: async () => {}, remove: async () => {},
    ...(options.refusals === false ? {} : { refusals: async () => {
      state.reads++
      if (state.readFails) throw Error('spry-http-429')
      return state.reading && structuredClone(state.reading)
    } }),
  }
  const relay: RelayBackend = { sync: async () => {}, publish: async () => {}, purge: async () => 0, status: async () => ({ rooms: 0, devices: 0, usedBytes: 0, leaseActive: true }) }
  const supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', nodeKey, () => now)
  const step = async (seconds: number, change: (s: typeof state) => void = () => {}) => {
    now += seconds; change(state)
    if (state.reading) state.reading = { ...state.reading, elapsedMillis: state.reading.elapsedMillis + seconds * 1000 }
    await supervisor.tick().catch(() => {})
  }
  return { state, supervisor, ledger, nodeKey, step, get now() { return now } }
}

describe('node call capacity summary', () => {
  it('reports in use and capacity, and full once every allocation is taken', async () => {
    const f = node()
    await f.step(2, s => { s.allocations = 4 })
    expect(f.supervisor.callCapacity()).toEqual({ v: 1, allocations: 4, capacity: 8, full: false, refused: false })
    // Far from the limit: no signed status POST is spent.
    expect(f.state.reads).toBe(0)
    await f.step(2, s => { s.allocations = 8 })
    expect(f.supervisor.callCapacity()).toMatchObject({ allocations: 8, full: true })
    expect((await f.supervisor.ownerStatus()).callCapacity).toMatchObject({ allocations: 8, capacity: 8, full: true })
  })
  it('says full after a refusal while within one call of the limit, then clears', async () => {
    const f = node(), capacity = 32
    f.state.capacity = capacity
    await f.step(2, s => { s.allocations = 31 }) // baseline read: no refusal yet
    expect(f.state.reads).toBe(1)
    expect(f.supervisor.callCapacity()).toMatchObject({ full: false, refused: false })
    await f.step(2, s => { s.reading!.refusals = 22 })
    expect(f.state.reads).toBe(1) // throttled to one read per ten seconds
    await f.step(10)
    expect(f.state.reads).toBe(2)
    expect(f.supervisor.callCapacity()).toMatchObject({ allocations: 31, full: true, refused: true })
    // A call ends: room for another, so no longer full, though a refusal was recent.
    await f.step(2, s => { s.allocations = 24 })
    expect(f.supervisor.callCapacity()).toMatchObject({ full: false, refused: true })
    await f.step(2, s => { s.allocations = 31 })
    expect(f.supervisor.callCapacity()).toMatchObject({ full: true })
    // No new refusal for the window: not full while one call still fits.
    for (let i = 0; i < 31; i++) await f.step(2)
    expect(f.supervisor.callCapacity()).toMatchObject({ allocations: 31, full: false, refused: false })
  })
  it('never counts a Spry restart, a reset counter or an old baseline as a refusal', async () => {
    const f = node()
    await f.step(2, s => { s.allocations = 6 })
    await f.step(10, s => { s.reading = { epoch: 'run-2', elapsedMillis: 100, ageMillis: 10, refusals: 30 } })
    expect(f.supervisor.callCapacity()).toMatchObject({ refused: false })
    await f.step(10, s => { s.reading!.refusals = 5 })
    expect(f.supervisor.callCapacity()).toMatchObject({ refused: false })
    // Quiet for minutes: the next reading is only a fresh baseline.
    await f.step(2, s => { s.allocations = 1 })
    for (let i = 0; i < 40; i++) await f.step(2)
    await f.step(2, s => { s.allocations = 6; s.reading!.refusals = 40 })
    expect(f.supervisor.callCapacity()).toMatchObject({ refused: false })
    // A stale relay sample is ignored too.
    await f.step(10, s => { s.reading = { ...s.reading!, refusals: 41, ageMillis: 60_000 } })
    expect(f.supervisor.callCapacity()).toMatchObject({ refused: false })
  })
  it('keeps readiness when the reading fails, and omits the summary when unknown or stale', async () => {
    const f = node()
    f.state.allocations = undefined
    await f.step(2)
    expect(f.supervisor.callCapacity()).toBeUndefined()
    expect(await f.supervisor.ownerStatus()).not.toHaveProperty('callCapacity')
    await f.step(2, s => { s.allocations = 8; s.readFails = true })
    expect(f.supervisor.status().ready).toBe(true)
    expect(f.state.reads).toBe(1)
    expect(f.supervisor.callCapacity()).toMatchObject({ full: true, refused: false })
    await f.step(2, s => { s.statusFails = true })
    for (let i = 0; i < 16; i++) await f.step(2)
    expect(f.supervisor.callCapacity()).toBeUndefined()
  })
  it('works with a call backend that has no refusal metrics', async () => {
    const f = node({ refusals: false })
    await f.step(2, s => { s.allocations = 8 })
    expect(f.supervisor.callCapacity()).toEqual({ v: 1, allocations: 8, capacity: 8, full: true, refused: false })
  })
})

describe('who can read call capacity', () => {
  it('gives the owner the counts, a member only whether calls are full, and the public nothing', async () => {
    const path = mkdtempSync(join(tmpdir(), 'kithmoot-node-capacity-http-')); cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    const nodeKey = generateSecretKey(), serviceKey = getPublicKey(nodeKey), now = Math.floor(Date.now() / 1000)
    const ledger = new NodeLedger(join(path, 'ledger.sqlite'), { host: 'node.example', serviceKey, salt: 'fixture' }); cleanups.push(() => ledger.close())
    let allocations: number | undefined
    const calls: CallBackend = { status: async () => ({ ready: true, leaseActive: true, ...(allocations === undefined ? {} : { allocations, capacity: 8 }) }),
      offer: async () => ({ v: 1 as const, endpoint: 'https://node.example', token: 'A'.repeat(43), expiresAt: now + 3600 }),
      register: async () => {}, remove: async () => {}, lease: async () => {}, refusals: async () => undefined }
    const relay: RelayBackend = { sync: async () => {}, publish: async () => {}, purge: async () => 0, status: async () => ({ rooms: 0, devices: 0, usedBytes: 0, leaseActive: true }) }
    const supervisor = new NodeSupervisor(ledger, calls, relay, 'node.example', nodeKey)
    const server = nodeHttp(supervisor, { origin: 'https://node.example', origins: ['https://app.example'], serviceKey, limits: { ...LIMITS, strangers: 60, perAddress: 200 } })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>(r => server.close(() => r())))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('listener')
    const base = `http://127.0.0.1:${address.port}`
    const proof = (path: string, body: string, key: Uint8Array) => `Nostr ${Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now, content: '', tags: [
      ['u', 'https://node.example' + path], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', randomBytes(32).toString('base64url')]] }, key))).toString('base64')}`
    const post = (path: string, body: string, key: Uint8Array) => fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: proof(path, body, key) } })
    const owner = generateSecretKey(), authority = generateSecretKey(), device = generateSecretKey(), room = '03'.repeat(32)
    const claim = JSON.stringify({ code: preparePairing(supervisor).code })
    expect((await post('/node/v1/claim', claim, owner)).status).toBe(200)
    const enrol = JSON.stringify({ room, authority: getPublicKey(authority), inviter: getPublicKey(authority), ends: now + 3600 })
    expect((await post('/node/v1/enrol', enrol, owner)).status).toBe(200)
    const grant = JSON.stringify(buildGrant({ authoritySk: authority, roomId: room, device: getPublicKey(device), server: 'node.example',
      scopes: ['turn', 'relay-read', 'relay-write'], grantId: '03'.repeat(16), createdAt: now, expiration: now + 3600 }))
    expect((await post('/groups/v1/events', grant, authority)).status).toBe(200)
    const access = JSON.stringify({ room, grant: '03'.repeat(16) })
    const read = async () => (await post('/node/v1/access', access, device)).json()
    // A Spry without the gauge: the field is absent, exactly as from an older node.
    expect(await read()).not.toHaveProperty('callCapacity')
    allocations = 2; await supervisor.tick()
    expect(await read()).toMatchObject({ state: 'active', callCapacity: { v: 1, full: false } })
    allocations = 8; await supervisor.tick()
    const member = await read()
    expect(member.callCapacity).toEqual({ v: 1, full: true })
    const ownerView = await (await post('/node/v1/status', '{}', owner)).json()
    expect(ownerView.callCapacity).toEqual({ v: 1, allocations: 8, capacity: 8, full: true, refused: false })
    for (const path of ['/node/v1/status', '/node/v1/info']) {
      const text = await (await fetch(base + path)).text()
      expect(text).not.toContain('callCapacity'); expect(text).not.toContain('allocations'); expect(text).not.toContain('full')
    }
    expect((await post('/node/v1/status', '{}', device)).status).toBe(403)
  })
})
