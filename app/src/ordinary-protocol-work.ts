import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

export class OrdinaryProtocolSuspended extends Error {
  constructor() { super('The owned protocol operation is suspended or has finished.'); this.name = 'OrdinaryProtocolSuspended' }
}
const lifecycleRoots = new WeakMap<object, () => void>()
const lifecyclePromises = new WeakMap<object, (pending: Promise<unknown>) => void>()
const lifecycleEndObservers = new WeakMap<object, (listener: () => void) => () => void>()
const preparedStartupFactories = new WeakSet<object>()
/** Lower-layer ownership check for fixed native lifecycle transitions. The
 * root must be the actual sole quiescent lifecycle root with no children.
 * This grants no native custody, signer, membership or journal authority. */
export function verifyOrdinaryLifecycleRoot(scope: ProtocolExecution): void {
  const verify = lifecycleRoots.get(scope)
  if (!verify) throw new OrdinaryProtocolSuspended()
  verify()
}
/** Ownership of the one retained signing promise only. This supplies no
 * native custody, phase authority or permission to invoke a provider. */
export function verifyOrdinaryLifecyclePromise(scope: ProtocolExecution, pending: Promise<unknown>): void {
  const verify = lifecyclePromises.get(scope)
  if (!verify) throw new OrdinaryProtocolSuspended()
  verify(pending)
}
/** Cancellation only, on the exact quiescent root. The listener runs once
 * synchronously on transition, body completion or graph close. */
export function observeOrdinaryLifecycleEnd(scope: ProtocolExecution, listener: () => void): () => void {
  const observe = lifecycleEndObservers.get(scope)
  if (!observe) throw new OrdinaryProtocolSuspended()
  return observe(listener)
}
/** Graph mechanics only. A genuine resource binds a controller to the exact
 * graph that owns its Session and carrier; it grants no native authority. */
declare const controlBrand: unique symbol
export interface OrdinaryProtocolControl { readonly [controlBrand]: true }
interface Control {
  start(work: (scope: ProtocolExecution) => Promise<void>): Promise<void>
  suspend(scope: ProtocolExecution, timeoutMs?: number): Promise<void>
  check(scope: ProtocolExecution): void
  transition(scope: ProtocolExecution): void
  resume(scope: ProtocolExecution): void
  enter<T>(scope: ProtocolExecution, operation: string, effect: () => T): T
  close(): void
  join(): Promise<void>
}
declare const graphIdentityBrand: unique symbol
export interface OrdinaryProtocolGraphIdentity { readonly [graphIdentityBrand]: true }
const graphIdentities = new WeakMap<object, OrdinaryProtocolGraphIdentity>()
/** Inert identity only. There is deliberately no reverse lookup from it to
 * an execution, graph object or either kind of control. */
export function ordinaryProtocolGraphIdentityFor(execution: ProtocolExecution): OrdinaryProtocolGraphIdentity {
  const identity = graphIdentities.get(execution)
  if (!identity) throw new OrdinaryProtocolSuspended()
  return identity
}
declare const componentControlBrand: unique symbol
export interface OrdinaryProtocolComponentControl { readonly [componentControlBrand]: true }
interface ComponentControl {
  suspended(): boolean
  task(operation: string, work: (scope: ProtocolExecution) => Promise<void>): Promise<void>
  listen(listener: (suspended: boolean) => void): () => void
  enter<T>(scope: ProtocolExecution, operation: string, effect: () => T): T
  own(work: (scope: ProtocolExecution) => Promise<void>): Promise<void>
}
const componentControls = new WeakMap<object, Readonly<ComponentControl>>()
const executionComponentControls = new WeakMap<object, OrdinaryProtocolComponentControl>()
function componentControl(resource: OrdinaryProtocolComponentControl): Readonly<ComponentControl> {
  const value = componentControls.get(resource)
  if (!value) throw new OrdinaryProtocolSuspended()
  return value
}
export function ordinaryProtocolComponentControlFor(execution: ProtocolExecution): OrdinaryProtocolComponentControl {
  const resource = executionComponentControls.get(execution)
  if (!resource) throw new OrdinaryProtocolSuspended()
  return resource
}
const controls = new WeakMap<object, Readonly<Control>>()
const executionControls = new WeakMap<object, OrdinaryProtocolControl>()
function control(resource: OrdinaryProtocolControl): Readonly<Control> {
  const value = controls.get(resource)
  if (!value) throw new OrdinaryProtocolSuspended()
  return value
}
/** Fixed component capture. No property or prototype of a supplied value is
 * read, and copied, proxied and foreign executions cannot select this graph. */
