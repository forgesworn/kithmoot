import { afterEach, describe, expect, it, vi } from 'vitest'
import { nip44 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { AssignmentLog, type AssignmentStorage } from './assignment-log.js'
import { assignmentId, ASSIGNMENT_KIND, signAssignment } from './assignments.js'
import { createJournalStorage, type JournalHead, type JournalSegment } from './journal-storage.js'
import type { RelayTransport } from './relay-pool.js'
import { deriveRoom } from './room.js'
import { deriveChannel, encodeChatEvent } from './chat.js'

interface TestStorage extends AssignmentStorage {
  readonly value?: string
  readonly values: Map<string, string>
  readonly root: string
  fail: boolean
  commits: number
  saves: number
  appends: number
  readonly cuts: Map<string, string>[]
  failNextRoot(phase: 'before' | 'after'): void
}
function storage(seed?: string | Map<string, string>, root = 'assignments'): TestStorage {
  const values = new Map(seed instanceof Map ? seed : undefined)
  if (typeof seed === 'string') values.set(root, seed)
  const result: TestStorage = {
    root, values, fail: false, commits: 0, saves: 0, appends: 0, cuts: [],
    get value() { return values.get(this.root) },
    async load() { return this.value },
    async save(value) {
      result.saves++; result.commits++
      if (result.fail) throw new Error('Disk full')
      values.set(result.root, value); result.cuts.push(new Map(values))
    },
    failNextRoot() { result.fail = true },
  }
  return result
}
function incrementalStorage(seed?: string | Map<string, string>, root = 'assignments'): TestStorage {
  const values = new Map(seed instanceof Map ? seed : undefined)
  if (typeof seed === 'string') values.set(root, seed)
  let fault: { phase: 'before' | 'after' } | undefined
  const engine = createJournalStorage(root, {
    get: async key => values.get(key),
    async set(key, value) {
      if (fault && key === root) {
        const phase = fault.phase; fault = undefined
        if (phase === 'before') throw new Error('Injected failure before head')
        values.set(key, value); throw new Error('Injected failure after head')
      }
      values.set(key, value)
    },
    remove: async key => { values.delete(key) },
  })
  const result: TestStorage = {
    root, values, fail: false, commits: 0, saves: 0, appends: 0, cuts: [],
    get value() { return values.get(root) },
    load: () => engine.load(),
    async save(value) {
      result.saves++; result.commits++
      if (result.fail) throw new Error('Disk full')
      await engine.save(value); result.cuts.push(new Map(values))
    },
    loadIncremental: () => engine.loadIncremental(),
    async appendIncremental(delta) {
      result.appends++; result.commits++
      if (result.fail) throw new Error('Disk full')
      await engine.appendIncremental(delta); result.cuts.push(new Map(values))
    },
    failNextRoot(phase) { fault = { phase } },
  }
  return result
}
const clients: RoomAgent[] = []
const readers: AssignmentLog[] = []
afterEach(() => { for (const r of readers.splice(0)) r.close(); for (const c of clients.splice(0)) c.leave() })

async function fixture(incremental = false) {
  const relay = new SimRelay({ replay: true })
  let loseAck = false
  const transport = () => {
    const t = new SimTransport(relay)
    const publish = t.publish.bind(t)
    t.publish = async event => { await publish(event); if (loseAck && event.kind === 1460) throw new Error('Acknowledgement lost') }
    return t
  }
  const identity = localIdentity(generateSecretKey()), creatorDevice = generateSecretKey(), workerDevice = generateSecretKey()
  const creator = await RoomAgent.create({ base: 'https://example.test/j/', name: 'Person', agent: false, identity, deviceSk: creatorDevice, transport, announceJitterMs: 0 })
  clients.push(creator)
  const worker = await RoomAgent.join({ link: creator.url, name: 'Worker', deviceSk: workerDevice, transport, announceJitterMs: 0 })
  clients.push(worker)
  const aStore = incremental ? incrementalStorage() : storage(); const bStore = incremental ? incrementalStorage() : storage()
  const a = await creator.session.assignments(aStore)
  const b = await worker.session.assignments(bStore)
  await vi.waitFor(() => expect(a.snapshot().ready && b.snapshot().ready).toBe(true))
  return { relay, creator, worker, a, b, aStore, bStore, transport, identity, creatorDevice, workerDevice, setLostAck: (v: boolean) => { loseAck = v } }
}

function directLog(f: Awaited<ReturnType<typeof fixture>>, store: TestStorage, transport: RelayTransport = f.transport()): AssignmentLog {
  const log = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), transport, deviceSk: f.creatorDevice,
    identity: f.identity, credential: () => f.creator.session.credential, storage: store })
  readers.push(log)
  return log
}

