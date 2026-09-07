import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { RoomAgent } from './agent.js'
import { DenAssignmentClient, type DenWorkStore } from './den-client.js'
import { localIdentity } from './identity.js'
import { issueAgentOwnership } from './ownership.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { AgentAssignmentWork } from './node/assignment-work.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
function store(): DenWorkStore & { values: Map<string, string> } {
  return { values: new Map(), async get(k) { return this.values.get(k) }, async set(k, v) { this.values.set(k, v) } }
}
async function fixture() {
  const relay = new SimRelay({ replay: true })
  const transport = () => new SimTransport(relay)
  const creator = await RoomAgent.create({ base: 'https://example.test/j/', name: 'Room owner', transport, announceJitterMs: 0 })
  cleanup.push(() => creator.leave())
  const secret = generateSecretKey()
  const principal = hkdf(sha256, secret, new TextEncoder().encode(creator.roomId), 'den/kithmoot/v1/participant', 32)
  const identity = localIdentity(generateSecretKey())
  const worker = await RoomAgent.join({ link: creator.url, name: 'Tally', identity, owner: issueAgentOwnership({ principalSk: principal, agent: identity.pubkey, issuedAt: Math.floor(Date.now() / 1000) }), transport, announceJitterMs: 0 })
  cleanup.push(() => worker.leave())
  const storage = store()
  const den = new DenAssignmentClient({ secret: bytesToHex(secret), device: 'phone-01', store: storage, changed() {}, transport })
  cleanup.push(() => den.close())
  await den.open()
  await den.connect(creator.url, 'Release room')
  const directory = await mkdtemp(join(tmpdir(), 'den-assignment-'))
  // maxRetries covers the ENOTEMPTY that recursive rm hits under CI load when a
  // just-closed worker's last writes land between the readdir and the rmdir.
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const work = await AgentAssignmentWork.open(worker, join(directory, 'worker'))
  cleanup.push(() => work.close())
  await vi.waitFor(() => expect(den.room(creator.roomId).ready && work.log.snapshot().ready).toBe(true))
  return { relay, creator, worker, den, work, directory, secret, storage, transport, identity }
}

