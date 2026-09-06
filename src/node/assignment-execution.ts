import { mkdir, open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicPrivateWrite } from './assignment-storage.js'

export interface ExecutionRecord {
  v: 1
  assignment: string
  attempt: number
  executor: string
  pid: number
  phase: 'reserved' | 'running' | 'result' | 'stopped'
  /** IDs only. Assignment text stays in the encrypted room log. */
  claimRequest: string
  resultRequest?: string
  resultEvent?: string
}

/** An exclusive on-disk reservation precedes the first external action. A
 * leftover reservation is uncertain work, never permission to start again.
 * Process absence is reported for investigation, not treated as proof that
 * detached jobs or external side effects finished. */
export class AssignmentExecutionJournal {
  constructor(readonly directory: string) {}
  #path(assignment: string, attempt: number): string {
    if (!/^[0-9a-f]{64}$/.test(assignment) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid execution identity')
    return join(this.directory, `${assignment}-${attempt}.json`)
  }
  async inspect(assignment: string, attempt: number): Promise<{ record?: ExecutionRecord; process: 'live' | 'missing' | 'unknown' }> {
    let record: ExecutionRecord
    try { record = JSON.parse(await readFile(this.#path(assignment, attempt), 'utf8')) as ExecutionRecord }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { process: 'missing' }; throw e }
    if (record.v !== 1 || record.assignment !== assignment || record.attempt !== attempt || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.executor !== 'string') throw new Error('Invalid execution journal')
    try { process.kill(record.pid, 0); return { record, process: 'live' } }
    catch (e) { return { record, process: (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unknown' } }
  }
  async reserve(assignment: string, attempt: number): Promise<ExecutionRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.#path(assignment, attempt)
    const record: ExecutionRecord = { v: 1, assignment, attempt, executor: randomUUID(), pid: process.pid, phase: 'reserved', claimRequest: randomUUID() }
    const file = await open(path, 'wx', 0o600).catch(async e => {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const existing = await this.inspect(assignment, attempt)
      throw new Error(`This attempt already has execution state (${existing.record?.phase ?? 'unknown'}, process ${existing.process}). Inspect its original execution; it will not be restarted.`)
    })
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    const dir = await open(this.directory, 'r')
    try { await dir.sync() } finally { await dir.close() }
    return record
  }
  async update(record: ExecutionRecord, phase: ExecutionRecord['phase'], result?: { request: string; event?: string }): Promise<ExecutionRecord> {
    const existing = await this.inspect(record.assignment, record.attempt)
    if (!existing.record || existing.record.executor !== record.executor || existing.record.pid !== process.pid) throw new Error('This process does not own the execution')
    if (['result', 'stopped'].includes(existing.record.phase) && existing.record.phase !== phase) throw new Error('Execution is already terminal')
    const next = { ...existing.record, phase, ...(result ? { resultRequest: result.request, ...(result.event ? { resultEvent: result.event } : {}) } : {}) }
    await atomicPrivateWrite(this.#path(record.assignment, record.attempt), JSON.stringify(next))
    return next
  }
  async records(): Promise<ExecutionRecord[]> {
    const files = await readdir(this.directory).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })
    return Promise.all(files.filter(f => /^[0-9a-f]{64}-[0-9]+\.json$/.test(f)).map(async f => JSON.parse(await readFile(join(this.directory, f), 'utf8')) as ExecutionRecord))
  }
  /** Called only after a principal-approved stopped-execution recovery has
   * been published. It can close uncertainty; it can never restart an attempt. */
  async recoverStopped(record: ExecutionRecord, request: string, event: string): Promise<void> {
    const current = await this.inspect(record.assignment, record.attempt)
    if (current.process !== 'missing' || current.record?.executor !== record.executor || current.record.pid !== record.pid) {
      throw new Error('The original execution process is live, unknown or changed')
    }
    await atomicPrivateWrite(this.#path(record.assignment, record.attempt), JSON.stringify({
      ...current.record, pid: process.pid, phase: 'stopped', resultRequest: request, resultEvent: event,
    }))
  }
}
