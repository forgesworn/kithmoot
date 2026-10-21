import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomAgent } from '../agent.js'
import type { KeeperState } from '../agent.js'
import { CONTROL_CHANNEL, decodeControl } from '../control.js'
import { GrantReceiver, parseGroupEvent, type GroupEvent, type ParsedGrant } from '../group-grants.js'
import type { GroupGrantsConfig } from '../group-grants-keeper.js'
import { createRoomInvitation, generateRoomSecret, deriveRoom } from '@forgesworn/fold-kit'
import { localIdentity } from '../identity.js'
import { SimRelay, SimTransport } from '../../test/sim-relay.js'
import { MemoryStore, oldEpochRosterEntry, waitFor } from '../../test/group-grants-fixtures.js'

/**
 * The keeper against a real `wildbloomd` in group mode. Skipped unless
 * WILDBLOOMD_BIN names the binary (CI has none). Run this file on its own:
 *   WILDBLOOMD_BIN=<path> npx vitest run src/node/group-grants.journey.test.ts
 * It starts one to three node processes at a time, on loopback, in fresh
 * temporary directories, and kills every one of them at the end.
 */
const BIN = process.env.WILDBLOOMD_BIN

const BASE = 'https://example.test/j/'
const DEVICE_BYTES = 1_000_000
const GROUP_CEILING = 10_000_000

const running = new Set<Daemon>()

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

/** One `wildbloomd --group-mode`, run from its own temporary directory. */
class Daemon {
  proc?: ChildProcess
  constructor(readonly dir: string, readonly port: number, readonly serverName: string, readonly authority: string) {}

  static async create(serverName: string, authority: string): Promise<Daemon> {
    const dir = await mkdtemp(join(tmpdir(), 'kithmoot-journey-'))
    const d = new Daemon(dir, await freePort(), serverName, authority)
    await d.start()
    return d
  }

  get url(): string { return `http://${this.serverName}:${this.port}` }

  async start(): Promise<void> {
    this.proc = spawn(BIN!, [
      '--no-tor', '--repair-interval', '0', '--bind', `127.0.0.1:${this.port}`,
      '--public-url', `http://${this.serverName}:${this.port}/`, '--server-name', this.serverName,
      '--group-mode', '--group-keeper', `${this.authority}:${GROUP_CEILING}`,
      '--allow-pubkey', getPublicKey(generateSecretKey()), '--max-blob-bytes', '1048576',
      '--data-dir', join(this.dir, 'data'),
    ], { cwd: this.dir, stdio: 'ignore', env: { ...process.env, RUST_LOG: 'error' } })
    running.add(this)
    const until = Date.now() + 20_000
    for (;;) {
      if (this.proc.exitCode !== null) throw new Error('the node exited')
      try { if ((await fetch(`http://127.0.0.1:${this.port}/healthz`)).status === 200) return } catch { /* not up yet */ }
      if (Date.now() > until) throw new Error('the node did not start')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else proc.once('exit', () => resolve()) })
    this.proc = undefined
  }
}

