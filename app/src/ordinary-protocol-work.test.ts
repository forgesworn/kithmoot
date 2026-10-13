import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { ProtocolTimers } from '../../src/protocol-timers.js'
import { OrdinaryProtocolWork, OrdinaryProtocolSuspended } from './ordinary-protocol-work.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(before: (operation: string) => Promise<void> = async () => {}) {
  let active = false, live = true, stops = 0, postRefusal = false
  const retained = new Set<Promise<unknown>>(), effects: string[] = []
  const reads: string[] = []
  const native: ProtocolExecution = {
    run: async (operation, effect) => {
      reads.push(operation)
      await before(operation)
      if (!live) throw new Error('native source revoked')
      active = true
      try {
        const result = effect()
        if (postRefusal) { live = false; throw new Error('native post-callback refusal') }
        return result
      } finally { active = false }
    },
    check: () => { if (!active || !live) throw new Error('no current native boundary') },
    retain: pending => { retained.add(pending); void pending.finally(() => retained.delete(pending)).catch(() => {}); return pending },
  }
  const graph = new OrdinaryProtocolWork(native, () => { stops++; live = false })
  return { graph, effects, retained, reads, native, stops: () => stops, revoke: () => { live = false }, postRefuse: () => { postRefusal = true } }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers() })
async function renewal(f: ReturnType<typeof fixture>) {
  const ready = deferred(), finish = deferred(), held = deferred()
  let scope!: ProtocolExecution
  const result = f.graph.execution.task!('renewal', async executor => {
    scope = executor; ready.resolve()
    await f.graph.suspend(scope); held.resolve()
    await finish.promise; f.graph.resume(scope)
  })
  await ready.promise
  return { scope, finish, held, result }
}

describe('owned protocol timer suspension (local scheduling, not authority)', () => {
  it('keeps a one-shot deadline and fires once after a pause past that deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const f = fixture(), timers = new ProtocolTimers(f.graph.execution)
    timers.schedule('reply', 100, () => { f.effects.push(String(Date.now())) })
    await vi.advanceTimersByTimeAsync(40)
    const r = await renewal(f); await r.held.promise
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.effects).toEqual([])
    r.finish.resolve(); await r.result
    await vi.advanceTimersByTimeAsync(0)
    expect(f.effects).toEqual(['1040'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.effects).toHaveLength(1)
    timers.close(); await f.graph.join()
  })
  it('coalesces missed periodic ticks and preserves the original cadence', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const f = fixture(), timers = new ProtocolTimers(f.graph.execution)
    timers.schedule('heartbeat', 100, () => { f.effects.push(String(Date.now())) }, 100)
    await vi.advanceTimersByTimeAsync(50)
    const r = await renewal(f); await r.held.promise
    await vi.advanceTimersByTimeAsync(200)
    r.finish.resolve(); await r.result
    await vi.advanceTimersByTimeAsync(0)
    expect(f.effects).toEqual(['250'])
    await vi.advanceTimersByTimeAsync(49); expect(f.effects).toEqual(['250'])
    await vi.advanceTimersByTimeAsync(1); expect(f.effects).toEqual(['250','300'])
    timers.close(); await f.graph.join()
  })
  it('fences a fired callback waiting in the native selector, then retries its original deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const selected = deferred(); let block = true
    const f = fixture(operation => block && operation === 'timer-reply-task-start' ? selected.promise : Promise.resolve())
    const timers = new ProtocolTimers(f.graph.execution)
    timers.schedule('reply', 10, () => { f.effects.push('reply') })
    vi.advanceTimersByTime(10)
    const r = await renewal(f); let drained = false
    void r.held.promise.then(() => { drained = true })
    await tick(); expect(drained).toBe(false)
    block = false; selected.resolve(); await r.held.promise
    expect(f.effects).toEqual([])
    r.finish.resolve(); await r.result
    await vi.advanceTimersByTimeAsync(0)
    expect(f.effects).toEqual(['reply'])
    timers.close(); await f.graph.join()
  })
  it('joins an already started asynchronous timer body and its descendants', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const f = fixture(), timers = new ProtocolTimers(f.graph.execution), body = deferred(), started = deferred()
    timers.schedule('renewal', 10, async scope => {
      started.resolve(); await body.promise
      await scope!.run('timer-continuation', () => { f.effects.push('completed') })
    })
    vi.advanceTimersByTime(10); await started.promise
    const r = await renewal(f); let drained = false
    void r.held.promise.then(() => { drained = true })
    await tick(); expect(drained).toBe(false)
    body.resolve(); await r.held.promise
    expect(f.effects).toEqual(['completed'])
    r.finish.resolve(); await r.result
    timers.close(); await f.graph.join()
  })
  it('keeps cancelled presence stopped after resume and closes without timer effects', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const f = fixture(), timers = new ProtocolTimers(f.graph.execution)
    timers.schedule('heartbeat', 100, () => { f.effects.push('bad') }, 100)
    const r = await renewal(f); await r.held.promise
    timers.cancel('heartbeat'); r.finish.resolve(); await r.result
    await vi.advanceTimersByTimeAsync(1000); expect(f.effects).toEqual([])
    timers.schedule('reply', 10, () => { f.effects.push('bad') })
    f.graph.close(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.effects).toEqual([]); timers.close(); await f.graph.join()
  })
})

