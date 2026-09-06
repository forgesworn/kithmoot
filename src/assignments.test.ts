import { describe, expect, it } from 'vitest'
import { generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from './identity.js'
import { assignmentId, assignmentPayload, projectAssignments, signAssignment, validateActionInputs, validateAssignmentActions, type AssignmentOperation } from './assignments.js'

const room = 'a'.repeat(64)
function fixture() {
  const human = localIdentity(generateSecretKey())
  const worker = localIdentity(generateSecretKey())
  const stranger = localIdentity(generateSecretKey())
  const request = 'create_request_0001'
  const assignment = assignmentId(human.pubkey, request)
  const events: Event[] = []
  let seq = 0
  const add = async (actor: typeof human, operation: AssignmentOperation, previous: string | null = events.at(-1)?.id ?? null) => {
    const event = await signAssignment(actor, room, { v: 1, assignment, request: events.length ? `request_${String(++seq).padStart(12, '0')}` : request, previous, operation }, 100 + seq)
    events.push(event)
    return event
  }
  const create = () => add(human, { op: 'create', objective: 'Check the release', criteria: 'A reproducible report with evidence', owner: worker.pubkey })
  const state = () => projectAssignments(events, room).assignments[0]!
  return { human, worker, stranger, events, add, create, state, assignment }
}
const executor = 'worker_installation_01'

describe('shared assignments', () => {
  it('connects a task through a blocker and exact-result review, independently of delivery order', async () => {
    const f = fixture()
    await f.create()
    await f.add(f.worker, { op: 'claim', executor, next: 'Inspect the build' })
    await f.add(f.worker, { op: 'block', executor, question: 'Which build?' })
    expect(f.state().status).toBe('blocked')
    await f.add(f.human, { op: 'answer', text: 'Build 41' })
    await f.add(f.worker, { op: 'progress', executor, text: 'Build 41 found', next: 'Run the checks' })
    const result = await f.add(f.worker, { op: 'result', executor, summary: 'Checks passed', evidence: 'Build 41; report sha256: abc' })
    expect(f.state().status).toBe('review')
    await f.add(f.human, { op: 'accept', result: result.id })
    const projected = projectAssignments([...f.events].reverse().concat(f.events), room)
    expect(projected.assignments[0]).toEqual(f.state())
    expect(projected.assignments[0]?.status).toBe('accepted')
    expect(projected.pending).toEqual([])
    expect(projected.rejected).toEqual([])
  })

  it('does not let strangers claim, answer, report results or accept work', async () => {
    const f = fixture()
    const root = await f.create()
    const invalid = await f.add(f.stranger, { op: 'claim', executor, next: 'Steal it' })
    expect(f.state().status).toBe('offered')
    expect(projectAssignments(f.events, room).rejected).toContain(invalid.id)
    const claim = await f.add(f.worker, { op: 'claim', executor, next: 'Work' }, root.id)
    await f.add(f.stranger, { op: 'result', executor, summary: 'Pretend', evidence: 'None' }, claim.id)
    expect(f.state().status).toBe('running')
    const result = await f.add(f.worker, { op: 'result', executor, summary: 'Done', evidence: 'Report' }, claim.id)
    await f.add(f.stranger, { op: 'accept', result: result.id })
    expect(f.state().status).toBe('review')
  })

  it('keeps a cancellation pending until the actual owner confirms stopped execution', async () => {
    const f = fixture()
    await f.create()
    await f.add(f.worker, { op: 'claim', executor, next: 'Run' })
    const stop = await f.add(f.human, { op: 'stop', purpose: 'cancel', reason: 'No longer needed' })
    expect(f.state().status).toBe('stopping')
    await f.add(f.stranger, { op: 'release', executor, evidence: 'Pretend stopped' })
    expect(f.state().status).toBe('stopping')
    await f.add(f.worker, { op: 'release', executor, evidence: 'Process exited 0; no child processes' }, stop.id)
    expect(f.state().status).toBe('cancelled')
  })

  it('requires stopped execution before a handoff and invalidates the previous execution token', async () => {
    const f = fixture()
    await f.create()
    const claim = await f.add(f.worker, { op: 'claim', executor, next: 'Run' })
    await f.add(f.human, { op: 'assign', owner: f.stranger.pubkey, reason: 'Transfer early' })
    expect(f.state().owner).toBe(f.worker.pubkey)
    await f.add(f.human, { op: 'stop', purpose: 'handoff', reason: 'Transfer' }, claim.id)
    await f.add(f.worker, { op: 'release', executor, evidence: 'Handle is terminal' })
    await f.add(f.human, { op: 'assign', owner: f.stranger.pubkey, reason: 'Continue' })
    expect(f.state()).toMatchObject({ owner: f.stranger.pubkey, status: 'offered', attempt: 2 })
    const next = await f.add(f.stranger, { op: 'claim', executor: 'new_installation_01', next: 'Run' })
    await f.add(f.worker, { op: 'result', executor, summary: 'Late result', evidence: 'Old work' }, next.id)
    expect(f.state().status).toBe('running')
  })

  it('rejection starts a new attempt and old acceptance cannot approve the new result', async () => {
    const f = fixture()
    await f.create()
    await f.add(f.worker, { op: 'claim', executor, next: 'Run' })
    const first = await f.add(f.worker, { op: 'result', executor, summary: 'Draft', evidence: 'Version 1' })
    await f.add(f.human, { op: 'reject', result: first.id, reason: 'Test the missing case' })
    expect(f.state()).toMatchObject({ status: 'offered', attempt: 2 })
    await f.add(f.worker, { op: 'claim', executor, next: 'Run the missing case' })
    const second = await f.add(f.worker, { op: 'result', executor, summary: 'Revised', evidence: 'Version 2' })
    await f.add(f.human, { op: 'accept', result: first.id })
    expect(f.state().status).toBe('review')
    await f.add(f.human, { op: 'accept', result: second.id }, second.id)
    expect(f.state().status).toBe('accepted')
  })

  it('halts simultaneous claims instead of authorising both or using a clock-based takeover', async () => {
    const f = fixture()
    const root = await f.create()
    await f.add(f.worker, { op: 'claim', executor, next: 'First device' })
    await f.add(f.worker, { op: 'claim', executor: 'other_installation_01', next: 'Second device' }, root.id)
    expect(f.state().status).toBe('conflicted')
    expect(projectAssignments([...f.events].reverse(), room).assignments).toEqual([f.state()])
  })

  it('waits for missing history and rejects wrong-room, modified and hidden private fields', async () => {
    const f = fixture()
    await f.create()
    const claim = await f.add(f.worker, { op: 'claim', executor, next: 'Run' })
    expect(projectAssignments([claim], room)).toMatchObject({ assignments: [], pending: [claim.id] })
    expect(assignmentPayload(claim, 'b'.repeat(64))).toBeUndefined()
    expect(assignmentPayload({ ...claim, content: claim.content.replace('Run', 'Tampered') }, room)).toBeUndefined()
    await expect(f.add(f.human, { op: 'create', objective: 'Task', criteria: 'Done', owner: f.worker.pubkey, privateNotes: 'Never share' } as AssignmentOperation, null)).rejects.toThrow()
  })

  it('validates discoverable inputs and refuses unknown fields instead of leaking a whole task', () => {
    const actions = validateAssignmentActions([{ id: 'review', label: 'Review changes', description: 'Review a selected revision', inputs: [{ id: 'revision', label: 'Revision', required: true }] }])!
    expect(validateActionInputs(actions[0]!, {})).toBe(false)
    expect(validateActionInputs(actions[0]!, { revision: 'abc123' })).toBe(true)
    expect(validateActionInputs(actions[0]!, { revision: 'abc123', privateNotes: 'private' })).toBe(false)
    expect(validateAssignmentActions([{ ...actions[0], shell: 'arbitrary command' }])).toBeUndefined()
  })
})
