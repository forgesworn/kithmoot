import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { ProtocolTimers } from '../../src/protocol-timers.js'
import { OrdinaryProtocolWork, OrdinaryProtocolSuspended, verifyOrdinaryLifecycleRoot, observeOrdinaryLifecycleEnd } from './ordinary-protocol-work.js'

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
  it('cancels an exact quiescent root resource once on transition without closing the graph',async()=>{
    const f=fixture();let wipes=0
    await f.work.startRoot(async root=>{
      expect(()=>observeOrdinaryLifecycleEnd(root,()=>{})).toThrow(OrdinaryProtocolSuspended)
      await f.work.suspend(root)
      expect(()=>observeOrdinaryLifecycleEnd({...root},()=>{})).toThrow(OrdinaryProtocolSuspended)
      observeOrdinaryLifecycleEnd(root,()=>{wipes++})
      const release=observeOrdinaryLifecycleEnd(root,()=>{throw Error('Unregistered observer')});release();release()
      expect(wipes).toBe(0);f.work.resume(root);expect(wipes).toBe(1)
    })
    await f.work.execution.run('fresh after transition',()=>{})
    expect(wipes).toBe(1);expect(f.stops()).toBe(0)
  })
  it('cancels unconsumed preparation when its root body returns while suspended',async()=>{
    const f=fixture();let wipes=0
    await expect(f.work.startRoot(async root=>{
      await f.work.suspend(root);observeOrdinaryLifecycleEnd(root,()=>{wipes++})
    })).rejects.toThrow(OrdinaryProtocolSuspended)
    await f.work.join();expect(wipes).toBe(1);expect(f.stops()).toBe(1)
  })
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

