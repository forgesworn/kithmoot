import type { Plugin } from 'esbuild'
import type { ConsoleMessage, Page, TestInfo } from '@playwright/test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

// Diagnostic only. Numeric codes prevent arbitrary operation names, frames,
// keys or exceptions from entering the observation stream.
const PREFIX = 'VENNEL_PRIVATE_JOIN_STAGE_V1 '
const PAGE_LIMIT = 4096, HOST_LIMIT = 8192
const stages = ['armed', 'graph-request', 'graph-callback-enter', 'graph-callback-exit',
  'graph-threw', 'graph-rejected', 'graph-run-settled', 'graph-task-enter',
  'graph-task-body-done', 'graph-task-settled', 'g0-cut', 'peer-await-start',
  'peer-await-return', 'peer-delivery-start', 'peer-delivery-end', 'page-overflow']
const operations = ['other', 'session-join', 'epoch-replay', 'epoch-request-start',
  'epoch-request', 'epoch-request-preparation', 'epoch-adoption', 'private-session-preannouncement',
  'private-session-joined-check', 'chat-construction', 'credential-mint', 'credential-preparation',
  'credential-handoff', 'credential-retention', 'descriptor-publication', 'descriptor-preparation',
  'roster-publication', 'roster-preparation', 'roster-acknowledgement', 'credential-lifecycle',
  'before-claim', 'outer-retained', 'native-joined', 'before-publication', 'after-publication',
  'session-handoff', 'preannouncement', 'owner-authentication', 'bootstrap-handoff']
const operationCodes = operations.flatMap(operation => [operation,
  operation + '-task-start', operation + '-task-handoff', operation + '-task-refusal'])
type HostStage = 'observer-start' | 'before-clock-install' | 'after-clock-install' |
  'before-native-unlock' | 'verify-ready' | 'connect-ready' | 'before-native-connect' |
  'member-joined' | 'before-set-system-time' | 'after-set-system-time' |
  'peer-grant-enter' | 'peer-grant-return' | 'page-closed'
const hostStages: HostStage[] = ['observer-start', 'before-clock-install', 'after-clock-install',
  'before-native-unlock', 'verify-ready', 'connect-ready', 'before-native-connect', 'member-joined',
  'before-set-system-time', 'after-set-system-time', 'peer-grant-enter', 'peer-grant-return', 'page-closed']
const hostRecorders = new WeakMap<Page, (stage: HostStage) => void>()

export function recordPrivateJoinHostStage(page: Page, stage: HostStage): void {
  hostRecorders.get(page)?.(stage)
}

// Only insert synchronous markers into existing callbacks and finally blocks.
// In particular, do not add then/catch/finally promises or another retain root.
const graphReplacements: readonly (readonly [string, string])[] = [
  [
    `  #call<T>(job: Job, operation: string, effect: () => T, reuseBoundary = false): Promise<T> {`,
    `  #call<T>(job: Job, operation: string, effect: () => T, reuseBoundary = false): Promise<T> {
    ;(globalThis as any).__privateJoinStage?.('graph-request', operation, job)`,
  ],
  [
    `      const invoke = () => {
        try { return this.#enter(job, operation, () => { this.#restrict(operation); return effect() }, !nested) } catch (error) {`,
    `      const invoke = () => {
        ;(globalThis as any).__privateJoinStage?.('graph-callback-enter', operation, job)
        try {
        try { return this.#enter(job, operation, () => { this.#restrict(operation); return effect() }, !nested) } catch (error) {`,
  ],
  [
    `          throw error
        }
      }
      // An asynchronous body started INSIDE a genuine callback`,
    `          throw error
        }
        } finally { (globalThis as any).__privateJoinStage?.('graph-callback-exit', operation, job) }
      }
      // An asynchronous body started INSIDE a genuine callback`,
  ],
  [
    `      pending = nested ? Promise.resolve(invoke()) : this.#native.run(operation, invoke)
    } catch (error) {`,
    `      pending = nested ? Promise.resolve(invoke()) : this.#native.run(operation, invoke)
    } catch (error) {
      ;(globalThis as any).__privateJoinStage?.('graph-threw', operation, job)`,
  ],
  [
    `    return pending.catch(error => {
      if (!applicationRefusal || applicationRefusal.error !== error) {`,
    `    return pending.catch(error => {
      ;(globalThis as any).__privateJoinStage?.('graph-rejected', operation, job)
      if (!applicationRefusal || applicationRefusal.error !== error) {`,
  ],
  [
    `    const result = pending.finally(() => this.#bodyDone(job))`,
    `    const result = pending.finally(() => {
      this.#bodyDone(job)
      ;(globalThis as any).__privateJoinStage?.('graph-run-settled', operation, job)
    })`,
  ],
  [
    `    try { job = this.#job(parent, lifecycleRoot) } catch (error) { return Promise.reject(error) }
    const result = (async () => {`,
    `    try { job = this.#job(parent, lifecycleRoot) } catch (error) { return Promise.reject(error) }
    ;(globalThis as any).__privateJoinStage?.('graph-task-enter', operation, job)
    const result = (async () => {`,
  ],
  [
    `        if (body) await Promise.allSettled([body])
        this.#bodyDone(job)`,
    `        ;(globalThis as any).__privateJoinStage?.('graph-task-body-done', operation, job)
        if (body) await Promise.allSettled([body])
        this.#bodyDone(job)
        ;(globalThis as any).__privateJoinStage?.('graph-task-settled', operation, job)`,
  ],
]