afterAll(async () => { for (const d of running) await d.stop() })

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A BUD-11 token (kind 24242) signed by a device key: verb, the blob, and the node it is for. */
function bud11(sk: Uint8Array, verb: 'get' | 'upload' | 'delete', hash: string, server: string): string {
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({
    kind: 24242, created_at: now - 1, content: 'group journey',
    tags: [['t', verb], ['x', hash], ['server', server], ['expiration', String(now + 60)]],
  }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}`
}

const get = (node: Daemon, sk: Uint8Array | undefined, hash: string) =>
  fetch(`${node.url}/${hash}`, { headers: sk ? { authorization: bud11(sk, 'get', hash, node.serverName) } : {} })

const upload = (node: Daemon, sk: Uint8Array, body: Uint8Array) => {
  const hash = sha(body)
  return fetch(`${node.url}/upload`, { method: 'PUT', body: body as unknown as BodyInit, headers: { 'x-sha-256': hash, authorization: bud11(sk, 'upload', hash, node.serverName) } })
}

const post = (node: Daemon, event: GroupEvent) =>
  fetch(`${node.url}/groups/v1/events`, { method: 'POST', body: JSON.stringify(event), headers: { 'content-type': 'application/json' } })

const status = async (r: Promise<Response>): Promise<number> => { const res = await r; await res.arrayBuffer().catch(() => {}); return res.status }

const transportFor = (relay: SimRelay) => () => new SimTransport(relay)

interface Member { agent: RoomAgent; deviceSk: Uint8Array; device: string }

async function makeRoom(nodes: Daemon[], state: KeeperState, over: Partial<GroupGrantsConfig> = {}) {
  const relay = new SimRelay({ replay: true })
  const keeper = await RoomAgent.create({
    base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0, state,
    groupGrants: {
      nodes: nodes.map((n) => n.url), bytes: DEVICE_BYTES, store: new MemoryStore(),
      backoff: { baseMs: 50, maxMs: 200 }, pushBudgetMs: 15_000, rosterDelayMs: 20, ...over,
    },
  })
  const join = async (name: string, deviceSk = generateSecretKey(), identity = localIdentity(generateSecretKey())): Promise<Member> => {
    const agent = await RoomAgent.join({
      link: keeper.url, name, identity, deviceSk, transport: transportFor(relay), announceJitterMs: 0, timing: { heartbeatIntervalMs: 40 },
    })
    return { agent, deviceSk, device: getPublicKey(deviceSk) }
  }
  return { relay, keeper, join }
}

function freshState(): { authority: string; state: KeeperState } {
  const host = createRoomInvitation(true)
  const state: KeeperState = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer, persistent: true }
  return { authority: getPublicKey(host.inviterSk), state }
}

const storageEvents = (agent: RoomAgent): GroupEvent[] =>
  agent.channel(CONTROL_CHANNEL).messages().flatMap((m) => {
    const c = decodeControl(m.text)
    return c?.op === 'storage-grant' ? [c.event] : []
  })

const grantsOf = (keeper: RoomAgent, device: string) => keeper.groupGrantLedger!.grants.filter((g) => g.device === device)
const parsedGrant = (e: GroupEvent): ParsedGrant => (parseGroupEvent(e) as { ok: true; parsed: ParsedGrant }).parsed

describe.skipIf(!BIN)('the keeper against a real wildbloomd in group mode', () => {
  it('admits, serves, removes, re-admits, survives a node that was down, and closes', async () => {
    const { authority, state } = freshState()
    const n1 = await Daemon.create('localhost', authority)
    const n2 = await Daemon.create('127.0.0.1', authority)
    const { relay, keeper, join } = await makeRoom([n1, n2], state)
    const delivered = () => keeper.groupGrantLedger!.journal.length === 0

    // Admit devices A and B: one grant per node each, pushed and accepted.
    const a = await join('Ada')
    const b = await join('Bob')
    await waitFor(() => keeper.groupGrantLedger!.grants.filter((g) => g.status === 'active').length === 4 && delivered(), 15_000)

    // A uploads; B reads it with a t=get token carrying x and server. Nobody reads without a token.
    const blob = new TextEncoder().encode(`A's file ${Date.now()}`)
    const hash = sha(blob)
    expect([200, 201]).toContain(await status(upload(n1, a.deviceSk, blob)))
    expect([200, 201]).toContain(await status(upload(n2, a.deviceSk, blob)))
    const read = await get(n1, b.deviceSk, hash)
    expect(read.status).toBe(200)
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(blob)
    expect(await status(get(n1, undefined, hash))).toBe(401)
    // A stranger's key is refused, whatever it asks for.
    expect(await status(get(n1, generateSecretKey(), hash))).toBe(403)

    // The epoch filter, against the real node: a fresh participant key posting in epoch 0 after the room has moved on.
    const oldGrantIdsOfA = grantsOf(keeper, a.device).map((g) => g.id)
    expect(oldGrantIdsOfA.length).toBe(2)

    // Remove A's participant: A is refused at both nodes, B still reads A's upload.
    await keeper.remove(a.agent.participant)
    await waitFor(delivered, 10_000)
    expect(await status(get(n1, a.deviceSk, hash))).toBe(403)
    expect(await status(get(n2, a.deviceSk, hash))).toBe(403)
    expect(await status(get(n1, b.deviceSk, hash))).toBe(200)
    expect(grantsOf(keeper, a.device).every((g) => g.status === 'revoked')).toBe(true)

    const eve = await oldEpochRosterEntry(keeper, Math.floor(Date.now() / 1000))
    relay.publish(eve.event)
    await new Promise((r) => setTimeout(r, 200))
    await keeper.sweepGroupGrants()
    expect(grantsOf(keeper, eve.device)).toEqual([])
    expect(await status(get(n1, eve.deviceSk, hash))).toBe(403)

    // Re-admit: the same device key under a new participant key, let in by the keeper's room, gets NEW grant ids.
    // (A device's newest credential is the one that expires, then was created, later: two credentials in one second tie, and the
    // older keeps the device. A real return is hours on; the test waits out a second.)
    await new Promise((r) => setTimeout(r, 1_100))
    const returning = localIdentity(generateSecretKey())
    keeper.session.letIn(returning.pubkey)
    const a2 = await join('Ada again', a.deviceSk, returning)
    await waitFor(() => grantsOf(keeper, a.device).filter((g) => g.status === 'active').length === 2 && delivered(), 15_000)
    const fresh = grantsOf(keeper, a.device).filter((g) => g.status === 'active')
    expect(fresh.every((g) => !oldGrantIdsOfA.includes(g.id))).toBe(true)
    expect(fresh.every((g) => g.participant === returning.pubkey)).toBe(true)
    expect(await status(get(n1, a.deviceSk, hash))).toBe(200) // the group still holds what it uploaded before
    const second = new TextEncoder().encode(`A's second file ${Date.now()}`)
    expect([200, 201]).toContain(await status(upload(n2, a.deviceSk, second)))

    // A node that is down at a removal: refused as soon as the keeper's journal reaches it.
    await n2.stop()
    const started = Date.now()
    await keeper.remove(b.agent.participant)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await status(get(n1, b.deviceSk, hash))).toBe(403)
    expect(keeper.groupGrantLedger!.journal.some((j) => j.kind === 'revoked' && j.server === '127.0.0.1')).toBe(true)
    await n2.start()
    await waitFor(delivered, 15_000)
    expect(await status(get(n2, b.deviceSk, sha(blob)))).toBe(403)
    expect(await status(get(n2, a.deviceSk, sha(second)))).toBe(200)

    // Close: a reset at every node. A device that held a grant is refused, and its old grant can never land again (floor).
    const lastGrant = grantsOf(keeper, a.device).find((g) => g.server === 'localhost' && g.status === 'active')!.event
    await keeper.closeRoom()
    expect(await status(get(n1, a.deviceSk, hash))).toBe(403)
    expect(await status(get(n2, a.deviceSk, sha(second)))).toBe(403)
    // Nothing is granted once the close has begun, however long the roster keeps talking.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(await status(get(n1, a.deviceSk, hash))).toBe(403)
    expect(await status(get(n2, a.deviceSk, sha(second)))).toBe(403)
    // And the keeper's own record agrees: nothing is active, and nothing was signed after the reset.
    const closed = keeper.groupGrantLedger!
    expect(closed.grants.filter((g) => g.status === 'active')).toEqual([])
    // (A revocation signed in the reset's own second may be a second later: it only ends what is already ended.)
    for (const g of closed.grants.filter((x) => x.status !== 'revoked')) expect(g.createdAt).toBeLessThanOrEqual(closed.floors[g.server]!)
    const repost = await post(n1, lastGrant)
    expect(repost.status).toBe(409)
    expect(repost.headers.get('x-reason')).toBe('floor')
    for (const m of [a2, b]) await m.agent.leave()
    await a.agent.leave()
  }, 120_000)

  it('a node that was offline at the removal refuses the device once a member posts the revocation, even if the device posts its old grant first', async () => {
    const { authority, state } = freshState()
    const n3 = await Daemon.create('localhost', authority)
    // The keeper's own retries cannot win the race: its backoff is an hour.
    const { keeper, join } = await makeRoom([n3], state, { backoff: { baseMs: 3_600_000, maxMs: 3_600_000 }, pushBudgetMs: 800 })
    const d = await join('Dee')
    await waitFor(() => grantsOf(keeper, d.device).filter((g) => g.status === 'active').length === 1 && keeper.groupGrantLedger!.journal.length === 0, 15_000)
    const blob = new TextEncoder().encode(`D's file ${Date.now()}`)
    const hash = sha(blob)
    expect([200, 201]).toContain(await status(upload(n3, d.deviceSk, blob)))

    // The node goes away; C and E are admitted and then removed while it is gone, so it never hears of their grants or revocations.
    await n3.stop()
    const c = await join('Cat')
    const e = await join('Eli')
    await waitFor(() => grantsOf(keeper, c.device).length === 1 && grantsOf(keeper, e.device).length === 1, 15_000)
    await waitFor(() => storageEvents(c.agent).some((ev) => parsedGrant(ev).device === c.device) && storageEvents(e.agent).some((ev) => parsedGrant(ev).device === e.device), 15_000)
    const catGrant = storageEvents(c.agent).map(parsedGrant).find((g) => g.device === c.device && g.status === 'active')!.event
    const eliGrant = storageEvents(e.agent).map(parsedGrant).find((g) => g.device === e.device && g.status === 'active')!.event
    await keeper.remove(c.agent.participant)
    await keeper.remove(e.agent.participant)
    expect(keeper.groupGrantLedger!.journal.filter((j) => j.kind === 'revoked').length).toBe(2)
    await n3.start()

    // C, who read its grant in the room, posts it first: the node has heard nothing, so it is honoured, as the contract says it is.
    expect(await status(post(n3, catGrant))).toBe(201)
    expect(await status(get(n3, c.deviceSk, hash))).toBe(200)

    // A member who read the revocations in the room (epoch 2, which C and E cannot open) carries them to the node.
    await waitFor(() => d.agent.session.epoch === 2, 10_000)
    await waitFor(() => storageEvents(d.agent).filter((ev) => ev.tags.some((t) => t[0] === 'status' && t[1] === 'revoked')).length === 2, 10_000)
    const view = new GrantReceiver({ authority, roomId: deriveRoom(state.secret).roomId, device: d.device })
    const now = Math.floor(Date.now() / 1000)
    for (const ev of storageEvents(d.agent)) view.offer(ev, now)
    // (The room's first reset, signed at start because the state came with no ledger, is carried too; it is not what is asked about.)
    const all = view.carry('localhost', now)
    expect(all.filter((p) => p.type === 'reset').length).toBe(1)
    const carried = all.filter((p) => p.type === 'grant')
    expect(carried.length).toBe(2)
    const byDevice = new Map(carried.map((p) => [p.type === 'grant' ? p.device : '', p.event]))
    // Cat's: grant first (above), then the revocation: refused from then on.
    expect(await status(post(n3, byDevice.get(c.device)!))).toBe(201)
    expect(await status(get(n3, c.deviceSk, hash))).toBe(403)
    // Eli's: the revocation arrives before the old grant, which then cannot land.
    expect(await status(post(n3, byDevice.get(e.device)!))).toBe(201)
    const late = await post(n3, eliGrant)
    expect(late.status).toBe(409)
    expect(late.headers.get('x-reason')).toBe('stale')
    expect(await status(get(n3, e.deviceSk, hash))).toBe(403)
    // D is untouched, and the keeper's own journal never reached the node.
    expect(await status(get(n3, d.deviceSk, hash))).toBe(200)
    expect(keeper.groupGrantLedger!.journal.filter((j) => j.kind === 'revoked').length).toBe(2)
    for (const m of [c, e, d]) await m.agent.leave()
    await keeper.leave()
  }, 120_000)
})
