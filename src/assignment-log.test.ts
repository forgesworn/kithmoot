import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { AssignmentLog, type AssignmentStorage } from './assignment-log.js'
import { ASSIGNMENT_KIND } from './assignments.js'
import { deriveRoom } from './room.js'
import { deriveChannel } from './chat.js'

function storage(): AssignmentStorage & { value?: string; fail: boolean } {
  return { fail: false, async load() { return this.value }, async save(value) { if (this.fail) throw new Error('Disk full'); this.value = value } }
}
const clients: RoomAgent[] = []
const readers: AssignmentLog[] = []
afterEach(() => { for (const r of readers.splice(0)) r.close(); for (const c of clients.splice(0)) c.leave() })

async function fixture() {
  const relay = new SimRelay({ replay: true })
  let loseAck = false
  const transport = () => {
    const t = new SimTransport(relay)
    const publish = t.publish.bind(t)
    t.publish = async event => { await publish(event); if (loseAck && event.kind === 1460) throw new Error('Acknowledgement lost') }
    return t
  }
  const identity = localIdentity(generateSecretKey())
  const creator = await RoomAgent.create({ base: 'https://example.test/j/', name: 'Person', agent: false, identity, transport, announceJitterMs: 0 })
  clients.push(creator)
  const worker = await RoomAgent.join({ link: creator.url, name: 'Worker', transport, announceJitterMs: 0 })
  clients.push(worker)
  const aStore = storage(); const bStore = storage()
  const a = await creator.session.assignments(aStore)
  const b = await worker.session.assignments(bStore)
  await vi.waitFor(() => expect(a.snapshot().ready && b.snapshot().ready).toBe(true))
  return { relay, creator, worker, a, b, aStore, bStore, transport, identity, setLostAck: (v: boolean) => { loseAck = v } }
}

describe('durable encrypted assignment transport', () => {
  it('delivers the complete create, claim, result and review journey through authenticated room envelopes', async () => {
    const f = await fixture()
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
      expect(f.aStore.value).not.toContain(privateValue)
    }
  })

  it('restarts with a lost acknowledgement and retries the identical signed operation', async () => {
    const f = await fixture()
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

  it('does not publish when durable storage fails', async () => {
    const f = await fixture()
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