export const privateJoinStagePlugin: Plugin = {
  name: 'observe-private-join-stages-only',
  setup(builder) {
    builder.onLoad({ filter: /ordinary-protocol-work\.ts$/ }, async input => {
      let source = await readFile(input.path, 'utf8')
      for (const [marker, replacement] of graphReplacements) {
        if (source.split(marker).length !== 2) throw Error('Private join graph observer drift')
        source = source.replace(marker, replacement)
      }
      return { loader: 'ts', contents: source }
    })
  },
}

export async function installPrivateJoinStageObserver(page: Page, info: TestInfo): Promise<void> {
  const output = info.outputPath('private-join-stages-v1.jsonl')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({ schema: 'vennel.private-join-stages.v1', stages, operationCodes,
    hostStages, pageLimit: PAGE_LIMIT, hostLimit: HOST_LIMIT,
    clocks: {
      hostMs: 'Node process performance.now; receive time is later than browser console emission',
      pageWallMs: 'page Date.now; installed Playwright clock may control it',
      pagePerformanceMs: 'page performance.now; installed Playwright clock may control it',
      mapping: 'Match numeric page rows in trace console records to trace recorder monotonic timestamps. Do not equate page, host or trace clocks. Host phase markers bracket awaited Playwright calls only.',
    },
    limits: 'Capture can perturb timing. Missing rows, overflow, invalid rows, write failure or missing close are incomplete evidence. A pass does not establish the historical cause or a fix.',
  }) + '\n', { flag: 'wx' })
  let hostSeq = 0, document = 0, rows = 0, invalid = 0, dropped = 0, writeFailed = false
  const write = (record: object): void => {
    if (writeFailed) return
    try { appendFileSync(output, JSON.stringify(record) + '\n') }
    catch { writeFailed = true; console.error('Private join diagnostic output write failed') }
  }
  const host = (stage: HostStage): void => {
    if (rows >= HOST_LIMIT) { dropped++; return }
    rows++
    write({ hostSeq: ++hostSeq, hostMs: performance.now(), hostStage: hostStages.indexOf(stage) })
  }
  hostRecorders.set(page, host)
  const receive = (message: ConsoleMessage): void => {
    const text = message.text()
    if (!text.startsWith(PREFIX)) return
    if (rows >= HOST_LIMIT) { dropped++; return }
    if (text.length > 256) { invalid++; return }
    let row: unknown
    try { row = JSON.parse(text.slice(PREFIX.length)) } catch { invalid++; return }
    if (!Array.isArray(row) || row.length !== 6 || !row.every(value => typeof value === 'number' && Number.isFinite(value)) ||
        !row.slice(0, 4).every(Number.isSafeInteger) || row[0] < 1 || row[0] > PAGE_LIMIT + 1 ||
        row[1] < 0 || row[1] >= stages.length || row[2] < 0 || row[2] >= operationCodes.length ||
        row[3] < 0 || row[3] > PAGE_LIMIT) { invalid++; return }
    if (row[1] === 0) document++
    rows++
    write({ hostSeq: ++hostSeq, hostMs: performance.now(), document, page: row })
  }
  page.on('console', receive)
  page.once('close', () => {
    host('page-closed')
    // Always attempt a footer even when the bounded row budget is exhausted.
    write({ end: true, hostMs: performance.now(), rows, invalid, dropped, writeFailed })
    page.off('console', receive)
    hostRecorders.delete(page)
  })
  host('observer-start')
  await page.addInitScript(({ prefix, stageNames, opNames, limit }) => {
    const w = window as any, emit = console.debug.bind(console), encode = JSON.stringify.bind(JSON)
    // Read the currently installed page clocks on every marker. Capturing the
    // pre-install functions could silently bypass Playwright's clock instead.
    const wall = () => Date.now(), monotonic = () => performance.now()
    const jobs = new WeakMap<object, number>()
    let seq = 0, nextJob = 0
    w.__privateJoinStage = (stage: string, operation = 'other', job?: object): void => {
      // Observation failure must not replace the original native result/error.
      try {
        if (seq > limit) return
        const stageCode = stageNames.indexOf(stage)
        if (stageCode < 0) return
        if (seq === limit) {
          emit(prefix + encode([++seq, stageNames.indexOf('page-overflow'), 0, 0, wall(), monotonic()]))
          return
        }
        let jobId = 0
        if (job && typeof job === 'object') {
          jobId = jobs.get(job) ?? ++nextJob
          jobs.set(job, jobId)
        }
        emit(prefix + encode([++seq, stageCode, Math.max(0, opNames.indexOf(operation)), jobId, wall(), monotonic()]))
      } catch { /* Diagnostic absence is incomplete evidence, never authority. */ }
    }
    w.__privateJoinStage('armed')
  }, { prefix: PREFIX, stageNames: stages, opNames: operationCodes, limit: PAGE_LIMIT })
}
