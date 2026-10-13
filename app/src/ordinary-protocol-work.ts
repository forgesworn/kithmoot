import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'

export class OrdinaryProtocolSuspended extends Error {
  constructor() { super('The owned protocol operation is suspended or has finished.'); this.name = 'OrdinaryProtocolSuspended' }
}
interface Job {
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
      task: <T>(operation: string, work: (scope: ProtocolExecution) => Promise<T>) => this.#task(this.#active, operation, work),
      onSuspend: (listener: (suspended: boolean) => void) => this.#listen(listener),
    })
  }
  #check(job: Job): void {
    if (this.#phase === 'closed' || job.terminal || !job.bodyOpen || job.generation !== this.#generation) throw new OrdinaryProtocolSuspended()
  }
  #job(parent?: Job): Job {
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
    const job: Job = { generation: this.#generation, parent, scope, children: new Set(), listeners: new Set(), done, finish, bodyOpen: true, terminal: false, transitioned: false }
    this.#scopes.set(scope, job)
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
      current.terminal = true; this.#jobs--
      if (current.parent) current.parent.children.delete(current); else this.#roots.delete(current)
      current.finish(); current = current.parent
    }
  }
  #bodyDone(job: Job): void {
    // A producer owes a terminal transition, including when its callback
    // unexpectedly returns or refuses after acquiring the drain exclusion.
    if (this.#excluded === job && this.#phase !== 'open' && this.#phase !== 'closed') {
      try { this.close() } catch { /* still finish ownership of its body */ }
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
      try { this.close() } catch { /* the observer refusal remains the cause */ }
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
        this.close(); throw new OrdinaryProtocolSuspended()
      }
      // Scope changes cannot weaken the native predicate; validation also
      // runs after an application refusal in the embedding's native executor.
      this.#check(job); if (!nativeGuarded) this.#nativeCheck(operation)
      return result
    } finally { this.#active = previous }
  }
  #nativeCheck(operation: string): void {
    try { this.#native.check(operation) } catch (error) {
      try { this.close() } catch { /* native refusal remains the cause */ }
      throw error
    }
  }
  /** Reuse another trusted component's genuine paired callback. The native
   * check still requires the embedding's current callback token; entering a
   * scope from ordinary JS cannot manufacture that boundary. */
  enter<T>(scope: ProtocolExecution, operation: string, effect: () => T): T {
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
        try { this.close() } catch { /* original boundary refusal remains */ }
      }
      return Promise.reject(error)
    }
    return pending.catch(error => {
      if (!applicationRefusal || applicationRefusal.error !== error) {
        try { this.close() } catch { /* original boundary refusal remains */ }
      }
      throw error
    })
  }
  /** Register a trusted carrier's whole asynchronous obligation before its
   * first await. This starts NO execution boundary: the body must use run or
   * enter at every effect, and cannot release data. It avoids queueing extra
   * ownership-only reads ahead of incoming network observations. */
  own(work: (scope: ProtocolExecution) => Promise<void>): Promise<void> {
    let job: Job
    try { job = this.#job(this.#active) } catch (error) { return Promise.reject(error) }
    let body: Promise<void>
    try {
      body = work(job.scope)
      if (!(body instanceof Promise)) throw new OrdinaryProtocolSuspended()
    } catch (error) { this.#bodyDone(job); return Promise.reject(error) }
    this.#native.retain(body)
    const result = body.then(value => {
      if (value !== undefined) { this.close(); throw new OrdinaryProtocolSuspended() }
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
  #task<T>(parent: Job | undefined, operation: string, work: (scope: ProtocolExecution) => Promise<T>): Promise<T> {
    let job: Job
    try { job = this.#job(parent) } catch (error) { return Promise.reject(error) }
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
        if (job === this.#excluded) { this.close(); throw new OrdinaryProtocolSuspended() }
        if (job.transitioned && value !== undefined) { this.close(); throw new OrdinaryProtocolSuspended() }
        if (job.transitioned) return value
        return await this.#run(job, operation + '-task-handoff', () => value)
      } catch (error) {
        if (job === this.#excluded) { try { this.close() } catch { /* original body refusal remains */ } }
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
    const job = this.#job(parent)
    this.#promises.set(pending, job)
    // Resource-only child. No executor for it escapes to a continuation.
    void pending.finally(() => this.#bodyDone(job)).catch(() => {})
    try { return this.#native.retain(pending) } catch (error) {
      try { this.close() } catch { /* original resource refusal remains */ }
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
  suspend(scope: ProtocolExecution, timeoutMs = 30_000): Promise<void> {
    const root = this.#scopes.get(scope)
    if (!root || root.parent || this.#phase !== 'open' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new OrdinaryProtocolSuspended())
    try { this.#check(root) } catch (error) { return Promise.reject(error) }
    this.#phase = 'quiescing'; this.#excluded = root
    try { this.#notify(true) } catch (error) { this.close(); return Promise.reject(error) }
    return (async () => {
      const timer = setTimeout(() => { try { this.close() } catch { /* terminal even if cleanup refuses */ } }, timeoutMs)
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
  resume(scope: ProtocolExecution): void {
    const root = this.#scopes.get(scope)
    if (!root || root !== this.#excluded || this.#phase !== 'quiescent' || this.#roots.size !== 1 || root.children.size || this.#active) throw new OrdinaryProtocolSuspended()
    this.#check(root)
    if (!Number.isSafeInteger(this.#generation + 1)) { this.close(); throw new OrdinaryProtocolSuspended() }
    root.transitioned = true
    this.#generation++; this.#excluded = undefined; this.#phase = 'open'
    try { this.#notify(false) } catch (error) { this.close(); throw error }
  }
  close(): void {
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
  async join(): Promise<void> {
    while (this.#roots.size) await Promise.all([...this.#roots].map(job => job.done))
  }
  get suspended(): boolean { return this.#phase !== 'open' }
}
