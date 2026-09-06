import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import type { AssignmentStorage } from './assignment-log.js'
import { ASSIGNMENT_KIND } from './assignments.js'
import { deriveRoom } from './room.js'
import { deriveChannel } from './chat.js'

function storage(): AssignmentStorage & { value?: string; fail: boolean } {
  return { fail: false, async load() { return this.value }, async save(value) { if (this.fail) throw new Error('Disk full'); this.value = value } }
}
const clients: RoomAgent[] = []
afterEach(() => { for (const c of clients.splice(0)) c.leave() })

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

  it('refuses an update from a room member who does not own the assignment', async () => {
    const f = await fixture()
    const created = await f.a.submit(undefined, { op: 'create', objective: 'Owned task', criteria: 'Named worker only', owner: f.worker.participant }, 'owned_request_001')
    await expect(f.a.submit(created.id, { op: 'claim', executor: 'impostor_installation', next: 'Steal' }, 'steal_request_001')).rejects.toThrow('not permitted')
    expect(f.a.snapshot().assignments[0]?.status).toBe('offered')
  })
})