describe('durable encrypted assignment transport', () => {
  it('does not publish a board assignment when its source changes during signing', async () => {
    const f = await fixture()
    let valid = true
    const sign = f.identity.signEvent.bind(f.identity)
    let release!: () => void, entered!: () => void
    const signing = new Promise<void>(resolve => {entered = resolve})
    const paused = new Promise<void>(resolve => {release = resolve})
    vi.spyOn(f.identity, 'signEvent').mockImplementation(async event => {entered(); await paused; return sign(event)})
    const sending = f.a.submit(undefined, {op: 'create', objective: 'Selected card', criteria: 'Return evidence', owner: f.worker.participant}, 'board_sign_guard', null, () => valid)
    await signing; valid = false; release()
    await expect(sending).rejects.toThrow('source changed')
    expect(f.a.snapshot().pendingSends).toBe(0)
    expect(f.b.snapshot().assignments).toHaveLength(0)
  })

  it.each([false, true])('retains an unpublished reviewed request after storage drift and requires fresh review to retry it (incremental %s)', async incremental => {
    const f = await fixture(incremental)
    let valid = true
    const save = f.aStore.save.bind(f.aStore)
    vi.spyOn(f.aStore, 'save').mockImplementation(async value => {await save(value); valid = false})
    const operation = {op: 'create' as const, objective: 'Selected card', criteria: 'Return evidence', owner: f.worker.participant}
    await expect(f.a.submit(undefined, operation, 'board_save_guard', null, () => valid)).rejects.toThrow('source changed')
    expect(f.a.snapshot().pendingSends).toBe(1)
    expect(f.b.snapshot().assignments).toHaveLength(0)
    await expect(f.a.retry()).rejects.toThrow('Review this saved assignment')
    vi.restoreAllMocks()
    const resumed = await f.a.submit(undefined, operation, 'board_save_guard', null, () => true)
    await vi.waitFor(() => expect(f.b.snapshot().assignments[0]?.id).toBe(resumed.id))
    expect(f.a.snapshot().pendingSends).toBe(0)
  })

  it.each([false, true])('delivers the complete create, claim, result and review journey through authenticated room envelopes (incremental %s)', async incremental => {
    const f = await fixture(incremental)
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Private release check', criteria: 'Report exact build', owner: f.worker.participant }, 'create_request_001')
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    await f.b.submit(created.id, { op: 'claim', executor: 'worker_installation_01', next: 'Read build manifest' }, 'claim_request_001')
    const result = await f.b.submit(created.id, { op: 'result', executor: 'worker_installation_01', summary: 'Build checked', evidence: 'Private artifact evidence' }, 'result_request_001')
    await vi.waitFor(() => expect(f.a.snapshot().assignments[0]?.status).toBe('review'))
    await f.a.submit(created.id, { op: 'accept', result: result.result!.id }, 'accept_request_001')
    await vi.waitFor(() => expect(f.b.snapshot().assignments[0]?.status).toBe('accepted'))
    expect(f.relay.published.some(e => e.kind === ASSIGNMENT_KIND)).toBe(false)
    for (const privateValue of [created.id, 'Private release check', 'Private artifact evidence', f.identity.pubkey]) {
      expect(JSON.stringify(f.relay.published)).not.toContain(privateValue)
      expect(JSON.stringify([...f.aStore.values.values()])).not.toContain(privateValue)
    }
  })

  it.each([false, true])('restarts with a lost acknowledgement and retries the identical signed operation (incremental %s)', async incremental => {
    const f = await fixture(incremental)
    const op = { op: 'create' as const, objective: 'Run once', criteria: 'No duplicates', owner: f.worker.participant }
    f.setLostAck(true)
    await expect(f.a.submit(undefined, op, 'retry_request_001')).rejects.toThrow('Acknowledgement lost')
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    expect(f.a.snapshot().pendingSends).toBe(1)
    f.creator.leave()
    f.setLostAck(false)
    const restarted = await RoomAgent.join({ link: f.creator.url, name: 'Person', agent: false, identity: f.identity, transport: f.transport, announceJitterMs: 0 })
    clients.push(restarted)
    const a = await restarted.session.assignments(f.aStore)
    await vi.waitFor(() => expect(a.snapshot().ready).toBe(true))
    await a.retry()
    expect(a.snapshot().pendingSends).toBe(0)
    expect(a.snapshot().assignments).toHaveLength(1)
    const again = await a.submit(undefined, op, 'retry_request_001')
    expect(again.history).toHaveLength(1)
    const { roomId, roomKey } = deriveRoom(f.creator.keeperState!.secret)
    const channel = deriveChannel(roomId, roomKey, 'assignments').id
    const messages = f.relay.published.filter(e => e.kind === 1460 && e.tags.some(t => t[0] === 'd' && t[1] === channel))
    expect(messages).toHaveLength(2)
    expect(messages[0]?.id).toBe(messages[1]?.id)
    await expect(a.submit(undefined, { ...op, objective: 'Different work' }, 'retry_request_001')).rejects.toThrow('different work')
  })

  it.each([false, true])('does not publish when durable storage fails (incremental %s)', async incremental => {
    const f = await fixture(incremental)
    const before = f.relay.published.length
    f.aStore.fail = true
    await expect(f.a.submit(undefined, { op: 'create', objective: 'Cannot save', criteria: 'No phantom work', owner: f.worker.participant }, 'failure_request_001')).rejects.toThrow('Disk full')
    expect(f.relay.published).toHaveLength(before)
    expect(f.a.snapshot().assignments).toEqual([])
    expect(f.a.snapshot().pendingSends).toBe(0)
  })

  it('checks an expected head after a queued incoming durable save', async () => {
    const f = await fixture()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Review current work', criteria: 'Use the approved version', owner: f.worker.participant }, 'version_create_001', null)
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    let saving = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const save = f.bStore.save.bind(f.bStore)
    f.bStore.save = async value => { saving = true; await gate; await save(value) }
    await f.a.submit(created.id, { op: 'stop', purpose: 'cancel', reason: 'Scope changed' }, 'version_stop_001', created.head)
    await vi.waitFor(() => expect(saving).toBe(true))
    expect(f.b.snapshot().assignments[0]?.head).toBe(created.head)
    const before = f.relay.published.length
    const claim = f.b.submit(created.id, { op: 'claim', executor: 'version_executor_001', next: 'Run the old plan' }, 'version_claim_001', created.head)
    const refused = expect(claim).rejects.toThrow('Assignment version changed')
    release()
    await refused
    expect(f.b.snapshot().pendingSends).toBe(0)
    expect(f.relay.published).toHaveLength(before)
  })

  it('refuses an update from a room member who does not own the assignment', async () => {
    const f = await fixture()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Owned task', criteria: 'Named worker only', owner: f.worker.participant }, 'owned_request_001')
    await expect(f.a.submit(created.id, { op: 'claim', executor: 'impostor_installation', next: 'Steal' }, 'steal_request_001')).rejects.toThrow('not permitted')
    expect(f.a.snapshot().assignments[0]?.status).toBe('offered')
  })
})

