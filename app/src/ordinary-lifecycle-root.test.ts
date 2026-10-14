import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { ProtocolTimers } from '../../src/protocol-timers.js'
import { OrdinaryProtocolWork, OrdinaryProtocolSuspended } from './ordinary-protocol-work.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(before: (operation: string) => Promise<void> = async () => {}) {
  let active = false, live = true, stops = 0
  const retained = new Set<Promise<unknown>>(), reads: string[] = []
  const native: ProtocolExecution = {
    run: async (operation, effect) => {
      reads.push(operation); await before(operation)
      if (!live) throw new Error('revoked')
      active = true
      try { return effect() } finally { active = false }
    },
    check: () => { if (!active || !live) throw new Error('not a genuine native callback') },
    retain: pending => { retained.add(pending); void pending.finally(() => retained.delete(pending)).catch(() => {}); return pending },
  }
  const work = new OrdinaryProtocolWork(native, () => { live = false; stops++ })
  return { native, work, reads, retained, stops: () => stops }
}
afterEach(() => vi.useRealTimers())
describe('private lifecycle ownership (synthetic IO, no native acceptance)', () => {
  it('runs a timer as the exact sole root, then admits only fresh scopes', async () => {
    vi.useFakeTimers()
    const f = fixture(), timers = new ProtocolTimers(f.work.execution)
    let result!: Promise<void>, old!: ProtocolExecution
    timers.scheduleRoot('renewal', 10, begin => result = f.work.startRoot(async scope => {
      old = scope
      expect(begin(scope)).toBe(true)
      await f.work.suspend(scope); f.work.checkQuiescent(scope)
      expect(() => f.work.checkTransition(scope)).toThrow(OrdinaryProtocolSuspended)
      await f.native.run('actual transition', () => f.work.enter(scope, 'transition', () => f.work.checkTransition(scope)))
      f.work.resume(scope)
    }))
    await vi.advanceTimersByTimeAsync(10)
    await result; await f.work.join()
    expect(f.reads).toEqual(['credential-lifecycle-task-start', 'actual transition'])
    expect(timers.has('renewal')).toBe(false)
    await expect(old.run('stale', () => {})).rejects.toThrow()
    await f.work.execution.run('fresh', () => {})
    expect(f.stops()).toBe(0); timers.close()
  })
  it('rejects a wrapped root but joins its actual unabortable body', async () => {
    const f = fixture(), gate = deferred(), started = deferred()
    const exact = f.work.startRoot(async () => { started.resolve(); await gate.promise })
    await started.promise
    const wrapped = exact.then(() => {})
    expect(() => f.work.execution.retainRoot!(wrapped)).toThrow(OrdinaryProtocolSuspended)
    let joined = false; const joining = f.work.join().then(() => { joined = true })
    await tick(); expect(joined).toBe(false)
    gate.resolve(); await expect(exact).rejects.toThrow(); await wrapped.catch(() => {}); await joining
    expect(f.stops()).toBe(1)
  })
  it('refuses a root with an already registered child before latching suspension', async () => {
    const f = fixture(), gate = deferred()
    const root = f.work.startRoot(async scope => {
      const child = scope.task!('started child', async () => { await gate.promise })
      await expect(f.work.suspend(scope)).rejects.toThrow(OrdinaryProtocolSuspended)
      expect(f.work.suspended).toBe(false)
      gate.resolve(); await child
    })
    expect(f.work.execution.retainRoot!(root)).toBe(root)
    await root; await f.work.join(); expect(f.stops()).toBe(0)
  })
  it('requires the explicit root and refuses transition inside a run child', async () => {
    const f = fixture()
    await f.work.startRoot(async scope => {
      await f.work.suspend(scope); f.work.checkQuiescent(scope)
      await expect(scope.run('child transition', () => f.work.checkTransition(scope))).rejects.toThrow(OrdinaryProtocolSuspended)
      expect(() => f.work.checkQuiescent({ ...scope })).toThrow(OrdinaryProtocolSuspended)
      f.work.checkQuiescent(scope); f.work.resume(scope)
    })
    await f.work.join(); expect(f.stops()).toBe(0)
    await f.work.execution.task!('ordinary controller', async scope => {
      await f.work.suspend(scope)
      expect(() => f.work.checkQuiescent(scope)).toThrow(OrdinaryProtocolSuspended)
      f.work.resume(scope)
    })
  })
  it.each(['cancel', 'close'] as const)('fences a queued lifecycle start after timer %s', async action => {
    vi.useFakeTimers()
    const selected = deferred()
    const f = fixture(operation => operation === 'credential-lifecycle-task-start' ? selected.promise : Promise.resolve())
    const timers = new ProtocolTimers(f.work.execution)
    let result!: Promise<void>, effects = 0
    timers.scheduleRoot('renewal', 10, begin => result = f.work.startRoot(async scope => {
      if (!begin(scope)) return
      effects++
      await f.work.suspend(scope); f.work.resume(scope)
    }))
    vi.advanceTimersByTime(10)
    if (action === 'cancel') timers.cancel('renewal'); else timers.close()
    selected.resolve(); await result; await f.work.join()
    expect(effects).toBe(0); expect(f.stops()).toBe(0); timers.close()
  })
  it('refuses a nested lifecycle start synchronously without orphaning work', async () => {
    const f = fixture()
    await f.work.execution.run('outer boundary', () => {
      void expect(f.work.startRoot(async () => { throw new Error('must not start') })).rejects.toThrow(OrdinaryProtocolSuspended)
    })
    await f.work.join(); expect(f.stops()).toBe(0)
  })
  it('registers before a queued selector and refuses a concurrent lifecycle root', async () => {
    const selected = deferred()
    const f = fixture(operation => operation === 'credential-lifecycle-task-start' ? selected.promise : Promise.resolve())
    let starts = 0
    const exact = f.work.startRoot(async scope => {
      starts++; await f.work.suspend(scope); f.work.checkQuiescent(scope); f.work.resume(scope)
    })
    expect(f.work.execution.retainRoot!(exact)).toBe(exact)
    await expect(f.work.startRoot(async () => { starts++ })).rejects.toThrow(OrdinaryProtocolSuspended)
    expect(starts).toBe(0)
    selected.resolve(); await exact; await f.work.join()
    expect(starts).toBe(1); expect(f.stops()).toBe(0)
  })
})