describe('Den to KithMoot shared-work journey', () => {
  it('requires execution inspection and an authenticated principal decision before recovering a crashed attempt', { timeout: 20_000 }, async () => {
    const f = await fixture()
    const room = f.creator.roomId
    const created = await f.den.submit(room, undefined, { op: 'create', objective: 'Recover checked work', criteria: 'No surviving external work', owner: f.worker.participant, ownerDevice: f.worker.device }, 'recover_create_001')
    await vi.waitFor(() => expect(f.work.log.snapshot().assignments).toHaveLength(1))
    await f.work.claim(created.id, 'Inspect the fixture')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('running'))
    await f.den.submit(room, created.id, { op: 'stop', purpose: 'handoff', reason: 'Recover after a process crash' }, 'recover_handoff_01')
    await vi.waitFor(() => expect(f.work.log.snapshot().assignments[0]?.status).toBe('stopping'))
    await expect(f.work.recoverStopped(created.id, 'The fixture has no detached jobs', 'recover_live_0001')).rejects.toThrow('absent original process')
    const record = (await f.work.journal.inspect(created.id, 1)).record!
    await f.work.close(); f.worker.leave()
    // The process-death/cache-lock test uses a real killed child. Here the
    // unreachable pid makes the approval protocol deterministic in-process.
    await writeFile(join(f.work.journal.directory, `${created.id}-1.json`), JSON.stringify({ ...record, pid: 2147483647 }))
    const restarted = await RoomAgent.join({ link: f.creator.url, name: 'Tally restarted', identity: f.identity, owner: f.worker.owner, transport: f.transport, announceJitterMs: 0 })
    cleanup.push(() => restarted.leave())
    const work = await AgentAssignmentWork.open(restarted, join(f.directory, 'worker'))
    cleanup.push(() => work.close())
    const principalKey = hkdf(sha256, f.secret, new TextEncoder().encode(room), 'den/kithmoot/v1/participant', 32)
    const principal = await RoomAgent.join({ link: f.creator.url, name: 'Reviewer', agent: false, identity: localIdentity(principalKey), transport: f.transport, announceJitterMs: 0 })
    cleanup.push(() => principal.leave())
    await vi.waitFor(() => expect(work.log.snapshot().ready).toBe(true))
    await expect(work.claim(created.id, 'Start again')).rejects.toThrow('installation')
    const pending = work.recoverStopped(created.id, 'Original process absent. This fixture launched no external jobs.', 'recover_release_01')
    const control = principal.channel(CONTROL_CHANNEL)
    const request = () => control.messages().map(m => decodeControl(m.text)).find(c => c?.op === 'approval-request')
    await vi.waitFor(() => expect(request()).toBeDefined())
    expect(work.log.snapshot().assignments[0]?.status).toBe('stopping')
    await control.send(encodeControl({ op: 'approval', id: request()!.id, verdict: 'confirm-stopped' }))
    expect((await pending).status).toBe('stopped')
    expect((await work.journal.inspect(created.id, 1)).record?.phase).toBe('stopped')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('stopped'))
    await f.den.submit(room, created.id, { op: 'assign', owner: restarted.participant, ownerDevice: restarted.device, reason: 'Begin a new checked attempt' }, 'recover_assign_001')
    await vi.waitFor(() => expect(work.log.snapshot().assignments[0]?.attempt).toBe(2))
    expect((await work.claim(created.id, 'Start the explicitly reassigned attempt')).start).toBe(true)
  })
  it('binds execution to one installation even when two workers share a participant identity', async () => {
    const f = await fixture()
    const other = await RoomAgent.join({ link: f.creator.url, name: 'Tally duplicate', identity: f.identity, owner: f.worker.owner, transport: f.transport, announceJitterMs: 0 })
    cleanup.push(() => other.leave())
    const duplicate = await AgentAssignmentWork.open(other, join(f.directory, 'duplicate-worker'))
    cleanup.push(() => duplicate.close())
    const assignment = await f.den.submit(f.creator.roomId, undefined, { op: 'create', objective: 'Execute once across installations', criteria: 'Only the designated installation starts', owner: f.worker.participant, ownerDevice: f.worker.device }, 'den_bound_request_001')
    await vi.waitFor(() => {
      expect(duplicate.log.snapshot().assignments).toHaveLength(1)
      expect(f.work.log.snapshot().assignments).toHaveLength(1)
    })
    await expect(duplicate.log.submit(assignment.id, { op: 'claim', executor: 'duplicate_before_start', next: 'Bypass the adapter before anyone starts' }, 'den_first_bypass_01')).rejects.toThrow('not permitted')
    const attempts = await Promise.allSettled([f.work.claim(assignment.id, 'Run once'), duplicate.claim(assignment.id, 'Run again')])
    if (attempts[0].status === 'rejected') throw attempts[0].reason
    expect(attempts[0].value.start).toBe(true)
    expect(attempts[1].status).toBe('rejected')
    expect(await duplicate.journal.records()).toEqual([])
    await expect(duplicate.log.submit(assignment.id, { op: 'claim', executor: 'duplicate_executor_01', next: 'Bypass the adapter' }, 'den_bypass_request_01')).rejects.toThrow('not permitted')
  })
  it('runs one actual agent action and returns an exact review action to Den', async () => {
    const f = await fixture()
    const assignment = await f.den.submit(f.creator.roomId, undefined, { op: 'create', objective: 'Prepare release evidence', criteria: 'An artifact with its digest', owner: f.worker.participant, ownerDevice: f.worker.device }, 'den_create_request_01')
    await vi.waitFor(() => expect(f.work.log.snapshot().assignments).toHaveLength(1))
    const [claim, simultaneous] = await Promise.all([
      f.work.claim(assignment.id, 'Write the evidence artifact'),
      f.work.claim(assignment.id, 'Write the evidence artifact'),
    ])
    expect(claim.start).toBe(true)
    expect(simultaneous.start).toBe(false)
    const artifact = join(f.directory, 'evidence.txt')
    await writeFile(artifact, 'A reproducible release check\n')
    const digest = bytesToHex(sha256(await readFile(artifact)))
    expect((await f.work.claim(assignment.id, 'Write the evidence artifact')).start).toBe(false)
    const result = await f.work.report(assignment.id, 'result', { summary: 'Evidence prepared', evidence: `evidence.txt sha256:${digest}` }, 'den_result_request_01')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.action).toBe('Review: Prepare release evidence'))
    await f.den.submit(f.creator.roomId, assignment.id, { op: 'accept', result: result.result!.id }, 'den_accept_request_01')
    await vi.waitFor(() => expect(f.work.log.snapshot().assignments[0]?.status).toBe('accepted'))
    expect(f.den.snapshot().attention[0]).toMatchObject({ assignment: assignment.id, status: 'accepted', action: undefined })
    expect((await f.work.journal.inspect(assignment.id, 1)).record?.phase).toBe('result')
    const publicBytes = JSON.stringify(f.relay.published)
    expect(publicBytes).not.toContain('Prepare release evidence')
    expect(publicBytes).not.toContain(digest)
    expect(publicBytes).not.toContain(bytesToHex(f.secret))
    expect(JSON.stringify([...f.storage.values])).not.toContain(f.creator.url)
  })

  it('restores the same creator and assignment on another Den device without importing private Den data', async () => {
    const f = await fixture()
    const assignment = await f.den.submit(f.creator.roomId, undefined, { op: 'create', objective: 'One shared record', criteria: 'Same identity after reconnect', owner: f.worker.participant, ownerDevice: f.worker.device }, 'den_reconnect_request')
    const participant = f.den.room(f.creator.roomId).participant
    f.den.close()
    const second = new DenAssignmentClient({ secret: bytesToHex(f.secret), device: 'laptop-02', store: f.storage, changed() {}, transport: f.transport })
    cleanup.push(() => second.close())
    await second.open()
    await vi.waitFor(() => expect(second.room(f.creator.roomId).ready).toBe(true))
    expect(second.room(f.creator.roomId).participant).toBe(participant)
    expect(second.room(f.creator.roomId).assignments.map(s => s.id)).toEqual([assignment.id])
    await expect(second.submit(f.creator.roomId, undefined, {
      op: 'create', objective: 'Explicit projection only', criteria: 'No notes', owner: f.worker.participant, ownerDevice: f.worker.device, notes: 'private', focusHistory: ['private'],
    } as never, 'den_private_request_01')).rejects.toThrow()
  })

  it('does not let an unrelated Den user run an unowned agent', async () => {
    const f = await fixture()
    // Remove the attested owner by joining a separate, unowned worker.
    const worker = await RoomAgent.join({ link: f.creator.url, name: 'Unowned', transport: f.transport, announceJitterMs: 0 })
    cleanup.push(() => worker.leave())
    const work = await AgentAssignmentWork.open(worker, join(f.directory, 'unowned'))
    cleanup.push(() => work.close())
    const assignment = await f.den.submit(f.creator.roomId, undefined, { op: 'create', objective: 'No implicit authority', criteria: 'Refuse execution', owner: worker.participant, ownerDevice: worker.device }, 'den_refusal_request_01')
    await vi.waitFor(() => expect(work.log.snapshot().assignments).toHaveLength(1))
    await expect(work.claim(assignment.id, 'Do work')).rejects.toThrow('must authorise')
    expect((await work.journal.records())).toEqual([])
  })

  it('carries blocker, rejected result, stopped handoff and cancellation through the same Den record', { timeout: 20_000 }, async () => {
    const f = await fixture()
    const room = f.creator.roomId
    const created = await f.den.submit(room, undefined, { op: 'create', objective: 'Check evidence', criteria: 'Reviewed artifact', owner: f.worker.participant, ownerDevice: f.worker.device }, 'journey_create_001')
    const id = created.id
    const state = () => f.work.log.snapshot().assignments.find(s => s.id === id)
    await vi.waitFor(() => expect(state()?.status).toBe('offered'))
    await f.work.claim(id, 'Inspect evidence')
    await f.work.report(id, 'block', { question: 'Which build?' }, 'journey_block_001')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.action).toBe('Answer: Which build?'))
    await f.den.submit(room, id, { op: 'answer', text: 'Build 54' }, 'journey_answer_001')
    await vi.waitFor(() => expect(state()?.answer).toBe('Build 54'))
    const result = await f.work.report(id, 'result', { summary: 'Checked 54', evidence: 'Test output for build 54' }, 'journey_result_001')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('review'))
    await f.den.submit(room, id, { op: 'reject', result: result.result!.id, reason: 'Add the artifact digest' }, 'journey_reject_001')
    await vi.waitFor(() => expect(state()?.attempt).toBe(2))
    expect((await f.work.claim(id, 'Add the digest')).start).toBe(true)
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('running'))
    await f.den.submit(room, id, { op: 'stop', purpose: 'handoff', reason: 'A person will finish the check' }, 'journey_handoff_01')
    await vi.waitFor(() => expect(state()?.status).toBe('stopping'))
    await expect(f.den.submit(room, id, { op: 'assign', owner: f.creator.participant, reason: 'Too early' }, 'journey_early_001')).rejects.toThrow('not permitted')
    await f.work.report(id, 'release', { evidence: 'No external jobs remain; current action returned' }, 'journey_release_01')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('stopped'))
    const humanLog = await f.creator.session.assignments({ async load() { return undefined }, async save() {} })
    await vi.waitFor(() => expect(humanLog.snapshot().ready).toBe(true))
    await f.den.submit(room, id, { op: 'assign', owner: f.creator.participant, reason: 'Finish the review manually' }, 'journey_assign_001')
    await vi.waitFor(() => expect(humanLog.snapshot().assignments[0]?.owner).toBe(f.creator.participant))
    await humanLog.submit(id, { op: 'claim', executor: 'journey_human_execution', next: 'Inspect the digest' }, 'journey_human_001')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('running'))
    await f.den.submit(room, id, { op: 'stop', purpose: 'cancel', reason: 'This build was superseded' }, 'journey_cancel_001')
    await vi.waitFor(() => expect(humanLog.snapshot().assignments[0]?.status).toBe('stopping'))
    await humanLog.submit(id, { op: 'release', executor: 'journey_human_execution', evidence: 'Review stopped; no work left running' }, 'journey_stopped_01')
    await vi.waitFor(() => expect(f.den.snapshot().attention[0]?.status).toBe('cancelled'))
    expect(f.den.room(room).assignments).toHaveLength(1)
    expect(f.den.room(room).assignments[0]?.history.map(h => h.operation.op)).toEqual([
      'create', 'claim', 'block', 'answer', 'result', 'reject', 'claim', 'stop', 'release', 'assign', 'claim', 'stop', 'release',
    ])
  })
})