describe('incremental assignment journal', () => {
  it('requires both incremental methods on writable logs but not on readers', () => {
    const identity = localIdentity(generateSecretKey())
    const base = { roomId: '0'.repeat(64), roomKey: new Uint8Array(32), transport: new SimTransport(new SimRelay()), deviceSk: generateSecretKey(), identity, credential: () => undefined }
    const load = async () => undefined, save = async () => {}, loadIncremental = async () => ({ deltas: [] }), appendIncremental = async () => {}
    expect(() => new AssignmentLog({ ...base, storage: { load, save, loadIncremental } })).toThrow('requires both')
    expect(() => new AssignmentLog({ ...base, storage: { load, save, appendIncremental } })).toThrow('requires both')
    expect(() => new AssignmentLog({ ...base, readOnly: true, participant: identity.pubkey, storage: { load, loadIncremental } })).not.toThrow()
  })

  it('loads v2 through a reader with no legacy load or write methods', async () => {
    const f = await fixture(true)
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Read v2 without authority', criteria: 'No writes', owner: f.worker.participant }, 'v2_reader_request_001')
    const image = await f.aStore.loadIncremental!()
    expect(image.deltas.length).toBeGreaterThan(0)
    const load = vi.fn(async () => { throw new Error('Legacy load must not be used') })
    const loadIncremental = vi.fn(async () => image)
    const storage = { load, loadIncremental }
    const reader = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), readOnly: true, participant: f.identity.pubkey,
      transport: new SimTransport(new SimRelay({ replay: true })), storage })
    readers.push(reader)
    await reader.open()
    await vi.waitFor(() => expect(reader.snapshot().ready).toBe(true))
    expect(reader.snapshot().assignments[0]?.head).toBe(created.head)
    expect(reader.snapshot().pendingSends).toBe(0)
    expect(loadIncremental).toHaveBeenCalledOnce()
    expect(load).not.toHaveBeenCalled()
    expect('save' in storage).toBe(false)
    expect('appendIncremental' in storage).toBe(false)
  })

  it('refuses a corrupt later delta without exposing its valid base or prefix', async () => {
    const f = await fixture(true)
    await f.a.submit(undefined, { op: 'create', objective: 'Atomic v2 loading', criteria: 'No partial prefix', owner: f.worker.participant }, 'v2_corrupt_request_001')
    const damaged = incrementalStorage(new Map(f.aStore.values))
    const head = JSON.parse(damaged.values.get(damaged.root)!) as JournalHead
    const segment = JSON.parse(damaged.values.get(head.tip!.key)!) as JournalSegment
    const raw = JSON.stringify({ ...segment, body: JSON.stringify({ v: 2, add: ['invalid_ciphertext'] }) })
    const sha256Hex = bytesToHex(sha256(new TextEncoder().encode(raw))), key = `${damaged.root}.journal.v2.${sha256Hex}`
    damaged.values.set(key, raw)
    damaged.values.set(damaged.root, JSON.stringify({ ...head, tip: { key, sha256: sha256Hex } }))
    const transport = new SimTransport(new SimRelay({ replay: true })), subscribe = vi.spyOn(transport, 'subscribe')
    const reader = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), readOnly: true, participant: f.identity.pubkey, transport,
      storage: { load: async () => { throw new Error('Legacy load must not be used') }, loadIncremental: () => damaged.loadIncremental!() } })
    readers.push(reader)
    await expect(reader.open()).rejects.toThrow()
    expect(reader.snapshot().assignments).toEqual([])
    expect(reader.snapshot().pendingSends).toBe(0)
    expect(reader.snapshot().ready).toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('migrates exact v1 bytes and preserves review-required exact retry', async () => {
    const f = await fixture()
    const operation = { op: 'create' as const, objective: 'Migrate reviewed pending work', criteria: 'Same signed outer', owner: f.worker.participant }
    f.setLostAck(true)
    await expect(f.a.submit(undefined, operation, 'v1_migration_request_01', null, () => true)).rejects.toThrow('Acknowledgement lost')
    const raw = f.aStore.cuts[0]!.get(f.aStore.root)!
    const channel = deriveChannel(f.creator.roomId, deriveRoom(f.creator.keeperState!.secret).roomKey, 'assignments').id
    const original = f.relay.published.filter(event => event.kind === 1460 && event.tags.some(tag => tag[0] === 'd' && tag[1] === channel)).at(-1)!
    const migrated = incrementalStorage(raw), relay = new SimRelay({ replay: true }), transport = new SimTransport(relay)
    const log = directLog(f, migrated, transport)
    await log.open()
    await vi.waitFor(() => expect(log.snapshot().ready).toBe(true))
    expect(log.snapshot().pendingSends).toBe(1)
    expect(log.snapshot().assignments).toEqual([])
    await expect(log.retry()).rejects.toThrow('Review this saved assignment')
    expect(relay.published).toEqual([])
    const sign = vi.spyOn(f.identity, 'signEvent')
    await log.submit(undefined, operation, 'v1_migration_request_01', null, () => true)
    expect(sign).not.toHaveBeenCalled()
    expect(relay.published).toHaveLength(1)
    expect(relay.published[0]!.id).toBe(original.id)
    expect(log.snapshot().pendingSends).toBe(0)
    const head = JSON.parse(migrated.values.get(migrated.root)!) as JournalHead
    expect(migrated.values.get(head.base!.key)).toBe(raw)
    transport.close()
  })

  it('restarts pending, overlap and acknowledged v2 cuts without relay history', async () => {
    const f = await fixture(true)
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Recover every assignment cut', criteria: 'Exact retry', owner: f.worker.participant }, 'v2_cuts_request_001')
    expect(f.aStore.cuts).toHaveLength(3)
    const channel = deriveChannel(f.creator.roomId, deriveRoom(f.creator.keeperState!.secret).roomKey, 'assignments').id
    const original = f.relay.published.filter(event => event.kind === 1460 && event.tags.some(tag => tag[0] === 'd' && tag[1] === channel)).at(-1)!
    for (const [index, cut] of f.aStore.cuts.entries()) {
      const store = incrementalStorage(new Map(cut)), relay = new SimRelay({ replay: true }), transport = new SimTransport(relay)
      const log = directLog(f, store, transport)
      await log.open()
      await vi.waitFor(() => expect(log.snapshot().ready).toBe(true))
      expect(log.snapshot().pendingSends).toBe(index < 2 ? 1 : 0)
      expect(log.snapshot().assignments).toHaveLength(index === 0 ? 0 : 1)
      if (index > 0) expect(log.snapshot().assignments[0]?.id).toBe(created.id)
      await log.retry()
      expect(log.snapshot().pendingSends).toBe(0)
      expect(relay.published).toHaveLength(index < 2 ? 1 : 0)
      if (index < 2) expect(relay.published[0]!.id).toBe(original.id)
      else expect(store.commits).toBe(0)
      log.close(); transport.close()
    }
  })

  it('does not expose a live accepted event when its incremental save fails', async () => {
    const f = await fixture(true)
    f.bStore.fail = true
    await f.a.submit(undefined, { op: 'create', objective: 'Durable before live exposure', criteria: 'No in-memory-only event', owner: f.worker.participant }, 'live_save_failure_001')
    await vi.waitFor(() => expect(f.b.snapshot().error).toContain('Disk full'))
    expect(f.b.snapshot().assignments).toEqual([])
    expect(f.b.snapshot().ready).toBe(false)
  })

  it.each(['rekey', 'close'] as const)('prevents a queued replay commit after %s', async action => {
    const f = await fixture()
    await f.a.submit(undefined, { op: 'create', objective: 'Stale replay guard', criteria: 'No stale commit', owner: f.worker.participant }, 'stale_replay_guard_001')
    f.a.close(); f.b.close()
    const channel = deriveChannel(f.creator.roomId, deriveRoom(f.creator.keeperState!.secret).roomKey, 'assignments').id
    const outer = f.relay.published.filter(event => event.kind === 1460 && event.tags.some(tag => tag[0] === 'd' && tag[1] === channel)).at(-1)!
    let incoming!: Parameters<RelayTransport['subscribe']>[1]
    const transport: RelayTransport = { publish: async () => {}, close() {}, subscribe: (_filters, event) => { incoming = event; return () => {} } }
    const store = incrementalStorage(), log = directLog(f, store, transport)
    await log.open()
    incoming(outer)
    if (action === 'rekey') log.rekey({ id: f.creator.roomId, key: generateSecretKey() })
    else log.close()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.commits).toBe(0)
    expect(log.snapshot().assignments).toEqual([])
  })

  it.each(['before', 'after'] as const)('rolls back or recovers an outbox commit failing %s the head', async phase => {
    const f = await fixture(true)
    const operation = { op: 'create' as const, objective: 'Outbox commit fault', criteria: 'No ambiguous duplicate', owner: f.worker.participant }
    const sign = vi.spyOn(f.identity, 'signEvent'), before = f.relay.published.length
    f.aStore.failNextRoot(phase)
    await expect(f.a.submit(undefined, operation, 'outbox_fault_request_01')).rejects.toThrow('Injected failure')
    expect(f.relay.published).toHaveLength(before)
    expect(f.a.snapshot().assignments).toEqual([])
    expect(f.a.snapshot().pendingSends).toBe(phase === 'after' ? 1 : 0)
    if (phase === 'after') {
      await f.a.retry()
      expect(sign).toHaveBeenCalledTimes(1)
    } else {
      await f.a.submit(undefined, operation, 'outbox_fault_request_01')
      expect(sign).toHaveBeenCalledTimes(2)
    }
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    expect(f.a.snapshot().pendingSends).toBe(0)
  })

  it.each(['before', 'after'] as const)('keeps insertion and outbox removal atomic when the ack commit fails %s the head', async phase => {
    const f = await fixture(true)
    f.a.close(); f.b.close()
    const store = incrementalStorage(), transport = new SimTransport(f.relay), publish = transport.publish.bind(transport)
    let holding = true, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    transport.publish = async event => { await publish(event); if (holding) await gate }
    const log = directLog(f, store, transport)
    await log.open()
    await vi.waitFor(() => expect(log.snapshot().ready).toBe(true))
    const sign = vi.spyOn(f.identity, 'signEvent')
    const sending = log.submit(undefined, { op: 'create', objective: 'Ack commit fault', criteria: 'Atomic insertion and removal', owner: f.worker.participant }, 'ack_fault_request_001')
    await vi.waitFor(() => {
      expect(store.cuts).toHaveLength(2)
      expect(log.snapshot().assignments).toHaveLength(1)
      expect(log.snapshot().pendingSends).toBe(1)
    })
    const rejected = expect(sending).rejects.toThrow('Injected failure')
    store.failNextRoot(phase); holding = false; release()
    await rejected
    expect(log.snapshot().assignments).toHaveLength(1)
    expect(log.snapshot().pendingSends).toBe(phase === 'before' ? 1 : 0)
    const channel = deriveChannel(f.creator.roomId, deriveRoom(f.creator.keeperState!.secret).roomKey, 'assignments').id
    const original = f.relay.published.filter(event => event.kind === 1460 && event.tags.some(tag => tag[0] === 'd' && tag[1] === channel)).at(-1)!
    await log.retry()
    expect(log.snapshot().pendingSends).toBe(0)
    expect(sign).toHaveBeenCalledTimes(1)
    const messages = f.relay.published.filter(event => event.kind === 1460 && event.tags.some(tag => tag[0] === 'd' && tag[1] === channel))
    expect(messages).toHaveLength(phase === 'before' ? 2 : 1)
    for (const message of messages) expect(message.id).toBe(original.id)
    transport.close()
  })

  it.each([false, true])('batches replay, amortises compaction and never re-encrypts retained events (incremental %s)', { timeout: 30_000 }, async incremental => {
    const f = await fixture()
    f.a.close(); f.b.close()
    const room = deriveRoom(f.creator.keeperState!.secret), credential = f.creator.session.credential!, now = Math.floor(Date.now() / 1000)
    const outers = []
    for (let i = 0; i < 320; i++) {
      const request = `replay_request_${String(i).padStart(4, '0')}`
      const inner = await signAssignment(f.identity, room.roomId, { v: 1, assignment: assignmentId(f.identity.pubkey, request), request,
        previous: null, device: getPublicKey(f.creatorDevice), operation: { op: 'create', objective: `Replay ${i}`, criteria: 'Bounded durable batches', owner: f.worker.participant } }, now)
      const outer = encodeChatEvent({ id: bytesToHex(randomBytes(16)), participant: f.identity.pubkey, device: getPublicKey(f.creatorDevice), credential,
        text: 'Assignment create', sentAt: now, assignment: inner }, { ...room, deviceSk: f.creatorDevice, channel: 'assignments' })
      outers.push(outer); f.relay.publish(outer)
    }
    const store = incremental ? incrementalStorage() : storage(), encrypt = vi.spyOn(nip44.v2, 'encrypt')
    encrypt.mockClear()
    const assignmentEncryptions = () => encrypt.mock.calls.filter(([plaintext]) => {
      try { return (JSON.parse(plaintext) as { kind?: number }).kind === ASSIGNMENT_KIND } catch { return false }
    }).length
    const log = directLog(f, store)
    await log.open()
    await vi.waitFor(() => expect(log.snapshot().ready).toBe(true))
    expect(log.snapshot().assignments).toHaveLength(320)
    expect(store.commits).toBe(5)
    expect(store.saves).toBe(incremental ? 2 : 5)
    expect(store.appends).toBe(incremental ? 3 : 0)
    expect(assignmentEncryptions()).toBe(320)
    f.relay.publish(outers[0]!)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.commits).toBe(5)
    expect(assignmentEncryptions()).toBe(320)
    const relay = new SimRelay({ replay: true }), transport = new SimTransport(relay)
    const restartedStore = incremental ? incrementalStorage(new Map(store.values)) : storage(new Map(store.values))
    const restarted = directLog(f, restartedStore, transport)
    await restarted.open()
    await vi.waitFor(() => expect(restarted.snapshot().ready).toBe(true))
    expect(restarted.snapshot().assignments).toHaveLength(320)
    expect(restartedStore.commits).toBe(0)
    expect(assignmentEncryptions()).toBe(320)
    transport.close()
  })
})