describe('owned protocol work graph (ownership only, not native acceptance)', () => {
  it('reuses a nested synchronous start but releases its result only through a fresh handoff read', async () => {
    const f = fixture(), gate = deferred(); let released = false
    const prepared = await f.graph.execution.run('parent boundary', () => {
      const pending = f.graph.execution.task!('nested', async scope => {
        scope.check('nested-start'); await gate.promise; return 'private result'
      })
      void pending.then(() => { released = true })
      return { pending }
    })
    expect(f.reads).toEqual(['parent boundary']); expect(released).toBe(false)
    gate.resolve(); expect(await prepared.pending).toBe('private result')
    expect(f.reads).toEqual(['parent boundary','nested-task-handoff']); await f.graph.join()
  })
  it('closes on a nested post-check refusal and joins its unabortable body without a result', async () => {
    const f = fixture(), gate = deferred(); let child!: Promise<string>, released = false
    const parent = f.graph.execution.run('parent boundary', () => {
      child = f.graph.execution.task!('nested', async scope => {
        scope.check('nested-start'); f.revoke(); await gate.promise; return 'must not escape'
      })
      void child.then(() => { released = true }, () => {})
      return { child }
    })
    await expect(parent).rejects.toThrow(); expect(f.stops()).toBe(1)
    let joined = false; const joining = f.graph.join().then(() => { joined = true })
    await tick(); expect(joined).toBe(false); expect(released).toBe(false)
    gate.resolve(); await expect(child).rejects.toThrow(); await joining
    expect(released).toBe(false); expect(f.reads).toEqual(['parent boundary'])
  })
  it('refuses stale scope retention before touching native lifetimes', async () => {
    const f = fixture(), arbitrary = deferred(); let stale!: ProtocolExecution
    await f.graph.execution.task!('finished', async scope => { stale = scope })
    await tick(); const before = f.retained.size
    expect(() => stale.retain(arbitrary.promise)).toThrow(OrdinaryProtocolSuspended)
    expect(f.retained.has(arbitrary.promise)).toBe(false); expect(f.retained.size).toBe(before)
    await f.graph.join(); arbitrary.resolve()
  })
  it('refuses unregistered root retention at the latch without attaching a native lifetime', async () => {
    const f = fixture(), arbitrary = deferred(), r = await renewal(f)
    await r.held.promise; const before = f.retained.size
    expect(() => f.graph.execution.retain(arbitrary.promise)).toThrow(OrdinaryProtocolSuspended)
    expect(f.retained.has(arbitrary.promise)).toBe(false); expect(f.retained.size).toBe(before)
    r.finish.resolve(); await r.result; await f.graph.join(); arbitrary.resolve()
  })
  for (const outcome of ['return','throw'] as const) it(`closes terminally when the excluded producer ${outcome}s without a transition`, async () => {
    const f = fixture(); let pauses = 0
    f.graph.execution.onSuspend!(paused => { if (paused) pauses++ })
    const work = f.graph.execution.task!('abandoned renewal', async scope => {
      await f.graph.suspend(scope)
      if (outcome === 'throw') throw new Error('abandoned')
    })
    await expect(work).rejects.toThrow(outcome === 'throw' ? 'abandoned' : 'suspended or has finished')
    expect(f.stops()).toBe(1); expect(pauses).toBe(1)
    await expect(f.graph.execution.run('after abandonment', () => f.effects.push('bad'))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    await f.graph.join(); expect(f.effects).toEqual([])
  })
  it('notifies a scoped observer once when suspension is followed by body completion', async () => {
    const f = fixture(), gate = deferred(), ready = deferred(); const notices: boolean[] = []
    const job = f.graph.execution.task!('observed', async scope => {
      scope.onSuspend!(paused => { notices.push(paused) }); ready.resolve(); await gate.promise
    })
    await ready.promise; const r = await renewal(f)
    gate.resolve(); await job; await r.held.promise
    expect(notices).toEqual([true]); r.finish.resolve(); await r.result; await f.graph.join()
  })
  it('drains a detached but registered child after its parent body completed', async () => {
    const f = fixture(), childGate = deferred(), childStarted = deferred()
    let oldParent!: ProtocolExecution, oldChild!: ProtocolExecution
    await f.graph.execution.task!('parent', async scope => {
      oldParent = scope
      void scope.task!('child', async child => {
        oldChild = child; childStarted.resolve(); await childGate.promise
        await child.run('old continuation', () => f.effects.push('old'))
      }).catch(() => {})
    })
    await childStarted.promise
    const r = await renewal(f); let drained = false; void r.held.promise.then(() => { drained = true })
    await tick(); expect(drained).toBe(false)
    await expect(oldParent.run('completed parent', () => f.effects.push('bad'))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    childGate.resolve(); await r.held.promise
    expect(f.effects).toEqual(['old'])
    r.finish.resolve(); await r.result
    await expect(oldChild.run('reused child', () => f.effects.push('bad'))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    await f.graph.execution.run('successor', () => f.effects.push('new'))
    expect(f.effects).toEqual(['old','new']); await f.graph.join()
  })
  it('registers a queued root before its first await and joins its continuation', async () => {
    const f = fixture(), gate = deferred(), ready = deferred()
    const first = f.graph.execution.task!('queued', async scope => { ready.resolve(); await gate.promise; await scope.run('finish', () => f.effects.push('old')) })
    const r = await renewal(f); await ready.promise
    await expect(f.graph.execution.run('late root', () => f.effects.push('bad'))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    gate.resolve(); await first; await r.held.promise; r.finish.resolve(); await r.result
    expect(f.effects).toEqual(['old'])
  })
  it('latches before notifying observers and refuses reentrant new work', async () => {
    const f = fixture(); let refused: Promise<unknown> | undefined
    f.graph.execution.onSuspend!(paused => {
      if (paused) { refused = f.graph.execution.run('observer reentry', () => f.effects.push('bad')); void refused.catch(() => {}) }
    })
    const r = await renewal(f); await r.held.promise
    await expect(refused).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    expect(f.effects).toEqual([]); r.finish.resolve(); await r.result
  })
  it('refuses observer work on resume before permitting fresh later roots', async () => {
    const f = fixture(); let refused: Promise<unknown> | undefined
    f.graph.execution.onSuspend!(paused => {
      if (!paused) { refused = f.graph.execution.run('resume reentry', () => f.effects.push('bad')); void refused.catch(() => {}) }
    })
    const r = await renewal(f); await r.held.promise; r.finish.resolve(); await r.result
    await expect(refused).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    await f.graph.execution.run('fresh root', () => f.effects.push('new')); expect(f.effects).toEqual(['new'])
  })
  it('retaining an already-owned task creates no second self-drain root', async () => {
    const f = fixture(), ready = deferred(), release = deferred(); let scope!: ProtocolExecution
    const work = f.graph.execution.task!('renewal', async child => {
      scope = child; ready.resolve(); await release.promise; await f.graph.suspend(scope); f.graph.resume(scope)
    })
    f.graph.execution.retain(work); await ready.promise; release.resolve(); await work
    expect(f.graph.suspended).toBe(false); await f.graph.join()
  })
  it('rejects clone, proxy, root facade and descendant as the self-drain identity', async () => {
    const f = fixture(), gate = deferred(), ready = deferred(); let scope!: ProtocolExecution
    const root = f.graph.execution.task!('root', async child => {
      scope = child; ready.resolve(); await gate.promise
      await child.task!('descendant', async descendant => { await expect(f.graph.suspend(descendant)).rejects.toBeInstanceOf(OrdinaryProtocolSuspended) })
    })
    await ready.promise
    for (const fake of [{ ...scope }, new Proxy(scope, {}), f.graph.execution]) await expect(f.graph.suspend(fake)).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    expect(f.graph.suspended).toBe(false); gate.resolve(); await root
    await expect(f.graph.suspend(scope)).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
  })
  it('refuses prepared closures after their scope finished and after the latch', async () => {
    const f = fixture(); let prepared!: () => Promise<unknown>
    await f.graph.execution.task!('prepare', async scope => { prepared = () => scope.run('old closure', () => f.effects.push('bad')) })
    await expect(prepared()).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    const r = await renewal(f); await r.held.promise
    await expect(f.graph.execution.task!('caller retry', async scope => scope.run('retry', () => f.effects.push('bad')))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    r.finish.resolve(); await r.result; expect(f.effects).toEqual([])
  })
  it('closes a drain promptly but joins the actual unabortable old body', async () => {
    const f = fixture(), provider = deferred(), ready = deferred()
    const old = f.graph.execution.task!('provider', async scope => { ready.resolve(); await provider.promise; await scope.run('late provider', () => f.effects.push('bad')) })
    void old.catch(() => {}); await ready.promise
    const r = await renewal(f); void r.result.catch(() => {})
    let joined = false; const join = f.graph.join().then(() => { joined = true })
    f.graph.close(); await expect(r.result).rejects.toBeInstanceOf(OrdinaryProtocolSuspended); await tick()
    expect(joined).toBe(false); provider.resolve()
    await expect(old).rejects.toBeInstanceOf(OrdinaryProtocolSuspended); await join
    expect(f.effects).toEqual([]); expect(f.stops()).toBe(1)
  })
  it('times out a stalled drain with no resume or new effects', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(), provider = deferred(), ready = deferred()
      const old = f.graph.execution.task!('stalled', async scope => { ready.resolve(); await provider.promise; await scope.run('late', () => f.effects.push('bad')) })
      void old.catch(() => {}); await ready.promise
      const producer = f.graph.execution.task!('renewal', async scope => { await f.graph.suspend(scope, 20); f.graph.resume(scope) })
      void producer.catch(() => {}); await tick(); await vi.advanceTimersByTimeAsync(21)
      await expect(producer).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
      provider.resolve(); await expect(old).rejects.toBeInstanceOf(OrdinaryProtocolSuspended); await f.graph.join()
      expect(f.graph.suspended).toBe(true); expect(f.effects).toEqual([]); expect(f.stops()).toBe(1)
    } finally { vi.useRealTimers() }
  })
  it('does not orphan a body started before post-callback native refusal', async () => {
    const f = fixture(), provider = deferred(), ready = deferred()
    f.postRefuse()
    const body = f.graph.execution.task!('post-refusal', async scope => { ready.resolve(); await provider.promise; await scope.run('late body', () => f.effects.push('bad')) })
    void body.catch(() => {}); await ready.promise; await tick()
    let joined = false; const join = f.graph.join().then(() => { joined = true }); await tick(); expect(joined).toBe(false)
    provider.resolve(); await expect(body).rejects.toThrow(); await join; expect(f.effects).toEqual([])
  })
  it('requires a native boundary for checks and revalidates asynchronous application refusals', async () => {
    const f = fixture(), refused = new Error('application refused')
    expect(() => f.graph.execution.check('outside')).toThrow(OrdinaryProtocolSuspended)
    await expect(f.graph.execution.task!('application', async () => { throw refused })).rejects.toBe(refused)
    expect(f.graph.suspended).toBe(false)
    f.revoke()
    await expect(f.graph.execution.run('revoked', () => f.effects.push('bad'))).rejects.toThrow('native source revoked')
    expect(f.effects).toEqual([])
  })
  it('a late asynchronous refusal cannot hide changed native custody', async () => {
    const f = fixture(), gate = deferred(), ready = deferred()
    const work = f.graph.execution.task!('application', async () => { ready.resolve(); await gate.promise; throw new Error('application refused') })
    void work.catch(() => {}); await ready.promise; f.revoke(); gate.resolve()
    await expect(work).rejects.toThrow('native source revoked'); expect(f.effects).toEqual([])
  })
  it('disarms a scoped observer when its body finishes', async () => {
    const f = fixture(), observed: boolean[] = []
    await f.graph.execution.task!('short lived', async scope => { scope.onSuspend!(paused => { observed.push(paused) }) })
    expect(observed).toEqual([true])
    const r = await renewal(f); await r.held.promise; r.finish.resolve(); await r.result
    expect(observed).toEqual([true])
  })
  it('an invalid asynchronous suspension observer terminally closes all observers', async () => {
    const f = fixture(); let disarmed = 0
    f.graph.execution.onSuspend!((async () => {}) as unknown as (paused: boolean) => void)
    f.graph.execution.onSuspend!(() => { disarmed++ })
    const work = f.graph.execution.task!('renewal', async scope => { await f.graph.suspend(scope) })
    await expect(work).rejects.toThrow(); expect(f.graph.suspended).toBe(true); expect(disarmed).toBe(1)
  })
  it('cannot resume in the middle of a native effect or while producer children remain', async () => {
    const f = fixture(), ready = deferred(), trigger = deferred(); let root!: ProtocolExecution
    const work = f.graph.execution.task!('renewal', async scope => {
      root = scope; ready.resolve(); await trigger.promise; await f.graph.suspend(scope)
      await scope.run('premature resume', () => { expect(() => f.graph.resume(scope)).toThrow(OrdinaryProtocolSuspended) })
      f.graph.resume(scope)
    })
    await ready.promise; trigger.resolve(); await work
    await expect(root.run('old scope', () => f.effects.push('bad'))).rejects.toBeInstanceOf(OrdinaryProtocolSuspended)
    expect(f.effects).toEqual([])
  })
})