export function ordinaryProtocolControlFor(execution: ProtocolExecution): OrdinaryProtocolControl {
  const resource = executionControls.get(execution)
  if (!resource) throw new OrdinaryProtocolSuspended()
  return resource
}
export function startOrdinaryProtocolLifecycle(resource: OrdinaryProtocolControl, work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
  return control(resource).start(work)
}
export function suspendOrdinaryProtocolLifecycle(resource: OrdinaryProtocolControl, scope: ProtocolExecution): Promise<void> {
  return control(resource).suspend(scope)
}
export function verifyOrdinaryProtocolLifecycle(resource: OrdinaryProtocolControl, scope: ProtocolExecution): void {
  control(resource).check(scope)
}
export function verifyOrdinaryProtocolTransition(resource: OrdinaryProtocolControl, scope: ProtocolExecution): void {
  control(resource).transition(scope)
}
export function resumeOrdinaryProtocolLifecycle(resource: OrdinaryProtocolControl, scope: ProtocolExecution): void {
  control(resource).resume(scope)
}
export function enterOrdinaryProtocolLifecycleScope<T>(resource: OrdinaryProtocolControl, scope: ProtocolExecution, operation: string, effect: () => T): T {
  return control(resource).enter(scope, operation, effect)
}
export function enterOrdinaryProtocolScope<T>(resource: OrdinaryProtocolComponentControl, scope: ProtocolExecution, operation: string, effect: () => T): T {
  return componentControl(resource).enter(scope, operation, effect)
}
export function ownOrdinaryProtocolWork(resource: OrdinaryProtocolComponentControl, work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
  return componentControl(resource).own(work)
}
export function taskOrdinaryProtocolComponent(resource: OrdinaryProtocolComponentControl, operation: string, work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
  return componentControl(resource).task(operation, work)
}
export function ordinaryProtocolComponentSuspended(resource: OrdinaryProtocolComponentControl): boolean { return componentControl(resource).suspended() }
export function observeOrdinaryProtocolComponent(resource: OrdinaryProtocolComponentControl, listener: (suspended: boolean) => void): () => void {
  return componentControl(resource).listen(listener)
}
export function closeOrdinaryProtocolWork(resource: OrdinaryProtocolControl): void { control(resource).close() }
export function joinOrdinaryProtocolWork(resource: OrdinaryProtocolControl): Promise<void> { return control(resource).join() }
interface Job {
  readonly lifecycleRoot: boolean
  readonly resourceOnly: boolean
  readonly generation: number
  readonly parent?: Job
  readonly scope: ProtocolExecution
  readonly children: Set<Job>
  readonly listeners: Set<(suspended: boolean) => void>
  readonly done: Promise<void>
  readonly finish: () => void
  bodyOpen: boolean
  terminal: boolean
  transitioned: boolean
}
type Phase = 'open' | 'quiescing' | 'quiescent' | 'closed'
export const MAX_ORDINARY_PROTOCOL_JOBS = 4096
/** An ownership barrier, never native custody or permission by itself. Every
 * effect still enters the embedding's genuine fresh execution boundary. Only
 * the private factory shares this coordinator with its Session and carrier. */