describe('bounded read-only assignment observation', () => {
  it('uses the authenticated journal and live envelopes without signing, publishing or changing storage', async () => {
    const f = await fixture()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Observe the correct room', criteria: 'No extra authority', owner: f.worker.participant }, 'reader_create_001')
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    const saved = f.aStore.value!
    const store = { load: async () => saved, save: vi.fn() }
    const t = f.transport()
    const subscribe = vi.spyOn(t, 'subscribe')
    const publish = vi.spyOn(t, 'publish')
    const room = deriveRoom(f.creator.keeperState!.secret)
    const reader = new AssignmentLog({ ...room, transport: t, readOnly: true, participant: f.identity.pubkey, storage: store, historyLimit: 32 })
    readers.push(reader)
    await reader.open()
    await vi.waitFor(() => expect(reader.snapshot().ready).toBe(true))
    expect(subscribe.mock.calls[0]![0]).toEqual([{ kinds: [1460], '#d': [deriveChannel(room.roomId, room.roomKey, 'assignments').id], limit: 32, since: expect.any(Number) }])
    expect(reader.snapshot().assignments[0]?.head).toBe(created.head)
    expect(reader.snapshot().historyComplete).toBe(false)
    expect(f.a.snapshot().historyComplete).toBe(true)
    await f.b.submit(created.id, { op: 'claim', executor: 'observed_executor_01', next: 'Check the build' }, 'reader_claim_001')
    await vi.waitFor(() => expect(reader.snapshot().assignments[0]?.status).toBe('running'))
    await expect(reader.submit(created.id, { op: 'stop', purpose: 'cancel', reason: 'No permission through navigation' }, 'reader_stop_001')).rejects.toThrow('origin room')
    await expect(reader.retry()).rejects.toThrow('origin room')
    expect(publish).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    reader.close()
    expect(reader.snapshot().assignments).toEqual([])
    expect(reader.snapshot().historyComplete).toBe(false)
  })

  it('reports missing parents without treating a bounded replay as complete history', async () => {
    const f = await fixture()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Older task', criteria: 'Do not invent missing work', owner: f.worker.participant }, 'reader_old_create_001')
    await vi.waitFor(() => expect(f.b.snapshot().assignments).toHaveLength(1))
    await f.b.submit(created.id, { op: 'claim', executor: 'reader_old_executor_01', next: 'Older work' }, 'reader_old_claim_001')
    const room = deriveRoom(f.creator.keeperState!.secret)
    const channel = deriveChannel(room.roomId, room.roomKey, 'assignments').id
    const latest = f.relay.published.filter(e => e.kind === 1460 && e.tags.some(t => t[0] === 'd' && t[1] === channel)).at(-1)!
    const publish = vi.fn(async () => {})
    const reader = new AssignmentLog({ ...room, participant: f.identity.pubkey, readOnly: true, storage: { load: async () => undefined }, since: 0, historyLimit: 1,
      transport: { publish, close() {}, subscribe: (_filters, event, eose) => { event(latest); eose?.(); return () => {} } } })
    readers.push(reader)
    await reader.open()
    await vi.waitFor(() => expect(reader.snapshot().pendingHistory).toBe(1))
    expect(reader.snapshot().assignments).toEqual([])
    expect(reader.snapshot().ready).toBe(false)
    expect(reader.snapshot().historyComplete).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('caps historical processing even when a relay ignores its requested limit', async () => {
    const f = await fixture()
    for (let i = 0; i < 3; i++) await f.a.submit(undefined, { op: 'create', objective: `Bounded task ${i}`, criteria: 'Keep navigation bounded', owner: f.worker.participant }, `reader_bounded_create_${i}`)
    const reader = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), readOnly: true, participant: f.identity.pubkey,
      transport: f.transport(), storage: { load: async () => undefined }, historyLimit: 1, since: 0 })
    readers.push(reader)
    await reader.open()
    await vi.waitFor(() => expect(reader.snapshot().ready).toBe(true))
    expect(reader.snapshot().assignments).toHaveLength(1)
    expect(reader.snapshot().historyComplete).toBe(false)
  })

  it('fails closed when a journal belongs to another room', async () => {
    const f = await fixture()
    await f.a.submit(undefined, { op: 'create', objective: 'Private task', criteria: 'Respect room scope', owner: f.worker.participant }, 'reader_private_create_001')
    const t = f.transport()
    const subscribe = vi.spyOn(t, 'subscribe')
    const room = deriveRoom(f.creator.keeperState!.secret)
    const reader = new AssignmentLog({ ...room, roomId: '0'.repeat(64), readOnly: true, participant: f.identity.pubkey, transport: t, storage: { load: async () => f.aStore.value } })
    readers.push(reader)
    await expect(reader.open()).rejects.toThrow('authentication')
    expect(reader.snapshot().assignments).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('does not subscribe after closure while loading the cache', async () => {
    const f = await fixture()
    let resolve!: (value: undefined) => void
    const loading = new Promise<undefined>(done => { resolve = done })
    const t = f.transport()
    const subscribe = vi.spyOn(t, 'subscribe')
    const reader = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), readOnly: true, participant: f.identity.pubkey, transport: t, storage: { load: () => loading } })
    readers.push(reader)
    const opened = reader.open()
    reader.close()
    resolve(undefined)
    await opened
    reader.rekey({ id: '2'.repeat(64), key: generateSecretKey() })
    expect(subscribe).not.toHaveBeenCalled()
    expect(reader.snapshot().ready).toBe(false)
  })

  it('discards a partially loaded journal if a later entry fails authentication', async () => {
    const f = await fixture()
    await f.a.submit(undefined, { op: 'create', objective: 'No partial cache', criteria: 'Authenticate the entire saved journal', owner: f.worker.participant }, 'reader_corrupt_create_001')
    const cache = JSON.parse(f.aStore.value!)
    cache.events.push('invalid_ciphertext')
    const reader = new AssignmentLog({ ...deriveRoom(f.creator.keeperState!.secret), readOnly: true, participant: f.identity.pubkey,
      transport: f.transport(), storage: { load: async () => JSON.stringify(cache) } })
    readers.push(reader)
    await expect(reader.open()).rejects.toThrow()
    expect(reader.snapshot().assignments).toEqual([])
    expect(reader.snapshot().ready).toBe(false)
  })

  it('does not reuse an observer for another room or accept a damaged envelope', async () => {
    const f = await fixture()
    const room = deriveRoom(f.creator.keeperState!.secret)
    let incoming!: (event: import('nostr-tools/pure').Event) => void
    const reader = new AssignmentLog({ ...room, readOnly: true, participant: f.identity.pubkey, storage: { load: async () => undefined }, since: 0,
      transport: { publish: vi.fn(async () => {}), close() {}, subscribe: (_filter, event, eose) => { incoming = event; eose?.(); return () => {} } } })
    readers.push(reader)
    await reader.open()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Authenticated work only', criteria: 'Check the original envelope', owner: f.worker.participant }, 'reader_auth_create_001')
    const channel = deriveChannel(room.roomId, room.roomKey, 'assignments').id
    const envelope = f.relay.published.filter(e => e.kind === 1460 && e.tags.some(t => t[0] === 'd' && t[1] === channel)).at(-1)!
    incoming({ ...envelope, content: 'damaged encrypted event' })
    incoming({ ...envelope, tags: [['d', '0'.repeat(64)]] })
    expect(reader.snapshot().assignments).toEqual([])
    incoming(envelope)
    await vi.waitFor(() => expect(reader.snapshot().assignments[0]?.id).toBe(created.id))
    reader.close()
    incoming(envelope)
    expect(reader.snapshot().assignments).toEqual([])
  })

  it.each([0, 513, 1.5, NaN])('rejects the invalid history limit %s', historyLimit => {
    expect(() => new AssignmentLog({ roomId: '0'.repeat(64), roomKey: new Uint8Array(32), readOnly: true, participant: '1'.repeat(64),
      storage: { load: async () => undefined }, transport: new SimTransport(new SimRelay()), historyLimit })).toThrow('history limit')
  })
})
