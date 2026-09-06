import { join } from 'node:path'
import type { RoomAgent } from '../agent.js'
import type { AssignmentLog } from '../assignment-log.js'
import { validateActionInputs, type Assignment, type AssignmentAction, type AssignmentOperation } from '../assignments.js'
import { AssignmentExecutionJournal, type ExecutionRecord } from './assignment-execution.js'
import { openAssignmentStorage } from './assignment-storage.js'

/** Adapter for tool-driven agents. A claim returns start=true only once per
 * durable attempt. Tool drivers must obey that result and use their normal
 * approval rules for side effects. A room assignment is not shell authority. */
export class AgentAssignmentWork {
  readonly #active = new Map<string, ExecutionRecord>()
  readonly #claiming = new Map<string, Promise<{ start: boolean; assignment: Assignment; execution: ExecutionRecord }>>()
  private constructor(readonly agent: RoomAgent, readonly log: AssignmentLog, readonly journal: AssignmentExecutionJournal,
    readonly actions: AssignmentAction[], readonly closeStorage: () => Promise<void>) {}

  static async open(agent: RoomAgent, directory: string, actions: AssignmentAction[] = []): Promise<AgentAssignmentWork> {
    const store = await openAssignmentStorage(join(directory, 'room.json'))
    try {
      const log = await agent.session.assignments(store)
      return new AgentAssignmentWork(agent, log, new AssignmentExecutionJournal(join(directory, 'executions')), actions, () => store.close())
    } catch (e) { await store.close(); throw e }
  }
  #state(id: string): Assignment {
    const snapshot = this.log.snapshot()
    if (!snapshot.ready) throw new Error(snapshot.error ?? 'Assignment history is not ready')
    const s = snapshot.assignments.find(s => s.id === id)
    if (!s) throw new Error('Assignment not found')
    if (s.owner !== this.agent.participant) throw new Error('This assignment belongs to another participant')
    if (s.status === 'conflicted') throw new Error('Conflicting updates: stop work and reconcile the assignment')
    return s
  }
  async claim(id: string, next: string): Promise<{ start: boolean; assignment: Assignment; execution: ExecutionRecord }> {
    const pending = this.#claiming.get(id)
    if (pending) return { ...await pending, start: false }
    const task = this.#claim(id, next).finally(() => { this.#claiming.delete(id) })
    this.#claiming.set(id, task)
    return task
  }
  async #claim(id: string, next: string): Promise<{ start: boolean; assignment: Assignment; execution: ExecutionRecord }> {
    const s = this.#state(id)
    if (s.ownerDevice !== this.agent.device) throw new Error('This attempt is not bound to this agent installation. Inspect the assigned installation before handing it over.')
    const key = `${id}:${s.attempt}`
    const held = this.#active.get(key)
    if (held && held.phase !== 'reserved') return { start: false, assignment: s, execution: held }
    if (s.status !== 'offered' && !(held && s.executor === held.executor)) throw new Error('Assignment is not offered for execution')
    if (s.action) {
      const action = this.actions.find(a => a.id === s.action)
      if (!action || !validateActionInputs(action, s.inputs ?? {})) throw new Error('This agent does not offer that action with those inputs')
    }
    if (!held && s.creator !== this.agent.owner?.principal && !this.agent.announcedAdmins.has(s.creator)) {
      if (!this.agent.owner && this.agent.announcedAdmins.size === 0) throw new Error('An attested principal or room admin must authorise this agent before it can take assignments')
      const approval = await this.agent.requestApproval({
        text: `Take assignment ${s.id} (${s.head})? ${s.objective.slice(0, 180)}. Ordinary work only; further side effects retain their own approval requirements.`,
        options: ['approve', 'decline'],
      })
      if (approval.expired || approval.verdict !== 'approve') throw new Error('Assignment was not approved by this agent’s principal or a room admin')
      if (this.#state(id).head !== s.head) throw new Error('Assignment changed while approval was pending')
    }
    const record = held ?? await this.journal.reserve(id, s.attempt)
    this.#active.set(key, record)
    await this.log.submit(id, { op: 'claim', executor: record.executor, next }, record.claimRequest)
    const running = await this.journal.update(record, 'running')
    this.#active.set(key, running)
    const current = this.#state(id)
    if (current.status !== 'running' || current.executor !== running.executor || this.log.snapshot().pendingSends) {
      throw new Error('Execution was not started: the confirmed claim changed. Inspect and reconcile it before taking action.')
    }
    return { start: true, assignment: current, execution: running }
  }
  async report(id: string, op: 'progress' | 'block' | 'result' | 'release', fields: { text?: string; next?: string; question?: string; summary?: string; evidence?: string }, request: string): Promise<Assignment> {
    const s = this.#state(id)
    const key = `${id}:${s.attempt}`
    const record = this.#active.get(key)
    if (!record || record.executor !== s.executor) throw new Error('This process has no active execution for this attempt; inspect its existing execution')
    let operation: AssignmentOperation
    switch (op) {
      case 'progress': operation = { op, executor: record.executor, text: fields.text ?? '', next: fields.next ?? '' }; break
      case 'block': operation = { op, executor: record.executor, question: fields.question ?? '' }; break
      case 'result': operation = { op, executor: record.executor, summary: fields.summary ?? '', evidence: fields.evidence ?? '' }; break
      case 'release': operation = { op, executor: record.executor, evidence: fields.evidence ?? '' }; break
    }
    // The operation is durably queued before the journal becomes terminal.
    // If the process dies between these writes, replay finds the result and
    // the existing reservation still prevents another execution.
    const updated = await this.log.submit(id, operation, request)
    if (op === 'result' || op === 'release') {
      const terminal = await this.journal.update(record, op === 'result' ? 'result' : 'stopped', { request, event: updated.head })
      this.#active.set(key, terminal)
    }
    return updated
  }
  async inspect(id: string): Promise<unknown> {
    const s = this.#state(id)
    return { assignment: s, execution: await this.journal.inspect(id, s.attempt), guidance: 'An existing record is never permission to restart work. Check the original process and external job handles. Confirm stopped execution before handing off.' }
  }
  async recoverStopped(id: string, evidence: string, request: string): Promise<Assignment> {
    if (!evidence.trim() || evidence.length > 2000) throw new Error('Describe how the original process and all external jobs were checked and stopped')
    const s = this.#state(id)
    if (s.status !== 'stopping' || !s.executor) throw new Error('The creator must request cancellation or handoff before recovering stopped execution')
    const existing = await this.journal.inspect(id, s.attempt)
    if (!existing.record || existing.record.executor !== s.executor || existing.process !== 'missing') {
      throw new Error('Recovery requires the original execution record and an absent original process; inspect live or unknown work first')
    }
    if (!this.agent.owner && this.agent.announcedAdmins.size === 0) throw new Error('A principal or room admin must confirm stopped-execution recovery')
    const approval = await this.agent.requestApproval({
      text: `Confirm stopped execution for assignment ${s.id}, attempt ${s.attempt}, executor ${s.executor}, state ${s.head}? The original process is absent. Confirm ALL external jobs have stopped. Evidence: ${evidence}`,
      options: ['confirm-stopped', 'decline'],
    })
    if (approval.expired || approval.verdict !== 'confirm-stopped') throw new Error('Stopped-execution recovery was not confirmed')
    const inspected = await this.journal.inspect(id, s.attempt)
    if (this.#state(id).head !== s.head || inspected.process !== 'missing' || inspected.record?.executor !== s.executor) {
      throw new Error('Execution or assignment changed during recovery review')
    }
    const released = await this.log.submit(id, { op: 'release', executor: s.executor, evidence: `Stopped execution confirmed by ${approval.by}. ${evidence}` }, request)
    await this.journal.recoverStopped(existing.record, request, released.head)
    return released
  }
  async wait(timeoutMs: number): Promise<unknown> {
    return new Promise(resolve => {
      const off = this.log.onChange(() => { clearTimeout(timer); off(); resolve(this.log.snapshot()) })
      const timer = setTimeout(() => { off(); resolve({ timedOut: true }) }, Math.min(300_000, Math.max(100, timeoutMs)))
    })
  }
  async close(): Promise<void> { this.log.close(); await this.closeStorage() }
}