describe('lower-layer lifecycle ownership verification (synthetic IO only)', () => {
  it('admits only the actual quiescent lifecycle root and refuses replay after resume or terminal completion', async () => {
    const f = fixture(); let held!: ProtocolExecution
    await f.work.startRoot(async scope => {
      held = scope
      expect(() => verifyOrdinaryLifecycleRoot(scope)).toThrow(OrdinaryProtocolSuspended)
      await f.work.suspend(scope)
      expect(verifyOrdinaryLifecycleRoot(scope)).toBeUndefined()
      for (const fake of [{ ...scope }, Object.create(scope), f.work.execution, {}])
        expect(() => verifyOrdinaryLifecycleRoot(fake as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
      f.work.resume(scope)
      expect(() => verifyOrdinaryLifecycleRoot(scope)).toThrow(OrdinaryProtocolSuspended)
    })
    await f.work.join()
    expect(() => verifyOrdinaryLifecycleRoot(held)).toThrow(OrdinaryProtocolSuspended)
    expect(f.stops()).toBe(0)
  })
  it('refuses an ordinary task and a closed lifecycle without exposing an execution capability', async () => {
    const f = fixture()
    await f.work.execution.task!('ordinary', async scope => {
      await f.work.suspend(scope)
      expect(() => verifyOrdinaryLifecycleRoot(scope)).toThrow(OrdinaryProtocolSuspended)
      f.work.resume(scope)
    })
    await f.work.startRoot(async scope => {
      await f.work.suspend(scope); verifyOrdinaryLifecycleRoot(scope); f.work.close()
      expect(() => verifyOrdinaryLifecycleRoot(scope)).toThrow(OrdinaryProtocolSuspended)
    }).catch(() => {})
    await f.work.join()
  })
  it('rejects fabricated accessors without invoking caller code', () => {
    const fake = {}, getter = vi.fn()
    Object.defineProperty(fake,'check',{get:getter})
    expect(() => verifyOrdinaryLifecycleRoot(fake as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('fixed actual-graph controller mechanics (synthetic IO only)', () => {
  it('binds exact executions and refuses forged controls without property access', async () => {
    const api = await import('./ordinary-protocol-work.js'), f = fixture()
    const control = api.ordinaryProtocolControlFor(f.work.execution)
    expect(Object.isFrozen(control)).toBe(true); expect(Reflect.ownKeys(control)).toEqual([])
    let reflections = 0
    const fake = new Proxy({}, {get() {reflections++; throw Error('foreign property')}, getPrototypeOf() {reflections++; throw Error('foreign prototype')}})
    for (const value of [fake, {...f.work.execution}, new Proxy(f.work.execution, {})])
      expect(() => api.ordinaryProtocolControlFor(value as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
    expect(() => api.verifyOrdinaryProtocolLifecycle(fake as typeof control, fake as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
    const component = api.ordinaryProtocolComponentControlFor(f.work.execution)
    expect(() => api.verifyOrdinaryProtocolLifecycle(component as unknown as typeof control, fake as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
    expect(reflections).toBe(0)
  })
  it('refuses other genuine graphs and prepared-startup roots before selecting caller data', async () => {
    const api = await import('./ordinary-protocol-work.js'), f = fixture(), other = fixture()
    const control = api.ordinaryProtocolControlFor(f.work.execution)
    await other.work.startRoot(async root => {
      await other.work.suspend(root); verifyOrdinaryLifecycleRoot(root)
      expect(() => api.verifyOrdinaryProtocolLifecycle(control, root)).toThrow(OrdinaryProtocolSuspended)
      other.work.resume(root)
    })
    const startup = OrdinaryProtocolWork.registerPreparedStartup({}, async root => {
      verifyOrdinaryLifecycleRoot(root)
      expect(() => api.verifyOrdinaryProtocolLifecycle(control, root)).toThrow(OrdinaryProtocolSuspended)
    })
    await startup.start(); await startup.join(); await other.work.join(); await f.work.join()
    expect(f.reads).toEqual([]); expect(f.stops()).toBe(0)
  })
  it('uses private cores through two fresh roots despite replaced public methods and still drains close', async () => {
    const api = await import('./ordinary-protocol-work.js'), f = fixture()
    const control = api.ordinaryProtocolControlFor(f.work.execution), roots: ProtocolExecution[] = []
    const methods = ['enter','own','startRoot','suspend','checkQuiescent','checkTransition','resume','close','join'] as const
    const replacements = methods.map(name => vi.spyOn(OrdinaryProtocolWork.prototype, name).mockImplementation((() => {throw Error('replaceable public method')}) as never))
    try {
      for (let i = 0; i < 2; i++) await api.startOrdinaryProtocolLifecycle(control, async root => {
        roots.push(root); await api.suspendOrdinaryProtocolLifecycle(control, root)
        api.verifyOrdinaryProtocolLifecycle(control, root); verifyOrdinaryLifecycleRoot(root)
        await f.native.run('fixed transition', () => api.enterOrdinaryProtocolLifecycleScope(control, root, 'transition', () => api.verifyOrdinaryProtocolTransition(control, root)))
        api.resumeOrdinaryProtocolLifecycle(control, root)
      })
      expect(roots[0]).not.toBe(roots[1])
      for (const root of roots) expect(() => api.verifyOrdinaryProtocolLifecycle(control, root)).toThrow(OrdinaryProtocolSuspended)
      const held = deferred(), entered = deferred()
      const owned = api.ownOrdinaryProtocolWork(api.ordinaryProtocolComponentControlFor(f.work.execution), async () => {entered.resolve(); await held.promise})
      await entered.promise; api.closeOrdinaryProtocolWork(control)
      let joined = false; const joining = api.joinOrdinaryProtocolWork(control).then(() => {joined = true})
      await tick(); expect(joined).toBe(false); held.resolve(); await owned; await joining
      expect(f.stops()).toBe(1)
      for (const replacement of replacements) expect(replacement).not.toHaveBeenCalled()
    } finally { for (const replacement of replacements) replacement.mockRestore() }
  })
})


it('component controls and their child scopes cannot recover lifecycle controls or inert graph identities', async () => {
  const api = await import('./ordinary-protocol-work.js'), f = fixture()
  const component = api.ordinaryProtocolComponentControlFor(f.work.execution)
  const identity = api.ordinaryProtocolGraphIdentityFor(f.work.execution)
  expect(Object.isFrozen(identity)).toBe(true);expect(Reflect.ownKeys(identity)).toEqual([])
  expect(() => api.ordinaryProtocolControlFor(identity as unknown as ProtocolExecution)).toThrow(OrdinaryProtocolSuspended)
  let starts = 0
  expect(() => api.startOrdinaryProtocolLifecycle(component as unknown as ReturnType<typeof api.ordinaryProtocolControlFor>, async () => {starts++})).toThrow(OrdinaryProtocolSuspended)
  await api.taskOrdinaryProtocolComponent(component, 'component', async scope => {
    expect(() => api.ordinaryProtocolControlFor(scope)).toThrow(OrdinaryProtocolSuspended)
    expect(() => api.ordinaryProtocolGraphIdentityFor(scope)).toThrow(OrdinaryProtocolSuspended)
    await scope.run('fresh component effect', () => {f.reads.push('component effect')})
  })
  expect(starts).toBe(0);await f.work.join()
})


it('component tasks refuse a returned execution instead of releasing it', async () => {
  const api = await import('./ordinary-protocol-work.js'), f = fixture()
  const component = api.ordinaryProtocolComponentControlFor(f.work.execution)
  const leak = (async (scope: ProtocolExecution) => scope) as unknown as (scope: ProtocolExecution) => Promise<void>
  await expect(api.taskOrdinaryProtocolComponent(component, 'refuse execution result', leak)).rejects.toThrow(OrdinaryProtocolSuspended)
  await f.work.join();expect(f.stops()).toBe(0)
})