export class OrdinaryProtocolWork {
  /** @internal One-use ownership entry captured by the private startup
   * factory. No native executor, operation name or mutable writer is supplied.
   * This graph cannot execute or resume ordinary application work. */
  static registerPreparedStartup(factory: object, body: (root: ProtocolExecution) => Promise<void>): Readonly<{
    start(): Promise<void>; close(): void; join(): Promise<void>
  }> {
    if (!factory || preparedStartupFactories.has(factory) || typeof body !== 'function') throw new OrdinaryProtocolSuspended()
    preparedStartupFactories.add(factory)
    const refuse = (): never => { throw new OrdinaryProtocolSuspended() }
    const graph = new OrdinaryProtocolWork({ run: refuse, check: refuse, retain: pending => pending })
    let used = false
    return Object.freeze({
      start: () => {
        if (used) return Promise.reject(new OrdinaryProtocolSuspended())
        used = true
        return graph.#preparedStartupBody(body)
      },
      close: () => graph.#close(), join: () => graph.#join(),
    })
  }
  readonly execution: ProtocolExecution
  readonly #native: ProtocolExecution
  readonly #stop: () => void
  readonly #restrict: (operation: string) => void
  readonly #roots = new Set<Job>()
  readonly #scopes = new WeakMap<object, Job>()
  readonly #promises = new WeakMap<Promise<unknown>, Job>()
  readonly #listeners = new Set<(suspended: boolean) => void>()
  readonly #whenClosed: Promise<void>
  readonly #signalClosed: () => void
  #jobs = 0
  #generation = 0
  #phase: Phase = 'open'
  #active: Job | undefined
  #excluded: Job | undefined
  #notifying = false
  constructor(native: ProtocolExecution, stop: () => void = () => {}, restrict: (operation: string) => void = () => {}) {
    this.#native = native
    this.#stop = stop
    this.#restrict = restrict
    let signal!: () => void
    this.#whenClosed = new Promise<void>(resolve => { signal = resolve })
    this.#signalClosed = signal
    this.execution = Object.freeze({
      run: <T>(operation: string, effect: () => T) => this.#run(this.#active, operation, effect),
      check: (operation: string) => { if (!this.#active) throw new OrdinaryProtocolSuspended(); this.#check(this.#active); this.#nativeCheck(operation) },
      retain: <T>(pending: Promise<T>) => this.#retain(this.#active, pending),
      retainRoot: (pending: Promise<void>) => this.#retainRoot(pending),
      task: <T>(operation: string, work: (scope: ProtocolExecution) => Promise<T>) => this.#task(this.#active, operation, work),
      onSuspend: (listener: (suspended: boolean) => void) => this.#listen(listener),
    })
    const resource = Object.freeze({}) as OrdinaryProtocolControl
    controls.set(resource, Object.freeze({
      start: (work: (scope: ProtocolExecution) => Promise<void>) => this.#startRoot(work),
      suspend: (scope: ProtocolExecution, timeoutMs?: number) => this.#suspend(scope, timeoutMs),
      check: (scope: ProtocolExecution) => this.#checkQuiescent(scope),
      transition: (scope: ProtocolExecution) => this.#checkTransition(scope),
      resume: (scope: ProtocolExecution) => this.#resume(scope),
      enter: <T>(scope: ProtocolExecution, operation: string, effect: () => T) => this.#enterScope(scope, operation, effect),
      close: () => this.#close(), join: () => this.#join(),
    }))
    executionControls.set(this.execution, resource)
    graphIdentities.set(this.execution, Object.freeze({}) as OrdinaryProtocolGraphIdentity)
    const component = Object.freeze({}) as OrdinaryProtocolComponentControl
    componentControls.set(component, Object.freeze({
      suspended: () => this.#phase !== 'open',
      task: (operation: string, work: (scope: ProtocolExecution) => Promise<void>) => this.#task(this.#active, operation, async scope => {
        const value = await work(scope)
        if (value !== undefined) throw new OrdinaryProtocolSuspended()
      }),
      listen: (listener: (suspended: boolean) => void) => this.#listen(listener),
      enter: <T>(scope: ProtocolExecution, operation: string, effect: () => T) => this.#enterScope(scope, operation, effect),
      own: (work: (scope: ProtocolExecution) => Promise<void>) => this.#own(work),
    }))
    executionComponentControls.set(this.execution, component)
  }
  #check(job: Job): void {
    if (this.#phase === 'closed' || job.terminal || !job.bodyOpen || job.generation !== this.#generation) throw new OrdinaryProtocolSuspended()
  }
  #job(parent?: Job, lifecycleRoot = false, resourceOnly = false): Job {
    if (this.#notifying) throw new OrdinaryProtocolSuspended()
    if (parent) this.#check(parent)
    else if (this.#phase !== 'open') throw new OrdinaryProtocolSuspended()
    if (this.#jobs >= MAX_ORDINARY_PROTOCOL_JOBS) throw new OrdinaryProtocolSuspended()
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    // Registration is synchronous, before selectors, callbacks or any await.
    const scope: ProtocolExecution = Object.freeze({
      run: <T>(operation: string, effect: () => T) => this.#run(job, operation, effect),
      check: (operation: string) => {
        this.#check(job)
        if (!this.#active) throw new OrdinaryProtocolSuspended()
        this.#check(this.#active)
        this.#nativeCheck(operation)
      },
      retain: <T>(pending: Promise<T>) => this.#retain(job, pending),
      task: <T>(operation: string, work: (execution: ProtocolExecution) => Promise<T>) => this.#task(job, operation, work),
      onSuspend: (listener: (suspended: boolean) => void) => this.#listen(listener, job),
    })
    const job: Job = { lifecycleRoot, resourceOnly, generation: this.#generation, parent, scope, children: new Set(), listeners: new Set(), done, finish, bodyOpen: true, terminal: false, transitioned: false }
    this.#scopes.set(scope, job)
    if (lifecycleRoot) {
      lifecycleRoots.set(scope, () => this.#checkQuiescent(scope))
      lifecyclePromises.set(scope, pending => this.#checkLifecyclePromise(scope, pending))
      lifecycleEndObservers.set(scope, listener => {
        this.#checkQuiescent(scope)
        if (this.#notifying || typeof listener !== 'function' || this.#listeners.size >= 256) throw new OrdinaryProtocolSuspended()
        let active = true
        const release = () => {active = false; this.#listeners.delete(observe); job.listeners.delete(observe)}
        const observe = () => {
          if (!active) return
          release()
          const result: unknown = listener()
          if (result !== undefined) throw new OrdinaryProtocolSuspended()
        }
        this.#listeners.add(observe); job.listeners.add(observe)
        return release
      })
    }
    this.#jobs++
    if (parent) parent.children.add(job); else this.#roots.add(job)
    return job
  }
  #descendant(job: Job, ancestor: Job): boolean {
    for (let current: Job | undefined = job; current; current = current.parent) if (current === ancestor) return true
    return false
  }
  #complete(job: Job): void {
    // Iterative: a bounded but deep job tree must not overflow the JS stack.
    for (let current: Job | undefined = job; current && !current.terminal && !current.bodyOpen && !current.children.size;) {
      current.terminal = true; lifecycleRoots.delete(current.scope); lifecyclePromises.delete(current.scope); lifecycleEndObservers.delete(current.scope); this.#jobs--
      if (current.parent) current.parent.children.delete(current); else this.#roots.delete(current)
      current.finish(); current = current.parent
    }
  }
  #bodyDone(job: Job): void {
    // A producer owes a terminal transition, including when its callback
    // unexpectedly returns or refuses after acquiring the drain exclusion.
    if (this.#excluded === job && this.#phase !== 'open' && this.#phase !== 'closed') {
      try { this.#close() } catch { /* still finish ownership of its body */ }
    }
    job.bodyOpen = false
    const wasNotifying = this.#notifying
    this.#notifying = true
    try {
      for (const listener of job.listeners) {
        this.#listeners.delete(listener)
        const value: unknown = listener(true)
        if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(value).catch(() => {}); throw new OrdinaryProtocolSuspended()
        }
      }
    } catch (error) {
      try { this.#close() } catch { /* the observer refusal remains the cause */ }
      throw error
    } finally { job.listeners.clear(); this.#notifying = wasNotifying; this.#complete(job) }
  }
  #enter<T>(job: Job, operation: string, effect: () => T, nativeGuarded = false): T {
    this.#check(job)
    const previous = this.#active
    this.#active = job
    try {
      if (!nativeGuarded) this.#nativeCheck(operation)
      let result: T
      try { result = effect() } catch (error) {
        this.#nativeCheck(operation)
        throw error
      }
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
        this.#retain(job, Promise.resolve(result))
        this.#close(); throw new OrdinaryProtocolSuspended()
      }
      // Scope changes cannot weaken the native predicate; validation also
      // runs after an application refusal in the embedding's native executor.
      this.#check(job); if (!nativeGuarded) this.#nativeCheck(operation)
      return result
    } finally { this.#active = previous }
  }
  #nativeCheck(operation: string): void {
    try { this.#native.check(operation) } catch (error) {
      try { this.#close() } catch { /* native refusal remains the cause */ }
      throw error
    }
  }
  /** Reuse another trusted component's genuine paired callback. The native
   * check still requires the embedding's current callback token; entering a
   * scope from ordinary JS cannot manufacture that boundary. */
  enter<T>(scope: ProtocolExecution, operation: string, effect: () => T): T { return this.#enterScope(scope, operation, effect) }
  #enterScope<T>(scope: ProtocolExecution, operation: string, effect: () => T): T {
    const job = this.#scopes.get(scope)
    if (!job) throw new OrdinaryProtocolSuspended()
    return this.#enter(job, operation, effect)
  }
  #call<T>(job: Job, operation: string, effect: () => T, reuseBoundary = false): Promise<T> {
    let applicationRefusal: { error: unknown } | undefined
    let pending: Promise<T>
    try {
      const nested = reuseBoundary && this.#active !== undefined
      const invoke = () => {
        try { return this.#enter(job, operation, () => { this.#restrict(operation); return effect() }, !nested) } catch (error) {
          // Repeat native custody in this SAME callback before distinguishing
          // an application refusal. Storage HOLD is always a native failure.
          this.#check(job); this.#nativeCheck(operation)
          if (!(error instanceof OrdinaryStateHold)) applicationRefusal = { error }
          throw error
        }
      }
      // An asynchronous body started INSIDE a genuine callback already has
      // that callback's exact source image and post-validation. Reuse it for
      // registration/start only; all asynchronous handoffs remain fresh reads.
      pending = nested ? Promise.resolve(invoke()) : this.#native.run(operation, invoke)
    } catch (error) {
      if (!applicationRefusal || applicationRefusal.error !== error) {
        try { this.#close() } catch { /* original boundary refusal remains */ }
      }
      return Promise.reject(error)
    }
    return pending.catch(error => {
      if (!applicationRefusal || applicationRefusal.error !== error) {
        try { this.#close() } catch { /* original boundary refusal remains */ }
      }
      throw error
    })
  }
  /** Register a trusted carrier's whole asynchronous obligation before its
   * first await. This starts NO execution boundary: the body must use run or
   * enter at every effect, and cannot release data. It avoids queueing extra
   * ownership-only reads ahead of incoming network observations. */
  own(work: (scope: ProtocolExecution) => Promise<void>): Promise<void> { return this.#own(work) }
  #own(work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
    let job: Job
    try { job = this.#job(this.#active) } catch (error) { return Promise.reject(error) }
    let body: Promise<void>
    try {
      body = work(job.scope)
      if (!(body instanceof Promise)) throw new OrdinaryProtocolSuspended()
    } catch (error) { this.#bodyDone(job); return Promise.reject(error) }
    this.#native.retain(body)
    const result = body.then(value => {
      if (value !== undefined) { this.#close(); throw new OrdinaryProtocolSuspended() }
    }).finally(() => this.#bodyDone(job))
    this.#promises.set(result, job)
    return this.#native.retain(result)
  }
  #run<T>(parent: Job | undefined, operation: string, effect: () => T): Promise<T> {
    let job: Job
    try { job = this.#job(parent) } catch (error) { return Promise.reject(error) }
    let pending: Promise<T>
    try { pending = this.#call(job, operation, effect) }
    catch (error) { this.#bodyDone(job); return Promise.reject(error) }
    const result = pending.finally(() => this.#bodyDone(job))
    this.#promises.set(result, job)
    return this.#native.retain(result)
  }
  #task<T>(parent: Job | undefined, operation: string, work: (scope: ProtocolExecution) => Promise<T>, lifecycleRoot = false): Promise<T> {
    let job: Job
    try { job = this.#job(parent, lifecycleRoot) } catch (error) { return Promise.reject(error) }
    const result = (async () => {
      let body: Promise<T> | undefined
      let startedBody = false
      try {
        const started = await this.#call(job, operation + '-task-start', () => {
          const pending = work(job.scope)
          if (!(pending instanceof Promise)) throw new OrdinaryProtocolSuspended()
          void pending.catch(() => {})
          body = pending; this.#native.retain(pending)
          return { pending }
        }, true)
        startedBody = true
        const value = await started.pending
        if (job === this.#excluded) { this.#close(); throw new OrdinaryProtocolSuspended() }
        if (job.transitioned && value !== undefined) { this.#close(); throw new OrdinaryProtocolSuspended() }
        if (job.transitioned) return value
        return await this.#run(job, operation + '-task-handoff', () => value)
      } catch (error) {
        if (job === this.#excluded) { try { this.#close() } catch { /* original body refusal remains */ } }
        // A refusal after an asynchronous application job may escape only
        // through a fresh successful native boundary. Custody failures have
        // already closed that boundary and must never be reclassified.
        if (startedBody && !job.transitioned && this.#phase !== 'closed') {
          return await this.#run(job, operation + '-task-refusal', () => { throw error })
        }
        throw error
      } finally {
        // A post-callback native refusal must still join the actual body that
        // already started. It cannot orphan an unabortable provider promise.
        if (body) await Promise.allSettled([body])
        this.#bodyDone(job)
      }
    })()
    this.#promises.set(result, job)
    return this.#native.retain(result)
  }
  #retain<T>(parent: Job | undefined, pending: Promise<T>): Promise<T> {
    if (!(pending instanceof Promise)) throw new OrdinaryProtocolSuspended()
    if (parent) this.#check(parent)
    const owned = this.#promises.get(pending)
    if (owned) {
      if (parent && !this.#descendant(owned, parent)) throw new OrdinaryProtocolSuspended()
      return pending // Never create a second root waiting on the producer.
    }
    if (!parent && this.#phase === 'closed') return this.#native.retain(pending) // cleanup ownership only
    const job = this.#job(parent, false, true)
    this.#promises.set(pending, job)
    // Resource-only child. No executor for it escapes to a continuation.
    void pending.finally(() => this.#bodyDone(job)).catch(() => {})
    try { return this.#native.retain(pending) } catch (error) {
      try { this.#close() } catch { /* original resource refusal remains */ }
      throw error
    }
  }
  #listen(listener: (suspended: boolean) => void, job?: Job): () => void {
    if (job) this.#check(job)
    if (this.#phase !== 'open' || this.#notifying || typeof listener !== 'function' || this.#listeners.size >= 256) throw new OrdinaryProtocolSuspended()
    let wasSuspended = false
    const observe = (suspended: boolean) => {
      if (wasSuspended === suspended) return
      wasSuspended = suspended
      return listener(suspended)
    }
    this.#listeners.add(observe)
    job?.listeners.add(observe)
    return () => { this.#listeners.delete(observe); job?.listeners.delete(observe) }
  }
  /** The private factory invokes this at the outer lifecycle entry, never
   * inside another task that will await it. No operation-name inference or
   * ancestor-derived exclusion is involved. The result must stay exact. */
  startRoot(work: (scope: ProtocolExecution) => Promise<void>): Promise<void> { return this.#startRoot(work) }
  #startRoot(work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
    if (this.#active || this.#notifying || [...this.#roots].some(root => root.lifecycleRoot)) return Promise.reject(new OrdinaryProtocolSuspended())
    return this.#task(undefined, 'credential-lifecycle', work, true)
  }
  #preparedStartupBody(body: (root: ProtocolExecution) => Promise<void>): Promise<void> {
    if (this.#phase !== 'open' || this.#jobs || this.#roots.size || this.#listeners.size || this.#active || this.#notifying) {
      return Promise.reject(new OrdinaryProtocolSuspended())
    }
    const job = this.#job(undefined, true)
    // Establish ownership without invoking an effect boundary or a listener.
    this.#excluded = job; this.#phase = 'quiescent'
    let pending: Promise<void>
    try {
      pending = body(job.scope)
      if (!(pending instanceof Promise)) throw new OrdinaryProtocolSuspended()
      void pending.catch(() => {})
    } catch (error) {
      this.#close(); this.#bodyDone(job); return Promise.reject(error)
    }
    const result = pending.then(value => {
      if (value !== undefined) throw new OrdinaryProtocolSuspended()
    }).finally(() => this.#bodyDone(job))
    this.#promises.set(result, job)
    return this.#native.retain(result)
  }
  #retainRoot(pending: Promise<void>): Promise<void> {
    const job = pending instanceof Promise ? this.#promises.get(pending) : undefined
    if (!job?.lifecycleRoot || job.parent) {
      try { this.#close() } finally {
        // An invalid wrapper may still await a real unabortable root. Join
        // it as cleanup, without registering another awaiting graph root.
        if (pending instanceof Promise) { this.#native.retain(pending); void pending.catch(() => {}) }
      }
      throw new OrdinaryProtocolSuspended()
    }
    return this.#native.retain(pending)
  }
  /** Structural barrier only; this grants no native callback or effects. */
  checkQuiescent(scope: ProtocolExecution): void { this.#checkQuiescent(scope) }
  #checkQuiescent(scope: ProtocolExecution): void {
    const root = this.#scopes.get(scope)
    if (!root?.lifecycleRoot || root.parent || root !== this.#excluded || this.#phase !== 'quiescent' ||
        this.#roots.size !== 1 || root.children.size) throw new OrdinaryProtocolSuspended()
    this.#check(root)
  }
  #checkLifecyclePromise(scope: ProtocolExecution, pending: Promise<unknown>): void {
    const root = this.#scopes.get(scope), child = pending instanceof Promise ? this.#promises.get(pending) : undefined
    if (!root?.lifecycleRoot || root.parent || root !== this.#excluded || this.#phase !== 'quiescent' ||
        this.#roots.size !== 1 || root.children.size !== 1 || !child?.resourceOnly || child.parent !== root ||
        !root.children.has(child) || child.children.size) throw new OrdinaryProtocolSuspended()
    this.#check(root); this.#check(child)
  }
  /** The embedding separately authenticates the successor. Its guard swap
   * and adoption still require this exact root inside the genuine callback,
   * with every child finished. run() would itself create a child. */
  checkTransition(scope: ProtocolExecution): void { this.#checkTransition(scope) }
  #checkTransition(scope: ProtocolExecution): void {
    this.#checkQuiescent(scope)
    const root = this.#scopes.get(scope)!
    if (this.#active !== root) throw new OrdinaryProtocolSuspended()
    this.#nativeCheck('credential-lifecycle-transition')
  }
  #notify(suspended: boolean): void {
    this.#notifying = true
    try {
      for (const listener of [...this.#listeners]) {
        const value: unknown = listener(suspended)
        if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(value).catch(() => {})
          throw new OrdinaryProtocolSuspended()
        }
      }
    } finally { this.#notifying = false }
  }
  /** The exact root scope is the sole self-drain exclusion. Operation names
   * and lookalike objects can never manufacture that exclusion. Latch before
   * synchronously disarming listeners, then join the complete old job graph. */
  suspend(scope: ProtocolExecution, timeoutMs = 30_000): Promise<void> { return this.#suspend(scope, timeoutMs) }
  #suspend(scope: ProtocolExecution, timeoutMs = 30_000): Promise<void> {
    const root = this.#scopes.get(scope)
    if (!root || root.parent || root.children.size || this.#phase !== 'open' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new OrdinaryProtocolSuspended())
    try { this.#check(root) } catch (error) { return Promise.reject(error) }
    this.#phase = 'quiescing'; this.#excluded = root
    try { this.#notify(true) } catch (error) { this.#close(); return Promise.reject(error) }
    return (async () => {
      const timer = setTimeout(() => { try { this.#close() } catch { /* terminal even if cleanup refuses */ } }, timeoutMs)
      try {
        while (true) {
          if (this.#phase === 'closed' || this.#excluded !== root) throw new OrdinaryProtocolSuspended()
          const others = [...this.#roots].filter(job => job !== root)
          if (!others.length) { this.#phase = 'quiescent'; return }
          await Promise.race([Promise.all(others.map(job => job.done)), this.#whenClosed])
        }
      } finally { clearTimeout(timer) }
    })()
  }
  /** The caller owes a fresh unchanged native guard (abort) or an acknowledged
   * successor plus complete Session adoption. This method grants no effects.
   * Old scopes die permanently; resumed work must acquire a new root scope. */
  resume(scope: ProtocolExecution): void { this.#resume(scope) }
  #resume(scope: ProtocolExecution): void {
    const root = this.#scopes.get(scope)
    if (!root || root !== this.#excluded || this.#phase !== 'quiescent' || this.#roots.size !== 1 || root.children.size || this.#active) throw new OrdinaryProtocolSuspended()
    this.#check(root)
    if (!Number.isSafeInteger(this.#generation + 1)) { this.#close(); throw new OrdinaryProtocolSuspended() }
    root.transitioned = true
    this.#generation++; this.#excluded = undefined; this.#phase = 'open'
    try { this.#notify(false) } catch (error) { this.#close(); throw error }
  }
  close(): void { this.#close() }
  #close(): void {
    if (this.#phase === 'closed') return
    this.#phase = 'closed'; this.#excluded = undefined
    this.#signalClosed()
    let failure: unknown
    try { this.#stop() } catch (error) { failure = error }
    for (const listener of [...this.#listeners]) try {
      const pending: unknown = listener(true)
      if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(pending).catch(() => {}); throw new OrdinaryProtocolSuspended()
      }
    } catch (error) { failure ??= error }
    this.#listeners.clear()
    if (failure) throw failure
  }
  join(): Promise<void> { return this.#join() }
  async #join(): Promise<void> {
    while (this.#roots.size) await Promise.all([...this.#roots].map(job => job.done))
  }
  get suspended(): boolean { return this.#phase !== 'open' }
}
